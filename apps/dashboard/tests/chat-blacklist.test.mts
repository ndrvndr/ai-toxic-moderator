import {
  chatBlacklistDecision,
  chatObservation,
  type ChatBlacklistDecision,
  type ChatObservation,
  type MonitoringRun,
  type SavedSession,
} from '@moderator/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { summarizeChatBlacklist } from '../../api/src/chat/chat-blacklist.js';
import { ChatBlacklist } from '../features/live/components/chat-blacklist.js';
import { ChatMessage } from '../features/live/components/chat-message.js';
import { LiveChatPanel } from '../features/live/components/live-chat-panel.js';
import { SavedSessionViewer } from '../features/live/components/saved-session-viewer.js';

const mocks = vi.hoisted(() => ({ chat: vi.fn(), monitoring: vi.fn(), events: vi.fn() }));
vi.mock('../features/live/hooks/use-live-chat.js', () => ({ useLiveChat: mocks.chat }));
vi.mock('../features/live/hooks/use-monitoring.js', () => ({ useMonitoring: mocks.monitoring }));
vi.mock('../features/live/hooks/use-live-events.js', () => ({ useLiveEvents: mocks.events }));

const decision: ChatBlacklistDecision = {
  run_id: '40000000-0000-4000-8000-000000000004',
  blacklist_id: '50000000-0000-4000-8000-000000000005',
  blacklist_revision: 1,
  source: 'SAVED',
  matcher_version: 'blacklist-literal-1',
  matched_rule_ids: ['60000000-0000-4000-8000-000000000006'],
  selected_entry: {
    id: '60000000-0000-4000-8000-000000000006',
    enabled: true,
    match_type: 'WORD',
    pattern: 'abc',
    action: 'DELETE_TIMEOUT',
    duration_seconds: 30,
  },
  author_action_status: 'PLANNED',
};
const message: ChatObservation = {
  id: '10000000-0000-4000-8000-000000000001',
  external_message_id: 'fixture-message',
  event_type: 'textMessageEvent',
  published_at: '2026-10-04T00:00:00Z',
  received_at: '2026-10-04T00:00:01Z',
  display_text: 'abc',
  author_channel_id: 'fixture-viewer',
  author_display_name: 'Fixture viewer',
  evaluation_status: 'ACTION_REQUIRED',
  evaluation: {
    outcome: 'ACTION_REQUIRED',
    primary_category: null,
    severity: null,
    reason_code: 'BLACKLIST_MATCH',
    reason: 'A captured blacklist entry matched.',
    classifier_version: 'rules-blacklist-1',
    policy_version: 'policy-1',
  },
  blacklist: decision,
  deletion: { action: 'DELETE', status: 'UNKNOWN' },
  author_action: { action: 'TIMEOUT', status: 'UNKNOWN', duration_seconds: 30 },
};
const run: MonitoringRun = {
  id: decision.run_id,
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  youtube_broadcast_id: 'fixture-broadcast',
  status: 'STOPPED',
  requested_at: message.published_at,
  started_at: null,
  stop_requested_at: message.received_at,
  finished_at: message.received_at,
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
const accountId = '70000000-0000-4000-8000-000000000007';

beforeEach(() => {
  mocks.chat.mockReset();
  mocks.monitoring.mockReturnValue({
    monitoring: { isPending: false, isError: false, isFetching: false, data: { run } },
  });
  mocks.events.mockReturnValue('connected');
});
afterEach(cleanup);

it('API summary validates captured scope and never exposes the full bundle or configuration', () => {
  const classificationId = '90000000-0000-4000-8000-000000000009';
  const policyVersion = `blacklist-blacklist-literal-1-${run.id}`;
  const scope = {
    channelId: run.channel_id,
    sessionId: run.session_id,
    classificationId,
    runId: run.id,
    reasonCode: 'BLACKLIST_MATCH',
  };
  const entry = {
    id: decision.selected_entry.id,
    enabled: true,
    match_type: decision.selected_entry.match_type,
    pattern: decision.selected_entry.pattern,
    action: 'DELETE' as const,
  };
  const snapshot = {
    run_id: run.id,
    channel_id: run.channel_id,
    blacklist_id: decision.blacklist_id,
    blacklist_revision: 1,
    source: 'SAVED',
    configuration: { schema_version: 1, enabled: true, rules: [entry] },
  };
  const bundle = {
    schema_version: 1,
    run_id: run.id,
    channel_id: run.channel_id,
    session_id: run.session_id,
    classification_id: classificationId,
    policy_version: policyVersion,
    matcher_version: decision.matcher_version,
    blacklist_id: decision.blacklist_id,
    blacklist_revision: 1,
    source: 'SAVED',
    matched_rule_ids: decision.matched_rule_ids,
    selected_rule_id: entry.id,
    selected_action: 'DELETE',
    duration_seconds: null,
    author_action_status: 'NOT_SELECTED',
    plans: [
      {
        classification_id: classificationId,
        channel_id: run.channel_id,
        session_id: run.session_id,
        policy_version: `${policyVersion}:message`,
        action: 'DELETE',
        reason: 'Captured policy.',
        external_message_id: message.external_message_id,
      },
    ],
  };
  const expected = { ...decision, selected_entry: entry, author_action_status: 'NOT_SELECTED' };
  expect(summarizeChatBlacklist(bundle, snapshot, scope)).toEqual(expected);
  expect(summarizeChatBlacklist(null, null, scope)).toBeNull();
  for (const invalidScope of [
    { ...scope, channelId: accountId },
    { ...scope, sessionId: accountId },
    { ...scope, classificationId: accountId },
    { ...scope, runId: accountId },
    { ...scope, reasonCode: 'NO_RULE_MATCH' },
  ])
    expect(() => summarizeChatBlacklist(bundle, snapshot, invalidScope)).toThrow();
  for (const invalidSnapshot of [
    null,
    { ...snapshot, blacklist_revision: 2 },
    { ...snapshot, run_id: accountId },
    { ...snapshot, configuration: { ...snapshot.configuration, enabled: false } },
    { ...snapshot, configuration: { ...snapshot.configuration, rules: [] } },
    {
      ...snapshot,
      configuration: { ...snapshot.configuration, rules: [{ ...entry, action: 'DELETE_BAN' }] },
    },
  ])
    expect(() => summarizeChatBlacklist(bundle, invalidSnapshot, scope)).toThrow();
});

describe('captured blacklist presentation', () => {
  it.each([null, undefined])('does not invent provenance when absent (%s)', (value) => {
    const view = render(createElement(ChatBlacklist, { decision: value }));
    expect(view.container.childElementCount).toBe(0);
  });

  it('separates streamer policy from execution outcomes and model severity', () => {
    render(createElement(ChatMessage, { message }));
    const panel = within(screen.getByRole('group', { name: 'Blacklist decision' }));
    expect(panel.getByText('Custom blacklist · Streamer policy')).toBeTruthy();
    expect(
      panel.getByText('Configured action: Delete message and timeout author for 30 seconds'),
    ).toBeTruthy();
    expect(panel.getByText(/Provider results are shown separately/)).toBeTruthy();
    expect(panel.queryByText(/confirmed/i)).toBeNull();
    expect(panel.queryByText(/Severity:/)).toBeNull();
    expect(screen.getByText('Timeout outcome unknown')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'AI shadow result' })).toBeNull();
    expect(panel.getByText(decision.blacklist_id)).toBeTruthy();
    expect(panel.getByText(decision.run_id)).toBeTruthy();
  });

  it.each([
    [
      { ...decision.selected_entry, action: 'DELETE', duration_seconds: undefined },
      'NOT_SELECTED',
      'Configured action: Delete message',
    ],
    [
      { ...decision.selected_entry, action: 'DELETE_BAN', duration_seconds: undefined },
      'PLANNED',
      'Configured action: Delete message and permanently ban author',
    ],
  ] as const)('describes configured %s without asserting execution', (entry, status, label) => {
    // Construct strict entries without an irrelevant timeout field.
    const { duration_seconds: _duration, ...selected_entry } = entry;
    render(
      createElement(ChatBlacklist, {
        decision: chatBlacklistDecision.parse({
          ...decision,
          selected_entry,
          author_action_status: status,
        }),
      }),
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/confirmed/i)).toBeNull();
  });

  it('explains unavailable author targets while preserving the deletion policy', () => {
    render(
      createElement(ChatBlacklist, {
        decision: { ...decision, author_action_status: 'TARGET_UNAVAILABLE' },
      }),
    );
    expect(screen.getByText(/No author action was planned/)).toBeTruthy();
    expect(screen.getByText(/deletion plan is retained/)).toBeTruthy();
  });

  it('renders literal markup as text and shows all matched IDs', () => {
    const second = '80000000-0000-4000-8000-000000000008';
    const literal = '<img src=x onerror=alert(1)>';
    const view = render(
      createElement(ChatBlacklist, {
        decision: {
          ...decision,
          matched_rule_ids: [...decision.matched_rule_ids, second],
          selected_entry: { ...decision.selected_entry, match_type: 'PHRASE', pattern: literal },
        },
      }),
    );
    expect(screen.getByText(literal)).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText(`${decision.selected_entry.id}, ${second}`)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('validates selected entries, match IDs and author planning status', () => {
    expect(chatBlacklistDecision.safeParse(decision).success).toBe(true);
    for (const value of [
      { ...decision, matched_rule_ids: [] },
      {
        ...decision,
        matched_rule_ids: [...decision.matched_rule_ids, ...decision.matched_rule_ids],
      },
      { ...decision, selected_entry: { ...decision.selected_entry, enabled: false } },
      { ...decision, author_action_status: 'NOT_SELECTED' },
      { ...decision, source: 'DEFAULT' },
      { ...decision, blacklist_revision: 0 },
      { ...decision, provider_status: 'SUCCEEDED' },
    ])
      expect(chatBlacklistDecision.safeParse(value).success).toBe(false);
    expect(chatObservation.safeParse({ ...message, blacklist: undefined }).success).toBe(true);
    expect(chatObservation.safeParse({ ...message, evaluation: null }).success).toBe(false);
    expect(chatObservation.safeParse({ ...message, evaluation_status: 'ALLOW' }).success).toBe(
      false,
    );
    expect(
      chatObservation.safeParse({
        ...message,
        evaluation: { ...message.evaluation!, reason_code: 'NO_RULE_MATCH' },
      }).success,
    ).toBe(false);
  });
});

it.each(['Live', 'History'] as const)(
  'renders and updates captured blacklist provenance in %s chat',
  (page) => {
    const setChat = (blacklist: ChatBlacklistDecision | null) =>
      mocks.chat.mockReturnValue({
        data: { pages: [{ items: [{ ...message, blacklist }], next_cursor: null }] },
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
    expect(screen.queryByRole('group', { name: 'Blacklist decision' })).toBeNull();
    setChat(decision);
    view.rerender(element());
    expect(screen.getByRole('group', { name: 'Blacklist decision' })).toBeTruthy();
    expect(within(screen.getByRole('listitem')).getByText('Timeout outcome unknown')).toBeTruthy();
    setChat(null);
    view.rerender(element());
    expect(screen.queryByRole('group', { name: 'Blacklist decision' })).toBeNull();
  },
);
