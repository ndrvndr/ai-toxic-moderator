const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const {
  moderationSettingsConfiguration,
  moderationSettingsUpdate,
  moderationSettingsRecord,
  moderationSettingsResponse,
} = source('packages/contracts/src/moderation-settings.ts');

const reference = {
  rule_id: 'id.harassment.direct-insult',
  rule_version: '1',
  minimum_severity: 2,
};

function configuration(rules = [], automatic_actions_enabled = false) {
  return { schema_version: 1, automatic_actions_enabled, rules };
}

test('disabled configurations can retain staged actions without enabling enforcement', () => {
  const input = configuration([{ ...reference, action: 'DELETE' }]);
  assert.deepEqual(moderationSettingsConfiguration.parse(input), input);
  assert.deepEqual(moderationSettingsConfiguration.parse(configuration()), configuration());
});

test('delete, timeout, and ban configurations require their own action fields', () => {
  for (const rule of [
    { ...reference, action: 'DELETE' },
    { ...reference, action: 'TIMEOUT', duration_seconds: 30 },
    { ...reference, action: 'BAN' },
  ]) {
    const input = configuration([rule], true);
    assert.deepEqual(moderationSettingsConfiguration.parse(input), input);
  }

  for (const rule of [
    { ...reference, action: 'TIMEOUT' },
    { ...reference, action: 'DELETE', duration_seconds: 30 },
    { ...reference, action: 'BAN', duration_seconds: 30 },
    { ...reference, action: 'NONE' },
    { ...reference, action: 'BAN', author_channel_id: 'injected-target' },
  ]) {
    assert.equal(moderationSettingsConfiguration.safeParse(configuration([rule])).success, false);
  }
});

test('timeouts reject coercion, fractions, and durations beyond application bounds', () => {
  for (const duration_seconds of [0, -1, 1.5, '30', Infinity, NaN, 86_401]) {
    assert.equal(
      moderationSettingsConfiguration.safeParse(
        configuration([{ ...reference, action: 'TIMEOUT', duration_seconds }]),
      ).success,
      false,
    );
  }

  for (const duration_seconds of [1, 86_400]) {
    assert.equal(
      moderationSettingsConfiguration.safeParse(
        configuration([{ ...reference, action: 'TIMEOUT', duration_seconds }]),
      ).success,
      true,
    );
  }
});

test('a pinned rule version cannot select conflicting or duplicate actions', () => {
  const rule = { ...reference, action: 'DELETE' };
  for (const second of [rule, { ...reference, action: 'BAN' }]) {
    const result = moderationSettingsConfiguration.safeParse(configuration([rule, second]));
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0].path, ['rules', 1, 'rule_id']);
  }

  assert.equal(
    moderationSettingsConfiguration.safeParse(
      configuration([rule, { ...reference, rule_version: '2', action: 'BAN' }]),
    ).success,
    true,
  );
});

test('configuration rejects malformed rule references, severities, and excessive rule counts', () => {
  for (const change of [
    { rule_id: '' },
    { rule_id: '   ' },
    { rule_id: 'arbitrary.*regex' },
    { rule_id: 'x'.repeat(129) },
    { rule_version: '' },
    { rule_version: ' 1' },
    { minimum_severity: 0 },
    { minimum_severity: 5 },
    { minimum_severity: 1.5 },
    { minimum_severity: '2' },
  ]) {
    assert.equal(
      moderationSettingsConfiguration.safeParse(
        configuration([{ ...reference, action: 'DELETE', ...change }]),
      ).success,
      false,
    );
  }

  const rules = Array.from({ length: 101 }, (_, index) => ({
    ...reference,
    rule_id: `rule-${index}`,
    action: 'DELETE',
  }));
  assert.equal(moderationSettingsConfiguration.safeParse(configuration(rules)).success, false);
  assert.equal(
    moderationSettingsConfiguration.safeParse(configuration(rules.slice(0, 100))).success,
    true,
  );
});

test('updates require explicit revision and reject client-supplied ownership metadata', () => {
  const input = { expected_revision: 0, configuration: configuration() };
  assert.deepEqual(moderationSettingsUpdate.parse(input), input);
  assert.equal(
    moderationSettingsUpdate.safeParse({ ...input, expected_revision: 3 }).success,
    true,
  );

  for (const expected_revision of [-1, 1.5, '0', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      moderationSettingsUpdate.safeParse({ ...input, expected_revision }).success,
      false,
    );
  }

  for (const field of ['channel_id', 'created_by', 'id', 'revision']) {
    assert.equal(
      moderationSettingsUpdate.safeParse({ ...input, [field]: 'injected' }).success,
      false,
    );
  }

  const { automatic_actions_enabled, ...implicitConfiguration } = configuration();
  assert.equal(moderationSettingsConfiguration.safeParse(implicitConfiguration).success, false);
  assert.equal(
    moderationSettingsConfiguration.safeParse({
      ...configuration(),
      automatic_actions_enabled: 'false',
    }).success,
    false,
  );
});

test('stored settings have server-assigned identity and positive revision; absence is explicit', () => {
  const settings = {
    id: '10000000-0000-4000-8000-000000000001',
    channel_id: '20000000-0000-4000-8000-000000000002',
    revision: 1,
    configuration: configuration(),
    created_by: '30000000-0000-4000-8000-000000000003',
    created_at: '2026-10-03T00:00:00Z',
  };
  assert.deepEqual(moderationSettingsRecord.parse(settings), settings);
  assert.deepEqual(moderationSettingsResponse.parse({ settings }), { settings });
  assert.deepEqual(moderationSettingsResponse.parse({ settings: null }), { settings: null });
  assert.equal(moderationSettingsRecord.safeParse({ ...settings, revision: 0 }).success, false);
  assert.equal(
    moderationSettingsRecord.safeParse({ ...settings, channel_id: 'invalid' }).success,
    false,
  );
  assert.equal(moderationSettingsResponse.safeParse({}).success, false);
});

test('the public contracts export settings without a circular initialization dependency', () => {
  const publicContracts = source('packages/contracts/src/index.ts');
  assert.equal(publicContracts.moderationSettingsConfiguration, moderationSettingsConfiguration);
  assert.equal(publicContracts.moderationSettingsUpdate, moderationSettingsUpdate);
  assert.deepEqual(publicContracts.moderationSettingsResponse.parse({ settings: null }), {
    settings: null,
  });
});
