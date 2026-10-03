const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { LaskarShadowAdapter, normalizeLaskarText, remapLaskarTokens, decodeLaskarLogits } = source(
  'apps/worker/src/ingestion/laskar-shadow-adapter.ts',
);

const observation = {
  channel_id: '10000000-0000-4000-8000-000000000001',
  session_id: '20000000-0000-4000-8000-000000000002',
  observation_id: '30000000-0000-4000-8000-000000000003',
  run_id: '40000000-0000-4000-8000-000000000004',
};
const revision = 'a'.repeat(40);

test('normalization handles ASCII mentions, Unicode, whitespace, and URLs consistently', () => {
  assert.equal(
    normalizeLaskarText('  Ｈｅｌｌｏ\u200b @viewer\nhttps://example.com USER\t'),
    'Hello <user> <url> <user>',
  );
  assert.equal(normalizeLaskarText('@Ünïcödé'), '@Ünïcödé');
});

test('token remapping is applied and invalid IDs are rejected', () => {
  const remap = Int32Array.from([3, 0, 2]);
  assert.deepEqual(
    remapLaskarTokens(BigInt64Array.from([0n, 2n, 1n]), remap),
    BigInt64Array.from([3n, 2n, 0n]),
  );
  for (const id of [-1n, 3n, 9007199254740993n])
    assert.throws(() => remapLaskarTokens(BigInt64Array.from([id]), remap));
});

test('decoding uses stable softmax and expected severity rather than maximum probability', () => {
  const flat = decodeLaskarLogits([1000, 1000, 1000, 1000], 1);
  assert.equal(flat.rating, 0);
  assert.equal(flat.severity_score, 0.5625);
  assert.equal(decodeLaskarLogits([-1000, -1000, -1000, 1000], 1).rating, 4);
  for (const logits of [
    [0, 1],
    [NaN, 0, 0, 0],
    [Infinity, 0, 0, 0],
  ])
    assert.throws(() => decodeLaskarLogits(logits, 1));
  assert.throws(() => decodeLaskarLogits([0, 1, 2, 3], 0));
});

test('one backend is reused and output retains artifact and observation identity', async () => {
  const texts = [];
  const adapter = new LaskarShadowAdapter(
    {
      async infer(text) {
        texts.push(text);
        return { logits: [0, 10, 0, 0], truncated: true };
      },
      async dispose() {},
    },
    revision,
    1,
  );
  const result = await adapter.predict(observation, '  halo\nviewer ');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.rating, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.model_revision, revision);
  assert.equal(result.run_id, observation.run_id);
  assert.equal('action' in result, false);
  await adapter.predict(observation, 'next message');
  assert.deepEqual(texts, ['halo viewer', 'next message']);
  await adapter.dispose();
});

test('inference failures and invalid output never become safe ratings or expose raw exceptions', async () => {
  for (const [infer, expected] of [
    [
      async () => {
        throw new Error('private-provider-detail');
      },
      'INFERENCE_FAILED',
    ],
    [async () => ({ logits: [NaN, 0, 0, 0], truncated: false }), 'INVALID_OUTPUT'],
    [async () => ({ logits: [0, 1, 2, 3], truncated: undefined }), 'INVALID_OUTPUT'],
  ]) {
    const adapter = new LaskarShadowAdapter({ infer, async dispose() {} }, revision, 1);
    const result = await adapter.predict(observation, 'hello');
    assert.equal(result.status, 'ERROR');
    assert.equal(result.error_code, expected);
    assert.equal(result.rating, null);
    assert.equal(result.severity_score, null);
    assert.equal(JSON.stringify(result).includes('private-provider-detail'), false);
    await adapter.dispose();
  }
});

test('empty and oversized inputs do not invoke inference', async () => {
  let calls = 0;
  const adapter = new LaskarShadowAdapter(
    {
      async infer() {
        calls++;
        throw new Error('must not run');
      },
      async dispose() {},
    },
    revision,
    1,
  );
  assert.equal((await adapter.predict(observation, ' ')).error_code, 'INFERENCE_FAILED');
  assert.equal(
    (await adapter.predict(observation, 'x'.repeat(10001))).error_code,
    'INPUT_TOO_LONG',
  );
  assert.equal((await adapter.predict(observation, '\u200b')).error_code, 'INFERENCE_FAILED');
  assert.equal(calls, 0);
  await adapter.dispose();
});

test('busy backpressure is rejected and disposal waits for active inference and releases once', async () => {
  let finish;
  let released = 0;
  const adapter = new LaskarShadowAdapter(
    {
      infer() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      async dispose() {
        released++;
      },
    },
    revision,
    1,
  );
  const active = adapter.predict(observation, 'hello');
  await assert.rejects(adapter.predict(observation, 'second'), /AI_ADAPTER_BUSY/);
  const disposing = adapter.dispose();
  assert.equal(released, 0);
  finish({ logits: [10, 0, 0, 0], truncated: false });
  assert.equal((await active).status, 'SUCCEEDED');
  await disposing;
  await adapter.dispose();
  assert.equal(released, 1);
  assert.equal((await adapter.predict(observation, 'after close')).error_code, 'MODEL_UNAVAILABLE');
});
