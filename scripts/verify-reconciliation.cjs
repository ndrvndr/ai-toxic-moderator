const { randomUUID, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');

const label = '[LOCAL FIXTURE] Moderation reconciliation';

function localUrl(name) {
  const value = process.env[name];

  if (!value) throw new Error(`${name} is required.`);

  const url = new URL(value);

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('A local PostgreSQL database is required.');
  }

  return value;
}

function validateId(value) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('A valid UUID argument is required.');
  }
}

async function seed(sourceAttemptId) {
  const client = new Client({
    connectionString: localUrl('MIGRATION_DATABASE_URL'),
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();
    await client.query('BEGIN');

    const source = await client.query(
      `
        SELECT e.channel_id, r.credential_account_id AS account_id
        FROM youtube_ban_attempts a
        JOIN youtube_ban_executions e ON e.id = a.execution_id
        JOIN youtube_moderation_action_plans p ON p.id = e.plan_id
        JOIN youtube_chat_classifications c ON c.id = p.classification_id
        JOIN monitoring_runs r ON r.id = c.run_id
        WHERE a.id = $1
          AND EXISTS (
            SELECT 1 FROM channel_memberships m
            WHERE m.channel_id = e.channel_id
              AND m.account_id = r.credential_account_id
              AND m.role IN ('OWNER', 'MODERATOR')
          )
      `,
      [sourceAttemptId],
    );

    const original = source.rows[0];
    if (!original) throw new Error('An accessible source attempt is required.');

    const channelId = original.channel_id;
    const accountId = original.account_id;
    const sessionId = randomUUID();
    const runId = randomUUID();
    const messageId = randomUUID();
    const classificationId = randomUUID();
    const planId = randomUUID();
    const executionId = randomUUID();
    const attemptId = randomUUID();
    const broadcastId = `local-reconciliation-${sessionId}`;
    const liveChatId = `local-chat-${sessionId}`;
    const moderatorId = `UC${'a'.repeat(22)}`;
    const targetId = `UC${'b'.repeat(22)}`;

    const start = Date.now() - 60_000;
    const iso = (offset) => new Date(start + offset).toISOString();

    await client.query(
      `
        INSERT INTO stream_sessions(
          id, channel_id, label, source, closed_at
        )
        VALUES($1, $2, $3, 'YOUTUBE', clock_timestamp())
      `,
      [sessionId, channelId, label],
    );

    await client.query(
      `
        INSERT INTO youtube_broadcasts(
          session_id, channel_id, youtube_broadcast_id, live_chat_id
        )
        VALUES($1, $2, $3, $4)
      `,
      [sessionId, channelId, broadcastId, liveChatId],
    );

    await client.query(
      `
        INSERT INTO monitoring_runs(
          id, channel_id, session_id,
          requested_by_account_id, credential_account_id,
          status, requested_at, started_at, finished_at
        )
        VALUES($1, $2, $3, $4, $4, 'STOPPED', $5, $5, $6)
      `,
      [runId, channelId, sessionId, accountId, iso(-1000), iso(30000)],
    );

    async function observation(id, type, publishedAt, snippet, author) {
      const externalId = `local-event-${id}`;
      const payload = {
        id: externalId,
        snippet: {
          type,
          liveChatId,
          publishedAt,
          ...snippet,
        },
        authorDetails: author,
      };
      const serialized = JSON.stringify(payload);

      await client.query(
        `
          INSERT INTO youtube_chat_observations(
            id, channel_id, session_id, first_observed_run_id,
            external_message_id, event_type, published_at,
            payload, payload_hash
          )
          VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        `,
        [
          id,
          channelId,
          sessionId,
          runId,
          externalId,
          type,
          publishedAt,
          serialized,
          createHash('sha256').update(serialized).digest('hex'),
        ],
      );
    }

    await observation(
      messageId,
      'textMessageEvent',
      iso(-500),
      {
        authorChannelId: targetId,
        textMessageDetails: {
          messageText: 'LOCAL FIXTURE: unknown timeout with matching evidence',
        },
      },
      {
        channelId: targetId,
        displayName: 'Local fixture viewer',
      },
    );

    await client.query(
      `
        INSERT INTO youtube_chat_classifications(
          id, channel_id, session_id, observation_id, run_id,
          classifier_version, policy_version, outcome,
          primary_category, severity, reason_code, reason, signals
        )
        VALUES(
          $1, $2, $3, $4, $5,
          'local-fixture', 'local-fixture', 'REVIEW',
          'SPAM', 1, 'CONTEXT_REQUIRED',
          'Local fixture only. No real moderation request was sent.',
          '[]'::jsonb
        )
      `,
      [classificationId, channelId, sessionId, messageId, runId],
    );

    await client.query(
      `
        INSERT INTO youtube_moderation_action_plans(
          id, channel_id, session_id, classification_id,
          policy_version, action, duration_seconds, reason
        )
        VALUES(
          $1, $2, $3, $4, 'local-fixture', 'TIMEOUT', 30,
          'Local browser verification fixture.'
        )
      `,
      [planId, channelId, sessionId, classificationId],
    );

    await client.query(
      `
        INSERT INTO youtube_ban_executions(
          id, plan_id, channel_id, session_id,
          live_chat_id, author_channel_id, action, duration_seconds
        )
        VALUES($1, $2, $3, $4, $5, $6, 'TIMEOUT', 30)
      `,
      [executionId, planId, channelId, sessionId, liveChatId, targetId],
    );

    await client.query(
      `
        INSERT INTO youtube_ban_attempts(
          id, execution_id, owner_id, started_at, deadline_at,
          credential_account_id, moderator_channel_id
        )
        VALUES($1, $2, $3, $4, $5, $6, $7)
      `,
      [attemptId, executionId, randomUUID(), iso(0), iso(30000), accountId, moderatorId],
    );

    await client.query(
      `
        UPDATE youtube_ban_attempts
        SET status = 'UNKNOWN',
            finished_at = $2,
            error_code = 'LOCAL_FIXTURE'
        WHERE id = $1
      `,
      [attemptId, iso(2000)],
    );

    await observation(
      randomUUID(),
      'userBannedEvent',
      iso(1000),
      {
        authorChannelId: moderatorId,
        userBannedDetails: {
          banType: 'temporary',
          banDurationSeconds: '30',
          bannedUserDetails: { channelId: targetId },
        },
      },
      {
        channelId: moderatorId,
        displayName: 'Local fixture moderator',
      },
    );

    await client.query('COMMIT');

    console.table([{ session_id: sessionId, attempt_id: attemptId, label }]);
    console.log(
      `node --env-file-if-exists=.env scripts/verify-reconciliation.cjs collect ${sessionId}`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function collect(sessionId) {
  // Development-only source loader; no provider adapter is invoked.
  const { source } = require('../tests/helpers/source.cjs');
  const { BanEvidenceReader } = source('apps/worker/src/ingestion/ban-evidence-reader.ts');
  const { BanEvidenceStore } = source('apps/worker/src/ingestion/ban-evidence-store.ts');

  const pool = new Pool({
    connectionString: localUrl('WORKER_DATABASE_URL'),
    connectionTimeoutMillis: 3000,
    max: 2,
  });

  try {
    const candidates = await pool.query(
      `
        SELECT a.id
        FROM youtube_ban_attempts a
        JOIN youtube_ban_executions e ON e.id = a.execution_id
        JOIN stream_sessions s
          ON s.id = e.session_id AND s.channel_id = e.channel_id
        JOIN youtube_broadcasts b
          ON b.session_id = s.id AND b.channel_id = s.channel_id
        WHERE s.id = $1
          AND s.label = $2
          AND s.closed_at IS NOT NULL
          AND b.youtube_broadcast_id = 'local-reconciliation-' || s.id::text
          AND a.status = 'UNKNOWN'
          AND a.error_code = 'LOCAL_FIXTURE'
      `,
      [sessionId, label],
    );

    if (candidates.rows.length !== 1) {
      throw new Error('Exactly one local fixture attempt is required.');
    }

    const attemptId = candidates.rows[0].id;
    const reader = new BanEvidenceReader(pool);
    const store = new BanEvidenceStore(pool);
    const page = await reader.read(attemptId);

    if (!page || page.nextCursor !== null || page.matches.length !== 1) {
      throw new Error('Expected exactly one matching fixture observation.');
    }

    const result = await store.save(attemptId, page.matches[0].observationId);

    console.log({ result, request_outcome: 'UNKNOWN' });
  } finally {
    await pool.end();
  }
}

async function main() {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? 'development')) {
    throw new Error('This script is restricted to development and test.');
  }

  const [command, id] = process.argv.slice(2);
  validateId(id);

  if (command === 'seed') return seed(id);
  if (command === 'collect') return collect(id);

  throw new Error('Use seed <source-attempt-id> or collect <fixture-session-id>.');
}

main().catch((error) => {
  const safeMessages = new Set([
    'MIGRATION_DATABASE_URL is required.',
    'WORKER_DATABASE_URL is required.',
    'A local PostgreSQL database is required.',
    'A valid UUID argument is required.',
    'An accessible source attempt is required.',
    'Exactly one local fixture attempt is required.',
    'Expected exactly one matching fixture observation.',
    'This script is restricted to development and test.',
    'Use seed <source-attempt-id> or collect <fixture-session-id>.',
  ]);

  console.error('Local verification failed.', {
    name: error.name,
    code: error.code ?? 'VERIFICATION_FAILED',
    message: safeMessages.has(error.message)
      ? error.message
      : 'Unexpected error; connection details are hidden.',
    migration_url_configured: Boolean(process.env.MIGRATION_DATABASE_URL),
    worker_url_configured: Boolean(process.env.WORKER_DATABASE_URL),
    node_env: process.env.NODE_ENV ?? '(default: development)',
  });

  process.exitCode = 1;
});
