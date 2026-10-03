const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { CustomBlacklistMatcher } = source('packages/moderation-core/src/custom-blacklist-matcher.ts');

function entry(index, overrides = {}) {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    enabled: true, match_type: 'WORD', pattern: 'abc', action: 'DELETE', ...overrides,
  };
}
function matcher(rules, enabled = true) {
  return new CustomBlacklistMatcher({ schema_version: 1, enabled, rules });
}

test('word matches use Unicode boundaries rather than substrings', () => {
  const detect = matcher([entry(1)]);
  for (const text of ['abc', '(ABC)!', 'hello abc world', 'ＡＢＣ']) {
    assert.equal(detect.match(text).delete_message, true, text);
  }
  for (const text of ['', 'xabc', 'abc99', 'abc_def', 'éabc', 'abc\u0301', '漢abc']) {
    assert.equal(detect.match(text).matched, false, text);
  }
  assert.equal(matcher([entry(1, { pattern: 'é' })]).match('e\u0301').matched, true);
});

test('phrases are literal normalized substrings including regex metacharacters', () => {
  const detect = matcher([entry(1, { match_type: 'PHRASE', pattern: ' (a+b).* ' })]);
  assert.equal(detect.match('visit (A+B).* now').matched, true);
  assert.equal(detect.match('aaabZZ').matched, false);
  const spaced = matcher([entry(1, { match_type: 'PHRASE', pattern: 'hello world' })]);
  assert.equal(spaced.match('HELLO\t\n  WORLD').matched, true);
});

test('domains match complete HTTP URL hosts and bare domains including subdomains', () => {
  const detect = matcher([entry(1, { match_type: 'DOMAIN', pattern: 'example.com' })]);
  for (const text of [
    'https://example.com/path', 'HTTP://EXAMPLE.COM:8080/path?q=1',
    '(https://www.example.com/path).', 'example.com', 'promo.example.com/deal',
    'example.com:443/deal', 'https://example.com./',
  ]) assert.equal(detect.match(text).matched, true, text);
});

test('domain matching never uses unrelated paths, queries, email addresses or lookalike hosts', () => {
  const detect = matcher([entry(1, { match_type: 'DOMAIN', pattern: 'example.com' })]);
  for (const text of [
    'https://example.com.evil.test/', 'https://notexample.com/',
    'https://evil.test/example.com', 'https://evil.test/?redirect=https://example.com',
    'https://example.com@evil.test/', 'viewer@example.com',
    'prefixexample.com', 'example.comsuffix', 'ftp://example.com/',
    '//example.com', 'https:///example.com', 'https://example.com\\@evil.test',
    'https://127.0.0.1/example.com', 'example.com:99999/',
  ]) assert.equal(detect.match(text).matched, false, text);
});

test('domain parsing canonicalizes IDN hosts and extracts multiple separate tokens', () => {
  const detect = matcher([entry(1, { match_type: 'DOMAIN', pattern: 'xn--bcher-kva.example' })]);
  assert.equal(detect.match('hello https://evil.test/ https://bücher.example/path').matched, true);
  assert.equal(detect.match('https://evil.test/bücher.example').matched, false);
});

test('disabled configurations and entries produce no decisions', () => {
  assert.equal(matcher([entry(1)], false).match('abc').matched, false);
  assert.equal(matcher([entry(1, { enabled: false })]).match('abc').matched, false);
  assert.deepEqual(matcher([]).match('abc'), {
    matched: false, matched_rule_ids: [], selected_rule_id: null,
    delete_message: false, author_action: null,
  });
});

test('deletion alone produces no author action or client-supplied target', () => {
  assert.deepEqual(matcher([entry(1)]).match('abc abc'), {
    matched: true, matched_rule_ids: [entry(1).id], selected_rule_id: entry(1).id,
    delete_message: true, author_action: null,
  });
});

test('ban outranks timeout while message deletion remains independent', () => {
  const rules = [
    entry(3),
    entry(2, { match_type: 'PHRASE', pattern: 'abc', action: 'DELETE_TIMEOUT', duration_seconds: 60 }),
    entry(1, { match_type: 'PHRASE', pattern: 'abc def', action: 'DELETE_BAN' }),
  ];
  const result = matcher(rules).match('abc def');
  assert.equal(result.selected_rule_id, entry(1).id);
  assert.equal(result.delete_message, true);
  assert.deepEqual(result.author_action, { action: 'BAN' });
  assert.deepEqual(result.matched_rule_ids, rules.map((rule) => rule.id).sort());
  assert.deepEqual(matcher([...rules].reverse()).match('abc def'), result);
});

test('longest timeout wins and ties resolve by canonical ID independently of rule order', () => {
  const rules = [
    entry(3, { action: 'DELETE_TIMEOUT', duration_seconds: 60 }),
    entry(2, { match_type: 'PHRASE', pattern: 'abc def', action: 'DELETE_TIMEOUT', duration_seconds: 300 }),
    entry(1, { match_type: 'PHRASE', pattern: 'def', action: 'DELETE_TIMEOUT', duration_seconds: 300 }),
  ];
  const result = matcher(rules).match('abc def');
  assert.equal(result.selected_rule_id, entry(1).id);
  assert.deepEqual(result.author_action, { action: 'TIMEOUT', duration_seconds: 300 });
  for (const order of [rules, [...rules].reverse(), [rules[1], rules[0], rules[2]]]) {
    assert.deepEqual(matcher(order).match('abc def'), result);
  }
});

test('configuration and returned decisions cannot mutate subsequent matching', () => {
  const config = { schema_version: 1, enabled: true, rules: [entry(1)] };
  const detect = new CustomBlacklistMatcher(config);
  config.rules[0].pattern = 'other';
  config.enabled = false;
  const first = detect.match('abc');
  first.matched_rule_ids.length = 0;
  first.delete_message = false;
  assert.equal(detect.match('abc').matched_rule_ids.length, 1);
  assert.equal(detect.match('abc').delete_message, true);
  assert.equal(detect.match('other').matched, false);
});

test('invalid configurations fail validation rather than silently enabling partial rules', () => {
  assert.throws(() => matcher([entry(1, { match_type: 'REGEX' })]));
  assert.throws(() => matcher([entry(1), entry(2)]));
  assert.throws(() => matcher([entry(1, { action: 'DELETE_TIMEOUT', duration_seconds: 0 })]));
  assert.throws(() => matcher([entry(1, { match_type: 'DOMAIN', pattern: 'https://example.com' })]));
  assert.throws(() => matcher([entry(1, { author_channel_id: 'unverified-author' })]));
  assert.throws(() => matcher([entry(1)]).match(null));
});
