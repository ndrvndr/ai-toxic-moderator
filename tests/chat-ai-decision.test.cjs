const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { source } = require('./helpers/source.cjs');
const { AiActionPlanner, BlacklistActionPlanner } = source('packages/moderation-core/src/index.ts');
const { chatAiDecision, chatObservation } = source('packages/contracts/src/index.ts');
const { summarizeChatAiDecision } = source('apps/api/src/chat/chat-ai-decision.ts');

const context = {
  channel_id: randomUUID(),
  session_id: randomUUID(),
  run_id: randomUUID(),
  classification_id: randomUUID(),
  observation_id: randomUUID(),
  external_message_id: 'message-1',
  author_channel_id: `UC${'a'.repeat(22)}`,
};
const model = {
  model_id: 'test/model',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
const snapshot = {
  run_id: context.run_id,
  channel_id: context.channel_id,
  source: 'SAVED',
  settings_id: randomUUID(),
  settings_revision: 3,
  configuration: {
    schema_version: 1,
    automatic_actions_enabled: true,
    model,
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: true, threshold: 0.4 },
    timeout: { enabled: true, threshold: 0.6, duration_seconds: 60 },
    ban: { enabled: true, threshold: 0.9 },
  },
};
const output = {
  channel_id: context.channel_id,
  session_id: context.session_id,
  run_id: context.run_id,
  observation_id: context.observation_id,
  ...model,
  status: 'SUCCEEDED',
  rating: 2,
  severity_score: 0.7,
  truncated: false,
  inference_ms: 6,
  error_code: null,
};
const scope = {
  channelId: context.channel_id,
  sessionId: context.session_id,
  runId: context.run_id,
  observationId: context.observation_id,
  externalMessageId: context.external_message_id,
  authorChannelId: context.author_channel_id,
};
const active = { builtInPriority: false, plansCreated: false, runActive: true };
function record({ captured = snapshot, result = output, input = context, match = false } = {}) {
  const { observation_id, ...blacklistInput } = input;
  const blacklist = new BlacklistActionPlanner({
    run_id: input.run_id,
    channel_id: input.channel_id,
    source: match ? 'SAVED' : 'DEFAULT',
    blacklist_id: match ? randomUUID() : null,
    blacklist_revision: match ? 1 : null,
    configuration: {
      schema_version: 1,
      enabled: match,
      rules: match
        ? [
            {
              id: randomUUID(),
              enabled: true,
              pattern: 'abc',
              match_type: 'WORD',
              action: 'DELETE',
            },
          ]
        : [],
    },
  }).plan(blacklistInput, 'abc');
  return {
    id: randomUUID(),
    model_result_id:
      result && typeof result === 'object' && 'status' in result ? randomUUID() : null,
    decision: new AiActionPlanner(captured).plan(input, result, blacklist),
    blacklist,
    created_at: '2026-10-04T00:00:00Z',
  };
}

test('missing audits remain absent rather than implying pending or safe decisions', () => {
  for (const absent of [null, undefined])
    assert.equal(summarizeChatAiDecision(absent, scope, active), null);
});

test('public evidence distinguishes selected policy, materialization, and suppression', () => {
  const stored = record();
  for (const [state, expected] of [
    [active, 'AWAITING_PLANS'],
    [{ ...active, plansCreated: true }, 'PLANS_CREATED'],
    [{ ...active, runActive: false }, 'RUN_INACTIVE'],
    [{ ...active, plansCreated: true, runActive: false }, 'PLANS_CREATED'],
    [{ ...active, builtInPriority: true, plansCreated: true }, 'BUILT_IN_PRIORITY'],
  ]) {
    const summary = summarizeChatAiDecision(stored, scope, state);
    assert.equal(summary.planning_status, expected);
    assert.equal(summary.selected_tier, 'TIMEOUT');
    assert.equal(summary.selected_threshold, 0.6);
    assert.equal(summary.timeout_duration_seconds, 60);
    assert.equal(summary.severity_score, 0.7);
    assert.deepEqual(summary.result_model, model);
    assert.equal(summary.settings_revision, 3);
    for (const key of [
      'id',
      'model_result_id',
      'context',
      'plans',
      'configuration',
      'blacklist',
      'status',
    ])
      assert.equal(key in summary, false, key);
  }
});

test('skipped policy and unavailable output retain explicit reasons without invented scores', () => {
  const cases = [
    [
      {
        captured: {
          ...snapshot,
          source: 'DEFAULT',
          settings_id: null,
          settings_revision: null,
          configuration: null,
        },
      },
      'NO_SAVED_POLICY',
    ],
    [
      {
        captured: {
          ...snapshot,
          configuration: { ...snapshot.configuration, automatic_actions_enabled: false },
        },
      },
      'AI_DISABLED',
    ],
    [{ result: null }, 'OUTPUT_MISSING'],
    [{ result: {} }, 'OUTPUT_INVALID'],
    [{ match: true }, 'BLACKLIST_MATCH'],
    [{ result: { ...output, severity_score: 0.2 } }, 'NO_THRESHOLD_MET'],
    [{ result: { ...output, model_revision: 'b'.repeat(40) } }, 'MODEL_MISMATCH'],
    [{ result: { ...output, truncated: true } }, 'INPUT_TRUNCATED'],
    [
      {
        result: {
          ...output,
          status: 'ERROR',
          rating: null,
          severity_score: null,
          truncated: null,
          inference_ms: null,
          error_code: 'INFERENCE_TIMEOUT',
        },
      },
      'INFERENCE_ERROR',
    ],
  ];
  for (const [options, reason] of cases) {
    const summary = summarizeChatAiDecision(record(options), scope, active);
    assert.equal(summary.reason_code, reason);
    assert.equal(summary.planning_status, 'NOT_SELECTED');
    assert.equal(summary.selected_tier, null);
    if (
      [
        'NO_SAVED_POLICY',
        'AI_DISABLED',
        'OUTPUT_MISSING',
        'OUTPUT_INVALID',
        'BLACKLIST_MATCH',
      ].includes(reason)
    ) {
      assert.equal(summary.result_model, null);
      assert.equal(summary.severity_score, null);
    }
  }
});

test('another channel, session, run, observation, message, or author cannot supply provenance', () => {
  for (const key of Object.keys(scope))
    assert.throws(
      () => summarizeChatAiDecision(record(), { ...scope, [key]: randomUUID() }, active),
      /scope/,
    );
  assert.throws(() => summarizeChatAiDecision(record(), scope, { ...active, plansCreated: null }));
});

test('selected tiers and unavailable targets are preserved without fabricating execution', () => {
  for (const [score, tier] of [
    [0.5, 'DELETE'],
    [0.7, 'TIMEOUT'],
    [0.95, 'BAN'],
  ]) {
    const summary = summarizeChatAiDecision(
      record({ result: { ...output, severity_score: score } }),
      scope,
      active,
    );
    assert.equal(summary.selected_tier, tier);
    assert.equal(summary.timeout_duration_seconds, tier === 'TIMEOUT' ? 60 : null);
  }
  const stored = record({ input: { ...context, author_channel_id: null } });
  assert.equal(
    summarizeChatAiDecision(stored, { ...scope, authorChannelId: null }, active)
      .author_action_status,
    'TARGET_UNAVAILABLE',
  );
});

test('the public contract rejects inconsistent selection and does not overwrite baseline outcomes', () => {
  const summary = summarizeChatAiDecision(record(), scope, active);
  for (const change of [
    { selected_tier: null },
    { planning_status: 'NOT_SELECTED' },
    { settings_revision: null },
    { severity_score: 0.1 },
    { result_model: { ...model, model_revision: 'b'.repeat(40) } },
    { timeout_duration_seconds: null },
    { author_action_status: 'NOT_SELECTED' },
    { status: 'SUCCEEDED' },
  ])
    assert.equal(chatAiDecision.safeParse({ ...summary, ...change }).success, false);
  const message = {
    id: context.observation_id,
    external_message_id: context.external_message_id,
    event_type: 'textMessageEvent',
    published_at: '2026-10-04T00:00:00Z',
    received_at: '2026-10-04T00:00:00Z',
    display_text: 'hello',
    author_channel_id: context.author_channel_id,
    author_display_name: 'Viewer',
    evaluation_status: 'ALLOW',
    evaluation: null,
    ai_decision: summary,
  };
  assert.equal(chatObservation.parse(message).evaluation_status, 'ALLOW');
  assert.equal(
    chatObservation.safeParse({ ...message, event_type: 'userBannedEvent' }).success,
    false,
  );
  assert.equal(chatObservation.safeParse({ ...message, ai_decision: undefined }).success, true);
});
