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

async function deleteFixture(action = 'DELETE') {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);
  const planId = await insertActionPlan(f, classificationId, { action });
  return {
    ...f,
    observationId,
    classificationId,
    planId,
    externalMessageId: `message-${observationId}`,
  };
}

async function insertExecution(f, overrides = {}) {
  const row = { ...f, ...overrides };
  const id = randomUUID();
  await client.query(
    `INSERT INTO youtube_delete_executions(id, plan_id, channel_id, session_id, external_message_id)
     VALUES($1, $2, $3, $4, $5)`,
    [id, row.planId, row.channelId, row.sessionId, row.externalMessageId],
  );
  return id;
}

async function insertAttempt(executionId, attemptNumber = 1) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO youtube_delete_attempts(id, execution_id, attempt_number, owner_id, started_at, deadline_at)
     VALUES($1, $2, $3, $4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z')`,
    [id, executionId, attemptNumber, randomUUID()],
  );
  return id;
}

async function finishAttempt(id, status, httpStatus, errorCode) {
  await client.query(
    `UPDATE youtube_delete_attempts
     SET status = $2, http_status = $3, error_code = $4, finished_at = '2026-01-01T00:00:10Z'
     WHERE id = $1`,
    [id, status, httpStatus, errorCode],
  );
}

test('deletion execution requires a DELETE plan and its original target', async () => {
  const f = await deleteFixture();
  await insertExecution(f);
  for (const override of [
    { externalMessageId: 'substituted-message' },
    { channelId: randomUUID() },
    { sessionId: randomUUID() },
  ]) {
    await assert.rejects(insertExecution(f, override), (error) => error.code === '23514');
  }
  const noAction = await deleteFixture('NONE');
  await assert.rejects(insertExecution(noAction), (error) => error.code === '23514');
});

test('policy version changes cannot create a second deletion execution for the same message', async () => {
  const f = await deleteFixture();
  await insertExecution(f);
  const anotherPlan = await insertActionPlan(f, f.classificationId, { policyVersion: 'actions-2' });
  await assert.rejects(
    insertExecution(f, { planId: anotherPlan }),
    (error) => error.code === '23505',
  );
});

test('execution identity is immutable', async () => {
  const f = await deleteFixture();
  const id = await insertExecution(f);
  await assert.rejects(
    client.query('UPDATE youtube_delete_executions SET external_message_id = $2 WHERE id = $1', [
      id,
      'another-message',
    ]),
    (error) => error.code === '23514',
  );
});

test('a dispatched or unknown attempt blocks another dispatch', async () => {
  const f = await deleteFixture();
  const executionId = await insertExecution(f);
  const attemptId = await insertAttempt(executionId);
  await assert.rejects(insertAttempt(executionId, 2), (error) => error.code === '23514');
  await finishAttempt(attemptId, 'UNKNOWN', null, 'REQUEST_INTERRUPTED');
  await assert.rejects(insertAttempt(executionId, 2), (error) => error.code === '23514');
});

test('success requires HTTP 204 and blocks further attempts', async () => {
  const executionId = await insertExecution(await deleteFixture());
  const attemptId = await insertAttempt(executionId);
  for (const status of [null, 200, 404]) {
    await assert.rejects(
      finishAttempt(attemptId, 'SUCCEEDED', status, null),
      (error) => error.code === '23514',
    );
  }
  await finishAttempt(attemptId, 'SUCCEEDED', 204, null);
  await assert.rejects(insertAttempt(executionId, 2), (error) => error.code === '23514');
  await assert.rejects(
    finishAttempt(attemptId, 'UNKNOWN', null, 'REQUEST_INTERRUPTED'),
    (error) => error.code === '23514',
  );
});

test('a known rejection permits a separate sequential attempt without rewriting history', async () => {
  const executionId = await insertExecution(await deleteFixture());
  const first = await insertAttempt(executionId);
  await finishAttempt(first, 'REJECTED', 429, 'YOUTUBE_RATE_LIMITED');
  await assert.rejects(insertAttempt(executionId, 3), (error) => error.code === '23514');
  await insertAttempt(executionId, 2);
  const result = await client.query(
    'SELECT attempt_number, status FROM youtube_delete_attempts WHERE execution_id = $1 ORDER BY attempt_number',
    [executionId],
  );
  assert.deepEqual(result.rows, [
    { attempt_number: 1, status: 'REJECTED' },
    { attempt_number: 2, status: 'DISPATCHED' },
  ]);
});

test('an unsent attempt cannot have a provider response and can be retried separately', async () => {
  const executionId = await insertExecution(await deleteFixture());
  const attemptId = await insertAttempt(executionId);
  await assert.rejects(
    finishAttempt(attemptId, 'NOT_SENT', 403, 'REQUEST_CANCELLED'),
    (error) => error.code === '23514',
  );
  await finishAttempt(attemptId, 'NOT_SENT', null, 'REQUEST_CANCELLED');
  await insertAttempt(executionId, 2);
});

test('attempt deadlines and completion timestamps must be valid', async () => {
  const executionId = await insertExecution(await deleteFixture());
  await assert.rejects(
    client.query(
      `INSERT INTO youtube_delete_attempts(id, execution_id, attempt_number, owner_id, started_at, deadline_at)
       VALUES($1, $2, 1, $3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [randomUUID(), executionId, randomUUID()],
    ),
    (error) => error.code === '23514',
  );
  const attemptId = await insertAttempt(executionId);
  await assert.rejects(
    client.query(
      `UPDATE youtube_delete_attempts SET status = 'SUCCEEDED', http_status = 204 WHERE id = $1`,
      [attemptId],
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    client.query(
      `UPDATE youtube_delete_attempts SET status = 'SUCCEEDED', http_status = 204,
       finished_at = '2025-12-31T23:59:59Z' WHERE id = $1`,
      [attemptId],
    ),
    (error) => error.code === '23514',
  );
});

test('attempt owner and deadline cannot be replaced when recording a result', async () => {
  const executionId = await insertExecution(await deleteFixture());
  const attemptId = await insertAttempt(executionId);
  await assert.rejects(
    client.query(
      `UPDATE youtube_delete_attempts SET owner_id = $2, status = 'UNKNOWN',
       finished_at = '2026-01-01T00:00:10Z', error_code = 'REQUEST_INTERRUPTED' WHERE id = $1`,
      [attemptId, randomUUID()],
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    client.query(
      `UPDATE youtube_delete_attempts SET deadline_at = '2026-01-01T00:00:40Z', status = 'UNKNOWN',
       finished_at = '2026-01-01T00:00:10Z', error_code = 'REQUEST_INTERRUPTED' WHERE id = $1`,
      [attemptId],
    ),
    (error) => error.code === '23514',
  );
});

async function insertActionPlan(
  f,
  classificationId,
  { policyVersion = 'actions-1', action = 'DELETE', durationSeconds = null } = {},
) {
  const id = randomUUID();

  await client.query(
    `
      INSERT INTO youtube_moderation_action_plans(
        id,
        channel_id,
        session_id,
        classification_id,
        policy_version,
        action,
        duration_seconds,
        reason
      )
      VALUES($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      id,
      f.channelId,
      f.sessionId,
      classificationId,
      policyVersion,
      action,
      durationSeconds,
      'The configured policy selected this action.',
    ],
  );

  return id;
}

test('an action plan references a classification in the same session', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);
  const planId = await insertActionPlan(f, classificationId);

  const result = await client.query(
    `
      SELECT classification_id, action, policy_version
      FROM youtube_moderation_action_plans
      WHERE id = $1
    `,
    [planId],
  );

  assert.deepEqual(result.rows[0], {
    classification_id: classificationId,
    action: 'DELETE',
    policy_version: 'actions-1',
  });
});

test('duplicate plans for one classification and policy are rejected', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);

  await insertActionPlan(f, classificationId);

  await assert.rejects(insertActionPlan(f, classificationId), (error) => error.code === '23505');
});

test('different action policy versions preserve separate plans', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);

  await insertActionPlan(f, classificationId);
  await insertActionPlan(f, classificationId, {
    policyVersion: 'actions-2',
    action: 'NONE',
  });

  const result = await client.query(
    `
      SELECT count(*)::int AS total
      FROM youtube_moderation_action_plans
      WHERE classification_id = $1
    `,
    [classificationId],
  );

  assert.equal(result.rows[0].total, 2);
});

test('an action plan cannot substitute another classification scope', async () => {
  const first = await fixture();
  const second = await fixture();
  const observationId = await insertObservation(first);
  const classificationId = await insertClassification(first, observationId);

  for (const scope of [
    { ...first, channelId: second.channelId },
    { ...first, sessionId: second.sessionId },
  ]) {
    await assert.rejects(
      insertActionPlan(scope, classificationId),
      (error) => error.code === '23503',
    );
  }
});

test('timeouts require a positive duration', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);

  for (const durationSeconds of [null, 0, -1]) {
    await assert.rejects(
      insertActionPlan(f, classificationId, {
        action: 'TIMEOUT',
        durationSeconds,
      }),
      (error) => error.code === '23514',
    );
  }

  await insertActionPlan(f, classificationId, {
    action: 'TIMEOUT',
    durationSeconds: 300,
  });
});

test('non-timeout plans reject a duration', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);

  for (const action of ['NONE', 'DELETE', 'BAN']) {
    await assert.rejects(
      insertActionPlan(f, classificationId, {
        action,
        durationSeconds: 300,
      }),
      (error) => error.code === '23514',
    );
  }
});

test('action plans cannot be rewritten', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const classificationId = await insertClassification(f, observationId);
  const planId = await insertActionPlan(f, classificationId);

  await assert.rejects(
    client.query(
      `
        UPDATE youtube_moderation_action_plans
        SET action = 'BAN'
        WHERE id = $1
      `,
      [planId],
    ),
    (error) => error.code === '23514',
  );
});
