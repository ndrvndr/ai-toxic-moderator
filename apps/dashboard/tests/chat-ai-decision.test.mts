import type {
  ChatAiDecision,
  ChatObservation,
  MonitoringRun,
  SavedSession,
} from '@moderator/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatAiDecision as DecisionPanel } from '../features/live/components/chat-ai-decision.js';
import { ChatMessage } from '../features/live/components/chat-message.js';
import { LiveChatPanel } from '../features/live/components/live-chat-panel.js';
import { SavedSessionViewer } from '../features/live/components/saved-session-viewer.js';

const mocks = vi.hoisted(() => ({ chat: vi.fn(), monitoring: vi.fn(), events: vi.fn() }));
vi.mock('../features/live/hooks/use-live-chat.js', () => ({ useLiveChat: mocks.chat }));
vi.mock('../features/live/hooks/use-monitoring.js', () => ({ useMonitoring: mocks.monitoring }));
vi.mock('../features/live/hooks/use-live-events.js', () => ({ useLiveEvents: mocks.events }));
const model = {
  model_id: 'test/model',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8' as const,
  adapter_version: 'laskar-shadow-1',
};
const decision: ChatAiDecision = {
  planner_version: 'ai-threshold-1',
  policy_source: 'SAVED',
  settings_revision: 3,
  policy_model: model,
  result_model: model,
  severity_score: 0.7,
  reason_code: 'THRESHOLD_MET',
  selected_tier: 'TIMEOUT',
  selected_threshold: 0.6,
  author_action_status: 'PLANNED',
  timeout_duration_seconds: 60,
  planning_status: 'AWAITING_PLANS',
  decided_at: '2026-10-04T00:00:00Z',
};
const message: ChatObservation = {
  id: '10000000-0000-4000-8000-000000000001',
  external_message_id: 'fixture-message',
  event_type: 'textMessageEvent',
  published_at: '2026-10-04T00:00:00Z',
  received_at: '2026-10-04T00:00:01Z',
  display_text: 'Original message',
  author_channel_id: 'fixture-viewer',
  author_display_name: 'Viewer',
  evaluation_status: 'ALLOW',
  evaluation: {
    outcome: 'ALLOW',
    primary_category: null,
    severity: 0,
    reason_code: 'NO_RULE_MATCH',
    reason: 'No configured rule matched this message.',
    classifier_version: 'fixture-rules',
    policy_version: 'policy-1',
  },
  deletion: null,
  author_action: null,
};
const run: MonitoringRun = {
  id: '40000000-0000-4000-8000-000000000004',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  youtube_broadcast_id: 'fixture-broadcast',
  status: 'STOPPED',
  requested_at: '2026-10-04T00:00:00Z',
  started_at: null,
  stop_requested_at: '2026-10-04T00:00:02Z',
  finished_at: '2026-10-04T00:00:02Z',
  last_error_code: null,
};
const saved: SavedSession = {
  session_id: run.session_id,
  channel_id: run.channel_id,
  youtube_broadcast_id: run.youtube_broadcast_id,
  title: 'Fixture livestream',
  created_at: run.requested_at,
  latest_status: 'STOPPED',
};
const accountId = '50000000-0000-4000-8000-000000000005';
beforeEach(() => {
  mocks.chat.mockReset();
  mocks.monitoring.mockReturnValue({
    monitoring: { isPending: false, isError: false, isFetching: false, data: { run } },
  });
  mocks.events.mockReturnValue('connected');
});
afterEach(cleanup);

it.each([null, undefined])(
  'hides absent AI decisions without implying pending evaluation (%s)',
  (value) => {
    const view = render(createElement(DecisionPanel, { decision: value }));
    expect(view.container.childElementCount).toBe(0);
  },
);

it.each([
  ['AWAITING_PLANS', 'AI plans pending'],
  ['PLANS_CREATED', 'AI plans ready'],
  ['BUILT_IN_PRIORITY', 'AI action suppressed'],
  ['RUN_INACTIVE', 'Run inactive'],
] as const)('separates %s planning from provider confirmation', (status, label) => {
  render(createElement(DecisionPanel, { decision: { ...decision, planning_status: status } }));
  const panel = within(screen.getByRole('group', { name: 'AI moderation decision' }));
  expect(panel.getByText(label)).toBeTruthy();
  expect(panel.getByText(/Selected tier: Timeout/)).toBeTruthy();
  expect(panel.getByText(/Captured threshold: 0.6000/)).toBeTruthy();
  expect(panel.getByText(/Requested timeout: 60 seconds/)).toBeTruthy();
  expect(panel.getByText(/not a probability/)).toBeTruthy();
  expect(panel.getByText(/does not confirm execution/)).toBeTruthy();
  expect(panel.queryByText('Timeout confirmed')).toBeNull();
  expect(panel.queryByRole('button')).toBeNull();
});

it.each([
  ['BLACKLIST_MATCH', /captured blacklist matched/],
  ['NO_SAVED_POLICY', /no saved AI/],
  ['AI_DISABLED', /disabled in the captured settings/],
  ['OUTPUT_MISSING', /No model output/],
  ['OUTPUT_INVALID', /output was invalid/],
  ['MODEL_MISMATCH', /does not match the model/],
  ['INFERENCE_ERROR', /inference failed/],
  ['INPUT_TRUNCATED', /part of the message/],
  ['NO_THRESHOLD_MET', /did not meet an enabled/],
] as const)(
  'explains %s without presenting a selected action or a safe verdict',
  (reason, text) => {
    render(
      createElement(DecisionPanel, {
        decision: {
          ...decision,
          reason_code: reason,
          selected_tier: null,
          selected_threshold: null,
          author_action_status: 'NOT_SELECTED',
          timeout_duration_seconds: null,
          planning_status: 'NOT_SELECTED',
          result_model: null,
          severity_score: null,
        },
      }),
    );
    const panel = within(screen.getByRole('group', { name: 'AI moderation decision' }));
    expect(panel.getByText(text)).toBeTruthy();
    expect(panel.getByText('No AI action selected')).toBeTruthy();
    expect(panel.queryByText('Allowed')).toBeNull();
    expect(panel.queryByText(/Selected tier:/)).toBeNull();
    expect(panel.queryByText(/Considered severity:/)).toBeNull();
  },
);

it('explains unavailable targets and keeps captured evidence separate from latest model output', () => {
  render(
    createElement(ChatMessage, {
      message: {
        ...message,
        ai_decision: { ...decision, author_action_status: 'TARGET_UNAVAILABLE' },
        ai_shadow: {
          ...model,
          model_revision: 'b'.repeat(40),
          status: 'SUCCEEDED',
          rating: 4,
          severity_score: 0.99,
          truncated: false,
          inference_ms: 5,
          error_code: null,
        },
        deletion: { action: 'DELETE', status: 'SUCCEEDED' },
        author_action: { action: 'TIMEOUT', status: 'UNKNOWN', duration_seconds: 60 },
      },
    }),
  );
  const panel = within(screen.getByRole('group', { name: 'AI moderation decision' }));
  expect(panel.getByText(/Only message deletion was planned/)).toBeTruthy();
  expect(panel.getByText(/Considered severity: 0.7000/)).toBeTruthy();
  expect(panel.getByText('Revision 3')).toBeTruthy();
  expect(panel.getAllByText('a'.repeat(40))).toHaveLength(2);
  expect(panel.queryByText('b'.repeat(40))).toBeNull();
  expect(screen.getByText('Expected severity: 0.9900 / 1')).toBeTruthy();
  expect(screen.getByText('Allowed')).toBeTruthy();
  expect(screen.getByText('Deleted')).toBeTruthy();
  expect(screen.getByText('Timeout outcome unknown')).toBeTruthy();
});

it.each(['Live', 'History'] as const)(
  'updates saved AI planning evidence in shared %s chat',
  (page) => {
    const setChat = (value: ChatAiDecision | null) =>
      mocks.chat.mockReturnValue({
        data: { pages: [{ items: [{ ...message, ai_decision: value }], next_cursor: null }] },
        isPending: false,
        isError: false,
        isSuccess: true,
        isFetching: false,
        isRefetching: false,
        hasNextPage: false,
      });
    const element = () =>
      page === 'Live'
        ? createElement(LiveChatPanel, { accountId, run, connectionStatus: 'connected' })
        : createElement(SavedSessionViewer, { accountId, session: saved });
    setChat(null);
    const view = render(element());
    expect(screen.queryByRole('group', { name: 'AI moderation decision' })).toBeNull();
    for (const [status, label] of [
      ['AWAITING_PLANS', 'AI plans pending'],
      ['PLANS_CREATED', 'AI plans ready'],
      ['BUILT_IN_PRIORITY', 'AI action suppressed'],
    ] as const) {
      setChat({ ...decision, planning_status: status });
      view.rerender(element());
      expect(screen.getByText(label)).toBeTruthy();
      expect(within(screen.getByRole('listitem')).getByText('Allowed')).toBeTruthy();
    }
  },
);
