import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { loadConfig } from '@moderator/config';
import { createPool } from '@moderator/persistence';
import {
  GoogleProvider,
  GoogleTokenStore,
  YoutubeChatAdapter,
  YoutubeModerationAdapter,
} from '@moderator/provider-adapters';

import { BatchWriter } from './ingestion/batch-writer';
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
    await pool.query('SELECT id, status, deadline_at FROM youtube_delete_attempts LIMIT 0');

    const leases = new LeaseStore(pool);
    const classifications = createClassificationStore();
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
        new DeleteEligibilityStore(pool, enabled),
        tokens,
        new YoutubeModerationAdapter(),
      );
      deletions = new DeleteCoordinator(new DeleteCandidateStore(pool), executor, enabled);
    }

    runtime = new WorkerRuntime(coordinator, pool, deletions, recovery);

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
    else await pool.end();

    throw error;
  }
}

bootstrap().catch(() => {
  console.error(
    'Worker startup failed. Check Google configuration, WORKER_DATABASE_URL, runtime role, and migrations.',
  );
  process.exitCode = 1;
});
