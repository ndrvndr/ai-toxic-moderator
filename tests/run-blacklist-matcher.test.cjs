const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { RunBlacklistMatcher } = source('apps/worker/src/ingestion/run-blacklist-matcher.ts');
const scope = {
  runId: '10000000-0000-4000-8000-000000000001',
  channelId: '20000000-0000-4000-8000-000000000002',
  sessionId: '30000000-0000-4000-8000-000000000003',
};
const blacklistId = '40000000-0000-4000-8000-000000000004';
const ruleId = '50000000-0000-4000-8000-000000000005';
const fallback = { schema_version: 1, enabled: false, rules: [] };
const saved = {
  schema_version: 1,
  enabled: true,
  rules: [
    {
      id: ruleId,
      enabled: true,
      match_type: 'WORD',
      pattern: 'abc',
      action: 'DELETE_TIMEOUT',
      duration_seconds: 60,
    },
  ],
};
function row(overrides = {}) {
  return {
    run_id: scope.runId,
    channel_id: scope.channelId,
    session_id: scope.sessionId,
    blacklist_id: null,
    blacklist_revision: null,
    source: 'DEFAULT',
    configuration: fallback,
    ...overrides,
  };
}
const savedRow = (overrides = {}) =>
  row({
    source: 'SAVED',
    blacklist_id: blacklistId,
    blacklist_revision: 2,
    configuration: saved,
    ...overrides,
  });
const clientFor = (rows) => ({
  async query() {
    return { rows };
  },
});

test('snapshot selection binds run, channel and session using the supplied transaction client', async () => {
  let queries = 0;
  const decision = await new RunBlacklistMatcher().match(
    {
      async query(sql, params) {
        queries++;
        assert.deepEqual(params, [scope.runId, scope.channelId, scope.sessionId]);
        assert.match(sql, /FROM monitoring_blacklist_snapshots snapshot/);
        assert.match(sql, /run.channel_id = snapshot.channel_id/);
        assert.match(sql, /run.session_id = \$3/);
        assert.equal(sql.includes('channel_custom_blacklists'), false);
        assert.equal(sql.includes('ORDER BY'), false);
        return { rows: [savedRow()] };
      },
    },
    scope,
    'ABC',
  );
  assert.equal(queries, 1);
  assert.equal(decision.delete_message, true);
  assert.deepEqual(decision.author_action, { action: 'TIMEOUT', duration_seconds: 60 });
  assert.deepEqual(decision.provenance, {
    run_id: scope.runId,
    channel_id: scope.channelId,
    session_id: scope.sessionId,
    blacklist_id: blacklistId,
    blacklist_revision: 2,
    source: 'SAVED',
    matcher_version: 'blacklist-literal-1',
  });
});

test('default and legacy snapshots remain disabled with explicit provenance', async () => {
  for (const source of ['DEFAULT', 'LEGACY']) {
    const decision = await new RunBlacklistMatcher().match(
      clientFor([row({ source })]),
      scope,
      'abc',
    );
    assert.equal(decision.matched, false);
    assert.equal(decision.delete_message, false);
    assert.equal(decision.author_action, null);
    assert.equal(decision.provenance.source, source);
    assert.equal(decision.provenance.blacklist_revision, null);
  }
});

test('missing or duplicate snapshot rows fail without loading a current policy', async () => {
  for (const rows of [[], [savedRow(), savedRow()]]) {
    await assert.rejects(
      new RunBlacklistMatcher().match(clientFor(rows), scope, 'abc'),
      /no unique blacklist snapshot/,
    );
  }
});

test('mismatched run, channel or session results fail before matching', async () => {
  for (const selected of [
    savedRow({ run_id: scope.channelId }),
    savedRow({ channel_id: scope.sessionId }),
    savedRow({ session_id: scope.runId }),
    savedRow({ session_id: undefined }),
  ])
    await assert.rejects(new RunBlacklistMatcher().match(clientFor([selected]), scope, 'abc'));
});

test('invalid snapshot metadata and configurations are rejected instead of silently falling back', async () => {
  for (const selected of [
    row({ source: 'SAVED' }),
    savedRow({ blacklist_revision: 0 }),
    savedRow({ blacklist_id: null }),
    savedRow({ configuration: {} }),
    row({ source: 'LEGACY', configuration: saved }),
    row({ source: 'DEFAULT', blacklist_id: blacklistId }),
    savedRow({ configuration: { ...saved, rules: [{ ...saved.rules[0], duration_seconds: 0 }] } }),
  ])
    await assert.rejects(new RunBlacklistMatcher().match(clientFor([selected]), scope, 'abc'));
});

test('invalid scope identifiers fail before a database query', async () => {
  let queries = 0;
  const client = {
    async query() {
      queries++;
      return { rows: [savedRow()] };
    },
  };
  for (const field of ['runId', 'channelId', 'sessionId']) {
    await assert.rejects(
      new RunBlacklistMatcher().match(client, { ...scope, [field]: 'invalid' }, 'abc'),
    );
  }
  assert.equal(queries, 0);
});

test('uppercase identifiers are canonicalized before querying and recording provenance', async () => {
  const selectedScope = { ...scope, runId: 'abcdefab-0000-4000-8000-000000000001' };
  const decision = await new RunBlacklistMatcher().match(
    {
      async query(_sql, params) {
        assert.equal(params[0], selectedScope.runId);
        return { rows: [savedRow({ run_id: selectedScope.runId })] };
      },
    },
    { ...selectedScope, runId: selectedScope.runId.toUpperCase() },
    'abc',
  );
  assert.equal(decision.provenance.run_id, selectedScope.runId);
});

test('replay uses the original run snapshot while a new run can select a new revision', async () => {
  const nextRun = '10000000-0000-4000-8000-000000000006';
  const nextConfiguration = {
    schema_version: 1,
    enabled: true,
    rules: [
      {
        id: ruleId,
        enabled: true,
        match_type: 'WORD',
        pattern: 'abc',
        action: 'DELETE_BAN',
      },
    ],
  };
  const client = {
    async query(_sql, params) {
      return {
        rows: [
          params[0] === scope.runId
            ? savedRow()
            : savedRow({
                run_id: nextRun,
                blacklist_revision: 3,
                configuration: nextConfiguration,
              }),
        ],
      };
    },
  };
  const reader = new RunBlacklistMatcher();
  const original = await reader.match(client, scope, 'abc');
  const newer = await reader.match(client, { ...scope, runId: nextRun }, 'abc');
  assert.deepEqual(newer.author_action, { action: 'BAN' });
  assert.equal(newer.provenance.blacklist_revision, 3);
  assert.deepEqual(await reader.match(client, scope, 'abc'), original);
});

test('resolved matchers retain the captured configuration and do not cache another run', async () => {
  const selected = savedRow();
  const resolved = await new RunBlacklistMatcher().resolve(clientFor([selected]), scope);
  selected.configuration = fallback;
  assert.equal(resolved.matcher.match('abc').matched, true);
  assert.equal(resolved.provenance.blacklist_revision, 2);
  const disabled = await new RunBlacklistMatcher().match(clientFor([row()]), scope, 'abc');
  assert.equal(disabled.matched, false);
});
