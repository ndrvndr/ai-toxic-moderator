const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { aiShadowResult } = source('packages/contracts/src/ai-shadow.ts');

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
const failure = {
  ...identity,
  status: 'ERROR',
  rating: null,
  severity_score: null,
  truncated: null,
  inference_ms: null,
  error_code: 'INFERENCE_TIMEOUT',
};

test('shadow output accepts supported ratings without application decisions', () => {
  for (const rating of [0, 2, 3, 4])
    assert.equal(aiShadowResult.safeParse({ ...success, rating }).success, true);
  for (const extra of [{ action: 'BAN' }, { outcome: 'ALLOW' }, { category: 'HARASSMENT' }]) {
    assert.equal(aiShadowResult.safeParse({ ...success, ...extra }).success, false);
  }
});
test('failed inference cannot masquerade as safe model output', () => {
  assert.deepEqual(aiShadowResult.parse(failure), failure);
  for (const change of [
    { rating: 0 },
    { severity_score: 0 },
    { error_code: null },
    { error_code: 'raw secret' },
  ]) {
    assert.equal(aiShadowResult.safeParse({ ...failure, ...change }).success, false);
  }
  assert.equal(
    aiShadowResult.safeParse({ ...success, error_code: 'INFERENCE_FAILED' }).success,
    false,
  );
});
test('invalid scores, timing, unsupported rating and artifact identity are rejected', () => {
  for (const change of [
    { rating: 1 },
    { severity_score: NaN },
    { severity_score: Infinity },
    { severity_score: -0.1 },
    { severity_score: 1.1 },
    { inference_ms: -1 },
    { model_revision: 'main' },
    { model_variant: 'FP32' },
    { run_id: 'invalid' },
    { adapter_version: '' },
    { truncated: undefined },
  ])
    assert.equal(aiShadowResult.safeParse({ ...success, ...change }).success, false);
});
