const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const {
  aiModerationModelIdentity,
  aiModerationSettingsConfiguration,
  aiModerationSettingsUpdate,
  aiModerationSettingsRecord,
  aiModerationSettingsResponse,
  aiModerationSettingsSnapshot,
  aiModerationPreferencesUpdate,
} = source('packages/contracts/src/ai-moderation-settings.ts');

test('streamer preferences exclude model overrides and retain tier validation', () => {
  const { model, ...preferences } = configuration();
  const input = { expected_revision: 0, configuration: preferences };
  assert.deepEqual(aiModerationPreferencesUpdate.parse(input), input);
  assert.equal(
    aiModerationPreferencesUpdate.safeParse({ ...input, configuration: { ...preferences, model } })
      .success,
    false,
  );
  assert.equal(
    aiModerationPreferencesUpdate.safeParse({
      ...input,
      configuration: {
        ...preferences,
        timeout: { ...preferences.timeout, threshold: preferences.delete.threshold },
      },
    }).success,
    false,
  );
});

// Fixture values exercise validation; they are not calibrated enforcement defaults.
function configuration() {
  return {
    schema_version: 1,
    automatic_actions_enabled: false,
    model: {
      model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
      model_revision: '0e011be8ba6aca297059e7ab1a07d4f11054e653',
      model_variant: 'INT8',
      adapter_version: 'laskar-shadow-1',
    },
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: false, threshold: 0.6 },
    timeout: { enabled: false, threshold: 0.8, duration_seconds: 30 },
    ban: { enabled: false, threshold: 0.95 },
  };
}

test('disabled settings retain staged thresholds without silently enabling actions', () => {
  const input = configuration();
  assert.deepEqual(aiModerationSettingsConfiguration.parse(input), input);
  assert.equal(aiModerationSettingsConfiguration.safeParse({}).success, false);
  assert.equal(aiModerationSettingsConfiguration.safeParse(undefined).success, false);
});

test('every action tier can be enabled independently with an explicit global switch', () => {
  for (const automatic_actions_enabled of [false, true]) {
    for (let mask = 0; mask < 8; mask += 1) {
      const input = configuration();
      input.automatic_actions_enabled = automatic_actions_enabled;
      input.delete.enabled = Boolean(mask & 1);
      input.timeout.enabled = Boolean(mask & 2);
      input.ban.enabled = Boolean(mask & 4);
      assert.deepEqual(aiModerationSettingsConfiguration.parse(input), input);
    }
  }
});

test('thresholds require finite numeric scores in the inclusive zero-to-one range', () => {
  for (const name of ['delete', 'timeout', 'ban']) {
    for (const threshold of [-0.01, 1.01, NaN, Infinity, -Infinity, '0.8', null, undefined]) {
      const input = configuration();
      input[name].threshold = threshold;
      assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, false);
    }
  }

  const boundaries = configuration();
  boundaries.delete.threshold = 0;
  boundaries.timeout.threshold = 0.5;
  boundaries.ban.threshold = 1;
  assert.deepEqual(aiModerationSettingsConfiguration.parse(boundaries), boundaries);
});

test('equal and crossed thresholds are rejected even when all actions are disabled', () => {
  for (const [deleteThreshold, timeoutThreshold, banThreshold, expectedPath] of [
    [0.8, 0.8, 0.95, ['timeout', 'threshold']],
    [0.9, 0.8, 0.95, ['timeout', 'threshold']],
    [0.6, 0.95, 0.95, ['ban', 'threshold']],
    [0.6, 0.95, 0.8, ['ban', 'threshold']],
  ]) {
    const input = configuration();
    input.delete.threshold = deleteThreshold;
    input.timeout.threshold = timeoutThreshold;
    input.ban.threshold = banThreshold;
    const result = aiModerationSettingsConfiguration.safeParse(input);
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0].path, expectedPath);
  }
});

test('timeout duration uses application bounds and rejects coercion and fractional values', () => {
  for (const duration_seconds of [0, -1, 1.5, 86_401, '30', Infinity, NaN, undefined]) {
    const input = configuration();
    input.timeout.duration_seconds = duration_seconds;
    assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, false);
  }
  for (const duration_seconds of [1, 86_400]) {
    const input = configuration();
    input.timeout.duration_seconds = duration_seconds;
    assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, true);
  }
});

test('settings pin model revision, variant, adapter, and the expected-severity metric', () => {
  for (const change of [
    { model_id: 'unqualified-model' },
    { model_revision: 'main' },
    { model_revision: 'a'.repeat(39) },
    { model_variant: 'FP32' },
    { adapter_version: '' },
    { adapter_version: 'adapter with spaces' },
    { model_revision: undefined },
  ]) {
    const input = configuration();
    input.model = { ...input.model, ...change };
    assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, false);
  }
  for (const score_metric of ['PROBABILITY', 'RATING', undefined]) {
    assert.equal(
      aiModerationSettingsConfiguration.safeParse({ ...configuration(), score_metric }).success,
      false,
    );
  }
  assert.deepEqual(aiModerationModelIdentity.parse(configuration().model), configuration().model);
});

test('all switches are required booleans with no implicit defaults', () => {
  for (const value of [undefined, null, 'false', 0]) {
    const input = configuration();
    input.automatic_actions_enabled = value;
    assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, false);
    for (const name of ['delete', 'timeout', 'ban']) {
      const nested = configuration();
      nested[name].enabled = value;
      assert.equal(aiModerationSettingsConfiguration.safeParse(nested).success, false);
    }
  }
  for (const name of ['delete', 'timeout', 'ban', 'model', 'score_metric', 'schema_version']) {
    const input = configuration();
    delete input[name];
    assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, false);
  }
});

test('strict settings reject extra model, action, ownership, and execution fields', () => {
  for (const input of [
    { ...configuration(), channel_id: 'injected' },
    { ...configuration(), schema_version: 2 },
    { ...configuration(), outcome: 'ACTION_REQUIRED' },
    { ...configuration(), model: { ...configuration().model, run_id: 'injected' } },
    { ...configuration(), delete: { ...configuration().delete, duration_seconds: 30 } },
    { ...configuration(), ban: { ...configuration().ban, duration_seconds: 30 } },
    { ...configuration(), timeout: { ...configuration().timeout, author_channel_id: 'injected' } },
  ]) {
    assert.equal(aiModerationSettingsConfiguration.safeParse(input).success, false);
  }
});

test('updates require a safe expected revision and reject client-assigned ownership', () => {
  const input = { expected_revision: 0, configuration: configuration() };
  for (const expected_revision of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      aiModerationSettingsUpdate.safeParse({ ...input, expected_revision }).success,
      true,
    );
  }
  for (const expected_revision of [-1, 1.5, '0', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      aiModerationSettingsUpdate.safeParse({ ...input, expected_revision }).success,
      false,
    );
  }
  for (const field of ['channel_id', 'created_by', 'id', 'revision', 'created_at']) {
    assert.equal(
      aiModerationSettingsUpdate.safeParse({ ...input, [field]: 'injected' }).success,
      false,
    );
  }
});

test('stored records require valid server metadata and responses express absence explicitly', () => {
  const settings = {
    id: '10000000-0000-4000-8000-000000000001',
    channel_id: '20000000-0000-4000-8000-000000000002',
    revision: 1,
    configuration: configuration(),
    created_by: '30000000-0000-4000-8000-000000000003',
    created_at: '2026-10-04T00:00:00Z',
  };
  assert.deepEqual(aiModerationSettingsRecord.parse(settings), settings);
  assert.deepEqual(aiModerationSettingsResponse.parse({ settings }), { settings });
  assert.deepEqual(aiModerationSettingsResponse.parse({ settings: null }), { settings: null });
  assert.equal(aiModerationSettingsResponse.safeParse({}).success, false);
  for (const change of [
    { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'invalid' },
    { channel_id: 'invalid' },
    { created_by: 'invalid' },
    { created_at: 'invalid' },
  ]) {
    assert.equal(aiModerationSettingsRecord.safeParse({ ...settings, ...change }).success, false);
  }
});

test('public exports initialize AI settings alongside existing chat and shadow contracts', () => {
  const contracts = source('packages/contracts/src/index.ts');
  assert.equal(contracts.aiModerationSettingsConfiguration, aiModerationSettingsConfiguration);
  assert.equal(contracts.aiModerationSettingsUpdate, aiModerationSettingsUpdate);
  assert.equal(contracts.aiModerationSettingsRecord, aiModerationSettingsRecord);
  assert.equal(contracts.aiModerationModelIdentity, aiModerationModelIdentity);
  assert.equal(contracts.aiModerationSettingsSnapshot, aiModerationSettingsSnapshot);
  assert.deepEqual(contracts.aiModerationSettingsResponse.parse({ settings: null }), {
    settings: null,
  });
  assert.ok(contracts.aiShadowResult);
  assert.ok(contracts.chatEvaluation);
});

test('saved snapshots require revision provenance while absent policies contain no model or thresholds', () => {
  const identity = {
    run_id: '10000000-0000-4000-8000-000000000001',
    channel_id: '20000000-0000-4000-8000-000000000002',
  };
  const saved = {
    ...identity,
    source: 'SAVED',
    settings_id: '30000000-0000-4000-8000-000000000003',
    settings_revision: 1,
    configuration: configuration(),
  };
  assert.deepEqual(aiModerationSettingsSnapshot.parse(saved), saved);
  for (const source of ['DEFAULT', 'LEGACY']) {
    const absent = {
      ...identity,
      source,
      settings_id: null,
      settings_revision: null,
      configuration: null,
    };
    assert.deepEqual(aiModerationSettingsSnapshot.parse(absent), absent);
    for (const change of [
      { configuration: configuration() },
      { settings_id: saved.settings_id },
      { settings_revision: 1 },
      { configuration: undefined },
    ]) {
      assert.equal(aiModerationSettingsSnapshot.safeParse({ ...absent, ...change }).success, false);
    }
  }
  for (const change of [
    { settings_id: null },
    { settings_revision: null },
    { settings_revision: 0 },
    { configuration: null },
    { source: 'UNKNOWN' },
    { channel_id: 'invalid' },
    { unexpected: true },
  ]) {
    assert.equal(aiModerationSettingsSnapshot.safeParse({ ...saved, ...change }).success, false);
  }
});
