const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');

const schema = `classification_${randomUUID().replaceAll('-', '')}`;

let client;
let migrate;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Classification schema tests require a local database.');
  }

  ({ migrate } = await import('../scripts/database.mjs'));

  client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await client.query(`SET search_path TO ${schema}`);
  await migrate(client);
});

after(async () => {
  if (!client) return;

  try {
    if (schemaCreated) {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  } finally {
    await client.end();
  }
});

async function fixture() {
  const accountId = randomUUID();
  const channelId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();

  await client.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Classification test account',
  ]);

  await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Classification test channel',
  ]);

  await client.query(
    `
      INSERT INTO youtube_channels(channel_id, youtube_channel_id)
      VALUES($1, $2)
    `,
    [channelId, `channel-${randomUUID()}`],
  );

  await client.query(
    `
      INSERT INTO stream_sessions(id, channel_id, label, source)
      VALUES($1, $2, 'Classification test session', 'YOUTUBE')
    `,
    [sessionId, channelId],
  );

  await client.query(
    `
      INSERT INTO youtube_broadcasts(
        session_id,
        channel_id,
        youtube_broadcast_id,
        live_chat_id
      )
      VALUES($1, $2, $3, $4)
    `,
    [sessionId, channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );

  await client.query(
    `
      INSERT INTO monitoring_runs(
        id,
        channel_id,
        session_id,
        requested_by_account_id,
        credential_account_id
      )
      VALUES($1, $2, $3, $4, $4)
    `,
    [runId, channelId, sessionId, accountId],
  );

  return {
    accountId,
    channelId,
    sessionId,
    runId,
  };
}

async function insertObservation(f, id = randomUUID()) {
  const payload = {
    snippet: {
      type: 'textMessageEvent',
      liveChatId: 'test-live-chat',
      publishedAt: '2026-09-20T00:00:00Z',
    },
    text: 'Test classification message',
  };

  const serialized = JSON.stringify(payload);
  const payloadHash = createHash('sha256').update(serialized).digest('hex');

  await client.query(
    `
      INSERT INTO youtube_chat_observations(
        id,
        channel_id,
        session_id,
        first_observed_run_id,
        external_message_id,
        event_type,
        published_at,
        payload,
        payload_hash
      )
      VALUES(
        $1,
        $2,
        $3,
        $4,
        $5,
        'textMessageEvent',
        clock_timestamp(),
        $6::jsonb,
        $7
      )
    `,
    [id, f.channelId, f.sessionId, f.runId, `message-${id}`, serialized, payloadHash],
  );

  return id;
}

async function insertClassification(
  f,
  observationId,
  {
    classifierVersion = 'rules-1',
    policyVersion = 'policy-1',
    outcome = 'REVIEW',
    category = 'HARASSMENT',
    severity = 2,
    reasonCode = 'DIRECT_INSULT',
    runId = f.runId,
    signals = [
      {
        rule_id: 'test.harassment',
        rule_version: '1',
        category: 'HARASSMENT',
        severity: 2,
      },
    ],
  } = {},
) {
  const id = randomUUID();

  await client.query(
    `
      INSERT INTO youtube_chat_classifications(
        id,
        channel_id,
        session_id,
        observation_id,
        run_id,
        classifier_version,
        policy_version,
        outcome,
        primary_category,
        severity,
        reason_code,
        reason,
        signals
      )
      VALUES(
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13::jsonb
      )
    `,
    [
      id,
      f.channelId,
      f.sessionId,
      observationId,
      runId,
      classifierVersion,
      policyVersion,
      outcome,
      category,
      severity,
      reasonCode,
      'The message requires moderation review.',
      JSON.stringify(signals),
    ],
  );

  return id;
}

test('classification migration can be applied repeatedly', async () => {
  await migrate(client);

  const result = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '010_youtube_chat_classifications.sql',
  ]);

  assert.equal(result.rows.length, 1);
});

test('a review classification can reference its observation and run', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);

  const result = await client.query(
    `
      SELECT outcome, primary_category, severity
      FROM youtube_chat_classifications
      WHERE id = $1
    `,
    [classificationId],
  );

  assert.deepEqual(result.rows[0], {
    outcome: 'REVIEW',
    primary_category: 'HARASSMENT',
    severity: 2,
  });
});

test('the same observation and policy version cannot be classified twice', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);

  await insertClassification(f, observationId);

  await assert.rejects(insertClassification(f, observationId), (error) => error.code === '23505');
});

test('different policy versions can classify the same observation', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);

  await insertClassification(f, observationId, {
    policyVersion: 'policy-1',
  });

  await insertClassification(f, observationId, {
    policyVersion: 'policy-2',
  });

  const result = await client.query(
    `
      SELECT count(*)::int AS count
      FROM youtube_chat_classifications
      WHERE observation_id = $1
    `,
    [observationId],
  );

  assert.equal(result.rows[0].count, 2);
});

test('classification cannot reference an observation from another session', async () => {
  const first = await fixture();
  const second = await fixture();
  const observationId = await insertObservation(second);

  await assert.rejects(
    insertClassification(first, observationId),
    (error) => error.code === '23503',
  );
});

test('classification cannot reference a run from another session', async () => {
  const first = await fixture();
  const second = await fixture();
  const observationId = await insertObservation(first);

  await assert.rejects(
    insertClassification(first, observationId, {
      runId: second.runId,
    }),
    (error) => error.code === '23503',
  );
});

test('ALLOW classifications require the no-match shape', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);

  await assert.rejects(
    insertClassification(f, observationId, {
      outcome: 'ALLOW',
      category: 'HARASSMENT',
      severity: 2,
      reasonCode: 'DIRECT_INSULT',
    }),
    (error) => error.code === '23514',
  );
});

test('signals must be a JSON array', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);

  await assert.rejects(
    client.query(
      `
        INSERT INTO youtube_chat_classifications(
          id,
          channel_id,
          session_id,
          observation_id,
          run_id,
          classifier_version,
          policy_version,
          outcome,
          primary_category,
          severity,
          reason_code,
          reason,
          signals
        )
        VALUES(
          $1, $2, $3, $4, $5,
          'rules-1',
          'policy-invalid',
          'REVIEW',
          'HARASSMENT',
          2,
          'DIRECT_INSULT',
          'Invalid signals test',
          '{}'::jsonb
        )
      `,
      [randomUUID(), f.channelId, f.sessionId, observationId, f.runId],
    ),
    (error) => error.code === '23514',
  );
});

test('classification records are immutable', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);

  await assert.rejects(
    client.query(
      `
        UPDATE youtube_chat_classifications
        SET reason = 'Changed result'
        WHERE id = $1
      `,
      [classificationId],
    ),
    (error) => error.code === '23514',
  );
});
