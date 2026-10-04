import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { loadConfig } from '@moderator/config';
import { createPool } from '@moderator/persistence';
import {
  GoogleProvider,
  GoogleTokenStore,
  YoutubeActorAdapter,
  YoutubeBanAdapter,
  YoutubeChatAdapter,
  YoutubeModerationAdapter,
} from '@moderator/provider-adapters';

import { ActorResolver } from './ingestion/actor-resolver';
import {
  createAiActionDecisionCycle,
  type AiActionDecisionCycle,
} from './ingestion/ai-action-decision-cycle';
import { createAiShadowCycle, type AiShadowCycle } from './ingestion/ai-shadow-cycle';
import { BanCandidateStore } from './ingestion/ban-candidate-store';
import { BanCoordinator } from './ingestion/ban-coordinator';
import { BanEligibilityStore } from './ingestion/ban-eligibility-store';
import { BanEvidenceCoordinator } from './ingestion/ban-evidence-coordinator';
import { BanEvidenceReader } from './ingestion/ban-evidence-reader';
import { BanEvidenceStore } from './ingestion/ban-evidence-store';
import { BanExecutionStore } from './ingestion/ban-execution-store';
import { BanExecutor } from './ingestion/ban-executor';
import { BanRecovery } from './ingestion/ban-recovery';
import { BatchWriter } from './ingestion/batch-writer';
import { ControlledBanScope, controlledBanVersion } from './ingestion/controlled-ban-policy';
import { controlledDeleteVersion } from './ingestion/controlled-delete-policy';
import { IngestionCoordinator } from './ingestion/coordinator';
import { createClassificationStore } from './ingestion/create-classification-store';
import { DeleteCandidateStore } from './ingestion/delete-candidate-store';
import { DeleteCoordinator } from './ingestion/delete-coordinator';
import { DeleteEligibilityStore } from './ingestion/delete-eligibility-store';
import { DeleteExecutionStore } from './ingestion/delete-execution-store';
import { DeleteExecutor } from './ingestion/delete-executor';
import { DeleteRecovery } from './ingestion/delete-recovery';
import { LeaseStore } from './ingestion/lease-store';
import { PollCycle } from './ingestion/poll-cycle';
import { RetryStore } from './ingestion/retry-store';
import { WorkerRuntime } from './ingestion/worker-runtime';

async function bootstrap() {
  const baseConfig = loadConfig();

  if (!baseConfig.WORKER_ENABLED) {
    console.log('YouTube ingestion worker is disabled.');
    return;
  }

  if (!baseConfig.GOOGLE_AUTH_ENABLED) {
    throw new Error('Google authentication must be enabled for ingestion.');
  }

  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.WORKER_DATABASE_URL ?? '',
  });

  const pool = createPool(config.DATABASE_URL);
  let runtime: WorkerRuntime | undefined;
  let shadow: AiShadowCycle | undefined;
  let aiDecisions: AiActionDecisionCycle | undefined;

  try {
    const role = await pool.query<{
      marker: string | null;
      privileged: boolean;
    }>(
      `
        SELECT
          shobj_description(oid, 'pg_authid') AS marker,
          (
            rolsuper OR rolcreatedb OR rolcreaterole
            OR rolreplication OR rolbypassrls
          ) AS privileged
        FROM pg_roles
        WHERE rolname = current_user
      `,
    );

    if (
      role.rows[0]?.marker !== 'AI Toxic Moderator development worker' ||
      role.rows[0].privileged
    ) {
      throw new Error('A managed, unprivileged worker role is required.');
    }

    await pool.query('SELECT revision, chat_ended_at FROM youtube_chat_checkpoints LIMIT 0');
    await pool.query('SELECT id FROM youtube_chat_classifications LIMIT 0');
    await pool.query('SELECT id FROM youtube_moderation_action_plans LIMIT 0');
    await pool.query(`SELECT run_id, settings_id, settings_revision, source, configuration
      FROM monitoring_settings_snapshots LIMIT 0`);
    await pool.query('SELECT id, status, deadline_at FROM youtube_delete_attempts LIMIT 0');
    await pool.query('SELECT id FROM youtube_ban_executions LIMIT 0');
    await pool.query(`
  SELECT
    id,
    status,
    deadline_at,
    ban_id,
    credential_account_id,
    moderator_channel_id
  FROM youtube_ban_attempts
  LIMIT 0
`);

    await pool.query(`
  SELECT
    id,
    status,
    deadline_at,
    ban_id,
    credential_account_id,
    moderator_channel_id
  FROM youtube_ban_attempts
  LIMIT 0
`);

    await pool.query(`
  SELECT attempt_id, observation_id, attribution
  FROM youtube_ban_evidence
  LIMIT 0
`);

    const leases = new LeaseStore(pool);
    const testScope =
      config.YOUTUBE_DELETE_ENABLED && config.YOUTUBE_DELETE_TEST_SESSION_ID
        ? {
            sessionId: config.YOUTUBE_DELETE_TEST_SESSION_ID,
            authorChannelId: config.YOUTUBE_DELETE_TEST_AUTHOR_ID,
          }
        : undefined;
    const banTestScope: ControlledBanScope | undefined =
      config.YOUTUBE_BAN_ENABLED &&
      config.YOUTUBE_BAN_TEST_SESSION_ID &&
      config.YOUTUBE_BAN_TEST_AUTHOR_ID &&
      config.YOUTUBE_BAN_TEST_ACTION
        ? {
            sessionId: config.YOUTUBE_BAN_TEST_SESSION_ID,
            authorChannelId: config.YOUTUBE_BAN_TEST_AUTHOR_ID,
            action: config.YOUTUBE_BAN_TEST_ACTION,
          }
        : undefined;

    const classifications = createClassificationStore(undefined, testScope, banTestScope);
    const writer = new BatchWriter(leases, classifications);
    const tokens = new GoogleTokenStore(pool, config, new GoogleProvider());
    const cycle = new PollCycle(leases, writer, tokens, new YoutubeChatAdapter());

    const coordinator = new IngestionCoordinator(pool, leases, cycle, new RetryStore(leases));
    const executions = new DeleteExecutionStore(pool);
    const recovery = new DeleteRecovery(executions);

    let deletions: DeleteCoordinator | undefined;
    if (config.YOUTUBE_DELETE_ENABLED) {
      await pool.query('SELECT id FROM youtube_delete_executions LIMIT 0');
      await pool.query('SELECT account_id, role FROM channel_memberships LIMIT 0');
      await pool.query('SELECT id, closed_at FROM stream_sessions LIMIT 0');
      const enabled = () =>
        config.WORKER_ENABLED && config.GOOGLE_AUTH_ENABLED && config.YOUTUBE_DELETE_ENABLED;
      const executor = new DeleteExecutor(
        executions,
        new DeleteEligibilityStore(
          pool,
          enabled,
          testScope ? controlledDeleteVersion(testScope) : null,
        ),
        tokens,
        new YoutubeModerationAdapter(),
      );
      deletions = new DeleteCoordinator(new DeleteCandidateStore(pool), executor, enabled);
    }

    const banExecutions = new BanExecutionStore(pool);
    const banRecovery = new BanRecovery(banExecutions);

    let bans: BanCoordinator | undefined;

    if (config.YOUTUBE_BAN_ENABLED) {
      await pool.query('SELECT account_id, role FROM channel_memberships LIMIT 0');
      await pool.query('SELECT id, closed_at FROM stream_sessions LIMIT 0');

      const enabled = () =>
        config.WORKER_ENABLED && config.GOOGLE_AUTH_ENABLED && config.YOUTUBE_BAN_ENABLED;

      const banExecutor = new BanExecutor(
        banExecutions,
        new BanEligibilityStore(
          pool,
          enabled,
          banTestScope ? controlledBanVersion(banTestScope) : null,
        ),
        tokens,
        new YoutubeBanAdapter(fetch, (diagnostic) => {
          console.warn('YouTube ban response validation failed.', diagnostic);
        }),
        new ActorResolver(new YoutubeActorAdapter()),
      );

      bans = new BanCoordinator(new BanCandidateStore(pool), banExecutor, enabled);
    }

    if (config.AI_SHADOW_ENABLED) {
      try {
        await pool.query(`SELECT id, observation_id, model_revision, status
          FROM youtube_ai_shadow_results LIMIT 0`);
        await pool.query(`SELECT id, observation_id, classification_id, model_result_id, decision
          FROM youtube_ai_action_decisions LIMIT 0`);
        await pool.query(`SELECT run_id, channel_id, source, configuration
          FROM monitoring_ai_settings_snapshots LIMIT 0`);
        const selectedRun = await pool.query('SELECT id FROM monitoring_runs WHERE id=$1', [
          config.AI_SHADOW_RUN_ID,
        ]);
        if (!selectedRun.rows[0]) throw new Error('AI shadow run does not exist.');
        shadow = createAiShadowCycle(config, pool);
        aiDecisions = createAiActionDecisionCycle(config, pool);
        console.log(
          'AI shadow and decision audit are enabled for the configured run. AI actions are not dispatched.',
        );
      } catch {
        console.error(
          'AI shadow initialization failed. Check its run, migrations, and worker permissions. Ingestion continues.',
        );
      }
    }

    runtime = new WorkerRuntime(
      coordinator,
      pool,
      deletions,
      recovery,
      {
        dispatch: bans,
        recovery: banRecovery,
        evidence: new BanEvidenceCoordinator(
          new BanEvidenceReader(pool),
          new BanEvidenceStore(pool),
        ),
      },
      shadow,
      aiDecisions,
    );

    @Module({
      providers: [{ provide: WorkerRuntime, useValue: runtime }],
    })
    class WorkerModule {}

    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });

    app.enableShutdownHooks();

    runtime.start();
    console.log('YouTube ingestion worker started.');
  } catch (error) {
    if (runtime) await runtime.onApplicationShutdown();
    else {
      try {
        await shadow?.dispose();
      } finally {
        await pool.end();
      }
    }

    throw error;
  }
}

bootstrap().catch(() => {
  console.error(
    'Worker startup failed. Check Google configuration, WORKER_DATABASE_URL, runtime role, and migrations.',
  );
  process.exitCode = 1;
});
