const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { customBlacklistRule, customBlacklistConfiguration, normalizeBlacklistPattern } = source(
  'packages/contracts/src/custom-blacklist.ts',
);

function rule(overrides = {}) {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    enabled: true,
    match_type: 'WORD',
    pattern: 'kantorbola99',
    action: 'DELETE',
    ...overrides,
  };
}

function configuration(rules = [], enabled = true) {
  return { schema_version: 1, enabled, rules };
}

test('blacklist actions always delete and author actions have distinct duration requirements', () => {
  for (const entry of [
    rule(),
    rule({ action: 'DELETE_TIMEOUT', duration_seconds: 300 }),
    rule({ action: 'DELETE_BAN' }),
  ]) {
    assert.deepEqual(customBlacklistRule.parse(entry), entry);
  }
  for (const entry of [
    rule({ action: 'DELETE_TIMEOUT' }),
    rule({ duration_seconds: 30 }),
    rule({ action: 'DELETE_BAN', duration_seconds: 30 }),
    rule({ action: 'TIMEOUT' }),
    rule({ action: 'BAN' }),
    rule({ author_channel_id: 'injected-target' }),
    rule({ external_message_id: 'injected-message' }),
  ]) {
    assert.equal(customBlacklistRule.safeParse(entry).success, false);
  }
  for (const duration_seconds of [0, -1, 1.5, '300', 86_401, NaN, Infinity]) {
    assert.equal(
      customBlacklistRule.safeParse(rule({ action: 'DELETE_TIMEOUT', duration_seconds })).success,
      false,
    );
  }
  for (const duration_seconds of [1, 86_400]) {
    assert.equal(
      customBlacklistRule.safeParse(rule({ action: 'DELETE_TIMEOUT', duration_seconds })).success,
      true,
    );
  }
});

test('literal patterns normalize case, compatibility characters, and ordinary spaces', () => {
  assert.equal(normalizeBlacklistPattern('  ＫＡＮＴＯＲＢＯＬＡ９９  '), 'kantorbola99');
  assert.equal(customBlacklistRule.parse(rule({ pattern: '  ABC  ' })).pattern, 'abc');
  assert.equal(
    customBlacklistRule.parse(rule({ match_type: 'PHRASE', pattern: '  PROMO   HARI INI  ' }))
      .pattern,
    'promo hari ini',
  );
  assert.equal(
    customBlacklistRule.parse(rule({ match_type: 'PHRASE', pattern: 'offer.*(today)' })).pattern,
    'offer.*(today)',
  );
  assert.equal(customBlacklistRule.safeParse(rule({ match_type: 'REGEX' })).success, false);
});

test('empty, invisible, oversized, and malformed word patterns are rejected', () => {
  for (const pattern of [
    '',
    '   ',
    '\u200b',
    'ab\u200dcd',
    'ab\ncd',
    'ab\tcd',
    'ab\0cd',
    'a'.repeat(254),
  ]) {
    assert.equal(customBlacklistRule.safeParse(rule({ pattern })).success, false);
  }
  for (const pattern of ['two words', 'abc.*', 'example.com', 'hello!']) {
    assert.equal(customBlacklistRule.safeParse(rule({ pattern })).success, false);
  }
  for (const pattern of ['pantek', 'abc99', 'école']) {
    assert.equal(customBlacklistRule.safeParse(rule({ pattern })).success, true);
  }
});

test('domain entries accept hosts and reject URLs, wildcards, ports, and IP addresses', () => {
  for (const pattern of ['example.com', 'sub.example.com', 'xn--bcher-kva.de']) {
    assert.equal(
      customBlacklistRule.safeParse(rule({ match_type: 'DOMAIN', pattern })).success,
      true,
    );
  }
  assert.equal(
    customBlacklistRule.parse(rule({ match_type: 'DOMAIN', pattern: '  EXAMPLE.COM  ' })).pattern,
    'example.com',
  );
  for (const pattern of [
    'https://example.com',
    'example.com/path',
    'example.com:443',
    '*.example.com',
    'user@example.com',
    'localhost',
    '127.0.0.1',
    '[::1]',
    '-bad.com',
    'bad-.com',
    'example..com',
    'example.com.',
    'a'.repeat(64) + '.com',
    'bücher.de',
  ]) {
    assert.equal(
      customBlacklistRule.safeParse(rule({ match_type: 'DOMAIN', pattern })).success,
      false,
    );
  }
});

test('normalized duplicates cannot select conflicting actions even when an entry is disabled', () => {
  const secondId = '20000000-0000-4000-8000-000000000002';
  for (const enabled of [true, false]) {
    const parsed = customBlacklistConfiguration.safeParse(
      configuration([
        rule(),
        rule({
          id: secondId,
          pattern: ' ＫＡＮＴＯＲＢＯＬＡ９９ ',
          enabled,
          action: 'DELETE_BAN',
        }),
      ]),
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(parsed.error.issues[0].path, ['rules', 1, 'pattern']);
  }
  const duplicateId = customBlacklistConfiguration.safeParse(
    configuration([rule(), rule({ pattern: 'another' })]),
  );
  assert.equal(duplicateId.success, false);
  assert.deepEqual(duplicateId.error.issues[0].path, ['rules', 1, 'id']);
  assert.equal(
    customBlacklistConfiguration.safeParse(
      configuration([rule(), rule({ id: secondId, match_type: 'PHRASE' })]),
    ).success,
    true,
  );
});

test('enablement is explicit and disabled configurations can retain valid staged rules', () => {
  const input = configuration([rule({ enabled: false })], false);
  assert.deepEqual(customBlacklistConfiguration.parse(input), input);
  assert.deepEqual(customBlacklistConfiguration.parse(configuration()), configuration());
  for (const enabled of [undefined, 'true', 1]) {
    assert.equal(customBlacklistRule.safeParse(rule({ enabled })).success, false);
    assert.equal(customBlacklistConfiguration.safeParse({ ...input, enabled }).success, false);
  }
  assert.equal(
    customBlacklistConfiguration.safeParse({ ...input, schema_version: 2 }).success,
    false,
  );
  assert.equal(
    customBlacklistConfiguration.safeParse({ ...input, channel_id: 'injected' }).success,
    false,
  );
  const rules = Array.from({ length: 101 }, (_, index) =>
    rule({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      pattern: `word${index}`,
    }),
  );
  assert.equal(customBlacklistConfiguration.safeParse(configuration(rules)).success, false);
  assert.equal(
    customBlacklistConfiguration.safeParse(configuration(rules.slice(0, 100))).success,
    true,
  );
});

test('public exports avoid circular imports and existing settings do not silently accept blacklist data', () => {
  const contracts = source('packages/contracts/src/index.ts');
  assert.equal(contracts.customBlacklistRule, customBlacklistRule);
  assert.equal(contracts.customBlacklistConfiguration, customBlacklistConfiguration);
  assert.equal(
    contracts.moderationSettingsConfiguration.safeParse({
      schema_version: 1,
      automatic_actions_enabled: false,
      rules: [],
      blacklist: configuration([rule()]),
    }).success,
    false,
  );
});
