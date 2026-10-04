import type {
  AiShadowErrorCode,
  AiShadowSummary,
  ChatObservation,
  MonitoringRun,
  SavedSession,
} from '@moderator/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatAiShadow } from '../features/live/components/chat-ai-shadow.js';
import { ChatMessage } from '../features/live/components/chat-message.js';
import { LiveChatPanel } from '../features/live/components/live-chat-panel.js';
import { SavedSessionViewer } from '../features/live/components/saved-session-viewer.js';

const mocks = vi.hoisted(() => ({ chat: vi.fn(), monitoring: vi.fn(), events: vi.fn() }));
vi.mock('../features/live/hooks/use-live-chat.js', () => ({ useLiveChat: mocks.chat }));
vi.mock('../features/live/hooks/use-monitoring.js', () => ({ useMonitoring: mocks.monitoring }));
vi.mock('../features/live/hooks/use-live-events.js', () => ({ useLiveEvents: mocks.events }));

const success: Extract<AiShadowSummary, { status: 'SUCCEEDED' }> = {
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
  status: 'SUCCEEDED',
  rating: 2,
  severity_score: 0.56,
  truncated: false,
  inference_ms: 5,
  error_code: null,
};

function failure(code: AiShadowErrorCode = 'INFERENCE_TIMEOUT'): AiShadowSummary {
  return {
    ...success,
    status: 'ERROR',
    rating: null,
    severity_score: null,
    truncated: null,
    inference_ms: null,
    error_code: code,
  };
}

const message: ChatObservation = {
  id: '10000000-0000-4000-8000-000000000001',
  external_message_id: 'shadow-fixture-message',
  event_type: 'textMessageEvent',
  published_at: '2026-10-03T00:00:00Z',
  received_at: '2026-10-03T00:00:01Z',
  display_text: 'Original viewer message',
  author_channel_id: 'fixture-viewer',
  author_display_name: 'Fixture viewer',
  evaluation_status: 'ALLOW',
  evaluation: {
    outcome: 'ALLOW',
    primary_category: null,
    severity: 0,
    reason_code: 'NO_RULE_MATCH',
    reason: 'No configured rule matched this message.',
    classifier_version: 'fixture-rules',
    policy_version: 'fixture-policy',
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
  requested_at: '2026-10-03T00:00:00Z',
  started_at: null,
  stop_requested_at: '2026-10-03T00:00:02Z',
  finished_at: '2026-10-03T00:00:02Z',
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

describe('AI shadow presentation', () => {
  it.each([undefined, null])('does not imply pending or safe output when absent (%s)', (result) => {
    const view = render(createElement(ChatAiShadow, { result }));
    expect(view.container.childElementCount).toBe(0);
  });

  it.each([
    [0, 'Safe'],
    [2, 'Abusive'],
    [3, 'Hate'],
    [4, 'Severe'],
  ] as const)('shows model rating %s separately from an application decision', (rating, label) => {
    render(createElement(ChatAiShadow, { result: { ...success, rating } }));
    const panel = within(screen.getByRole('group', { name: 'AI shadow result' }));
    expect(panel.getByText(`Model rating: ${label} (${rating}/4)`)).toBeTruthy();
    expect(panel.getByText('Expected severity: 0.5600 / 1')).toBeTruthy();
    expect(panel.getByText(/not the probability of a policy violation/)).toBeTruthy();
    expect(panel.getByText(/This is not an execution result/)).toBeTruthy();
    expect(panel.queryByText('Allowed')).toBeNull();
    expect(panel.queryByText('Flagged')).toBeNull();
  });

  it('exposes full model provenance and records truncation without implying full-message coverage', () => {
    render(createElement(ChatAiShadow, { result: { ...success, truncated: true } }));
    expect(screen.getByText(/did not evaluate the full message/)).toBeTruthy();
    const details = screen.getByText('Model details').closest('details');
    expect(details).not.toBeNull();
    const metadata = within(details!);
    expect(metadata.getByText(success.model_id)).toBeTruthy();
    expect(metadata.getByText(success.model_revision)).toBeTruthy();
    expect(metadata.getByText('INT8')).toBeTruthy();
    expect(metadata.getByText('laskar-shadow-1')).toBeTruthy();
    expect(metadata.getByText('5.0 ms')).toBeTruthy();
    expect(metadata.getByText(/revision may differ/)).toBeTruthy();
  });

  const errors: Array<[AiShadowErrorCode, RegExp]> = [
    ['MODEL_UNAVAILABLE', /model was unavailable/],
    ['INFERENCE_FAILED', /did not produce a usable result/],
    ['INFERENCE_TIMEOUT', /exceeded its deadline/],
    ['INVALID_OUTPUT', /response failed validation/],
    ['INPUT_TOO_LONG', /exceeded the inference input limit/],
  ];
  it.each(errors)('explains %s without a fabricated rating or score', (code, description) => {
    render(createElement(ChatAiShadow, { result: failure(code) }));
    const panel = within(screen.getByRole('group', { name: 'AI shadow result' }));
    expect(panel.getByText('AI result unavailable')).toBeTruthy();
    expect(panel.getByText(description)).toBeTruthy();
    expect(panel.getByText(/No model rating is available/)).toBeTruthy();
    expect(panel.getByText(code)).toBeTruthy();
    expect(panel.queryByText(/Model rating:/)).toBeNull();
    expect(panel.queryByText(/Expected severity:/)).toBeNull();
    expect(panel.queryByText(/ ms$/)).toBeNull();
    expect(panel.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('updates shadow output without changing the message or existing moderation results', () => {
    const original: ChatObservation = {
      ...message,
      deletion: { action: 'DELETE', status: 'SUCCEEDED' },
      author_action: { action: 'TIMEOUT', status: 'UNKNOWN', duration_seconds: 30 },
    };
    const view = render(createElement(ChatMessage, { message: original }));
    expect(screen.queryByRole('group', { name: 'AI shadow result' })).toBeNull();
    view.rerender(createElement(ChatMessage, { message: { ...original, ai_shadow: success } }));
    expect(screen.getByText('Model rating: Abusive (2/4)')).toBeTruthy();
    view.rerender(createElement(ChatMessage, { message: { ...original, ai_shadow: failure() } }));
    expect(screen.queryByText('Model rating: Abusive (2/4)')).toBeNull();
    expect(screen.getByText('AI result unavailable')).toBeTruthy();
    expect(screen.getByText('Original viewer message')).toBeTruthy();
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByText('Timeout outcome unknown')).toBeTruthy();
  });
});

describe('shared Live and History chat display', () => {
  it.each(['Live', 'History'] as const)('renders and updates AI output in %s chat', (page) => {
    const setChat = (result: AiShadowSummary | null) =>
      mocks.chat.mockReturnValue({
        data: { pages: [{ items: [{ ...message, ai_shadow: result }], next_cursor: null }] },
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
    expect(screen.queryByRole('group', { name: 'AI shadow result' })).toBeNull();
    setChat(success);
    view.rerender(element());
    expect(screen.getByText('Model rating: Abusive (2/4)')).toBeTruthy();
    const messageItem = within(screen.getByRole('listitem'));
    expect(messageItem.getByText('Allowed')).toBeTruthy();
    setChat(failure());
    view.rerender(element());
    expect(screen.getByText('AI result unavailable')).toBeTruthy();
    expect(screen.queryByText('Model rating: Abusive (2/4)')).toBeNull();
    expect(screen.getByText('Original viewer message')).toBeTruthy();
  });
});
