const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

let client, ids, migrate, seed;

const schema = 'test_' + randomUUID().replaceAll('-', '');

before(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('Set TEST_DATABASE_URL to a disposable local PostgreSQL database');

  const url = new URL(process.env.TEST_DATABASE_URL);

  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Test database must be local');

  ({ ids, migrate, seed } = await import('../scripts/database.mjs'));
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });

  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await migrate(client);
  await seed(client);
});

after(async () => {
  if (client) {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
});

async function rollback(work) {
  await client.query('BEGIN');
  try {
    await work();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function insertMessage(id = randomUUID(), session = ids.session) {
  await client.query(
    "INSERT INTO chat_messages(id,channel_id,session_id,source,external_message_id,author_external_id,author_display_name,raw_text,published_at,ingestion_hash) VALUES($1,$2,$3,'SYNTHETIC',$4,'viewer','Viewer','slot RAM',now(),'hash')",
    [id, ids.channel, session, 'external-' + id],
  );
  return id;
}

async function insertDecision(messageId) {
  const id = randomUUID();
  await client.query(
    "INSERT INTO moderation_decisions(id,channel_id,session_id,message_id,evaluation_run_id,outcome,severity,reason_code,reason,representations,signals,risk_snapshot,version_bundle) VALUES($1,$2,$3,$4,$5,'ALLOW',0,'NO_RULE_MATCH','Test','[]','[]','{}','{}')",
    [id, ids.channel, ids.session, messageId, ids.run],
  );
  return id;
}

test('fresh migrations and seed can run twice without duplicates', async () => {
  await migrate(client);
  await seed(client);

  for (const table of [
    'accounts',
    'channels',
    'stream_sessions',
    'configuration_bundles',
    'evaluation_runs',
  ])
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
});

test('message deduplication enforced in database', () =>
  rollback(async () => {
    const id = await insertMessage();
    await assert.rejects(
      client.query(
        'INSERT INTO chat_messages SELECT $1,channel_id,session_id,source,external_message_id,author_external_id,author_display_name,raw_text,published_at,received_at,ingestion_hash FROM chat_messages WHERE id=$2',
        [randomUUID(), id],
      ),
      { code: '23505' },
    );
  }));

test('channel boundary enforced on sessions', () =>
  rollback(async () => {
    const other = randomUUID();
    await client.query('INSERT INTO channels(id,display_name) VALUES($1,$2)', [other, 'Other']);
    await assert.rejects(
      client.query(
        "INSERT INTO evaluation_runs(id,channel_id,session_id,configuration_bundle_id,kind,mode) VALUES($1,$2,$3,$4,'PRIMARY','SIMULATION')",
        [randomUUID(), other, ids.session, ids.bundle],
      ),
      { code: '23503' },
    );
  }));

test('same-channel messages cannot use another session run', () =>
  rollback(async () => {
    const session = randomUUID();
    await client.query('INSERT INTO stream_sessions(id,channel_id,label) VALUES($1,$2,$3)', [
      session,
      ids.channel,
      'Other session',
    ]);
    const message = await insertMessage(randomUUID(), session);
    await assert.rejects(
      client.query(
        "INSERT INTO processing_tasks(id,channel_id,session_id,message_id,evaluation_run_id,status) VALUES($1,$2,$3,$4,$5,'QUEUED')",
        [randomUUID(), ids.channel, session, message, ids.run],
      ),
      { code: '23503' },
    );
  }));

test('decisions immutable and duplicates rejected', () =>
  rollback(async () => {
    const message = await insertMessage();
    const decision = await insertDecision(message);
    await client.query('SAVEPOINT check_duplicate');
    await assert.rejects(insertDecision(message), { code: '23505' });
    await client.query('ROLLBACK TO check_duplicate');
    await assert.rejects(
      client.query("UPDATE moderation_decisions SET reason='rewrite' WHERE id=$1", [decision]),
      { code: '23514' },
    );
  }));

test('feedback requires correction even when SQL value is null', () =>
  rollback(async () => {
    const decision = await insertDecision(await insertMessage());
    await assert.rejects(
      client.query(
        "INSERT INTO feedback(id,channel_id,decision_id,reviewer_id,label,request_key,request_hash) VALUES($1,$2,$3,$4,'FALSE_POSITIVE',$5,'hash')",
        [randomUUID(), ids.channel, decision, ids.account, randomUUID()],
      ),
      { code: '23514' },
    );
  }));

test('schema disallows provider-success status', () =>
  rollback(async () => {
    const decision = await insertDecision(await insertMessage());
    await assert.rejects(
      client.query(
        "INSERT INTO moderation_actions(id,channel_id,decision_id,action_index,action_type,target_kind,target_external_id,status,idempotency_key,completed_at) VALUES($1,$2,$3,0,'DELETE','MESSAGE','external','SUCCEEDED',$4,now())",
        [randomUUID(), ids.channel, decision, randomUUID()],
      ),
      { code: '23514' },
    );
  }));

test('decision and audit inserts roll back together', async () => {
  await rollback(async () => {
    await insertDecision(await insertMessage());
    await client.query(
      "INSERT INTO audit_events(id,channel_id,actor_type,event_type,entity_type,entity_id,metadata,trace_id) VALUES($1,$2,'SYSTEM','test','decision',$3,'{}',$4)",
      [randomUUID(), ids.channel, randomUUID(), randomUUID()],
    );
  });
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM moderation_decisions')).rows[0].n,
    0,
  );
  assert.equal((await client.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, 0);
});
