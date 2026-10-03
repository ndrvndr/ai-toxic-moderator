const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AiShadowStore } = source('apps/worker/src/ingestion/ai-shadow-store.ts');

const identity = {
  channel_id: '10000000-0000-4000-8000-000000000001',
  session_id: '20000000-0000-4000-8000-000000000002',
  observation_id: '30000000-0000-4000-8000-000000000003',
  run_id: '40000000-0000-4000-8000-000000000004',
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-1',
};
const success = {
  ...identity,
  status: 'SUCCEEDED',
  rating: 2,
  severity_score: 0.56,
  truncated: false,
  inference_ms: 5,
  error_code: null,
};
const id = '50000000-0000-4000-8000-000000000005';

test('invalid inference output is rejected before database access', async () => {
  let queried = false;
  const client = {
    async query() {
      queried = true;
    },
  };
  await assert.rejects(new AiShadowStore().save(client, { ...success, severity_score: NaN }));
  assert.equal(queried, false);
});

test('replay preserves a terminal error instead of replacing it with new output', async () => {
  const failure = {
    ...identity,
    status: 'ERROR',
    rating: null,
    severity_score: null,
    truncated: null,
    inference_ms: null,
    error_code: 'INFERENCE_TIMEOUT',
  };
  let queries = 0;
  const client = {
    async query() {
      return { rows: ++queries === 1 ? [] : [{ id, ...failure }] };
    },
  };
  assert.deepEqual(await new AiShadowStore().save(client, success), {
    id,
    result: failure,
    inserted: false,
  });
});

test('find scopes every identity field and returns null when no result exists', async () => {
  const client = {
    async query(sql, values) {
      assert.deepEqual(values, Object.values(identity));
      assert.match(sql, /channel_id=\$1 AND session_id=\$2/);
      assert.match(sql, /run_id=\$4/);
      return { rows: [] };
    },
  };
  assert.equal(await new AiShadowStore().find(client, identity), null);
});

test('a conflict without an authorized matching row is an error', async () => {
  await assert.rejects(
    new AiShadowStore().save(
      {
        async query() {
          return { rows: [] };
        },
      },
      success,
    ),
    /could not be read/,
  );
});

test('malformed stored output is rejected on read', async () => {
  await assert.rejects(
    new AiShadowStore().find(
      {
        async query() {
          return { rows: [{ id, ...success, rating: 1 }] };
        },
      },
      identity,
    ),
  );
});
