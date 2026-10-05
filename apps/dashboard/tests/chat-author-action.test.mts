import {
  chatAuthorAction,
  type ChatAuthorAction as AuthorAction,
  type ChatObservation,
} from '@moderator/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatAuthorAction } from '../features/live/components/chat-author-action.js';
import { ChatMessage } from '../features/live/components/chat-message.js';

afterEach(cleanup);

function makeAction(action: AuthorAction['action'], status: AuthorAction['status']): AuthorAction {
  return action === 'TIMEOUT'
    ? { action, status, duration_seconds: 300 }
    : { action, status, duration_seconds: null };
}

describe('chat author action results', () => {
  it.each([undefined, null])('renders nothing when the result is %s', (action) => {
    const { container } = render(createElement(ChatAuthorAction, { action }));
    expect(container.childElementCount).toBe(0);
  });

  const statuses: Array<[AuthorAction['status'], string]> = [
    ['PENDING', 'pending'],
    ['DISPATCHED', 'awaiting result'],
    ['SUCCEEDED', 'confirmed'],
    ['REJECTED', 'rejected'],
    ['NOT_SENT', 'not sent'],
    ['UNKNOWN', 'outcome unknown'],
  ];

  for (const action of ['TIMEOUT', 'BAN'] as const) {
    const label = action === 'TIMEOUT' ? 'Timeout' : 'Ban';

    it.each(statuses)(`${action} renders %s accurately`, (status, suffix) => {
      render(
        createElement(ChatAuthorAction, {
          action: makeAction(action, status),
        }),
      );

      const panel = within(screen.getByRole('group', { name: 'Author action result' }));

      expect(panel.getByText(`${label} ${suffix}`)).toBeTruthy();
      expect(panel.getByText(/This execution belongs to this message/)).toBeTruthy();

      if (status !== 'SUCCEEDED') {
        expect(panel.queryByText(`${label} confirmed`)).toBeNull();
      }

      if (status === 'UNKNOWN') {
        expect(panel.getByText(/may or may not have taken effect/)).toBeTruthy();
        expect(panel.getByText(/No automatic retry/)).toBeTruthy();
      }

      if (status === 'SUCCEEDED' && action === 'TIMEOUT') {
        expect(panel.getByText(/Requested duration: 300 seconds/)).toBeTruthy();
        expect(
          panel.getByText(/does not indicate whether the timeout is still active/),
        ).toBeTruthy();
      }

      if (status === 'SUCCEEDED' && action === 'BAN') {
        expect(panel.getByText(/permanent ban from this live chat/)).toBeTruthy();
        expect(panel.getByText(/not the current ban state/)).toBeTruthy();
      }
    });
  }

  it('updates author actions independently of deletion and classification', () => {
    const message: ChatObservation = {
      id: '10000000-0000-4000-8000-000000000001',
      external_message_id: 'test-message',
      event_type: 'textMessageEvent',
      published_at: '2026-01-01T00:00:00Z',
      received_at: '2026-01-01T00:00:00Z',
      display_text: 'Original viewer message',
      author_channel_id: 'viewer',
      author_display_name: 'Test viewer',
      evaluation_status: 'REVIEW',
      evaluation: {
        outcome: 'REVIEW',
        primary_category: 'HARASSMENT',
        severity: 2,
        reason_code: 'DIRECT_INSULT',
        reason: 'A direct insult was detected.',
        classifier_version: 'test-rules',
        policy_version: 'test-policy',
      },
      deletion: { action: 'DELETE', status: 'SUCCEEDED' },
      author_action: makeAction('TIMEOUT', 'DISPATCHED'),
    };

    const view = render(createElement(ChatMessage, { message }));

    expect(screen.getByText('Timeout awaiting result')).toBeTruthy();

    view.rerender(
      createElement(ChatMessage, {
        message: {
          ...message,
          author_action: makeAction('TIMEOUT', 'SUCCEEDED'),
        },
      }),
    );

    expect(screen.queryByText('Timeout awaiting result')).toBeNull();
    expect(screen.getByText('Timeout confirmed')).toBeTruthy();
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByText('Flagged')).toBeTruthy();
    expect(screen.getByText('A direct insult was detected.')).toBeTruthy();
    expect(screen.getByText('Original viewer message')).toBeTruthy();
  });
});

describe('author dispatch blocking', () => {
  const cases = [
    ['PREVIOUS_OUTCOME_UNKNOWN', 'BLOCKED', 'blocked', /uncertain outcome/],
    ['AUTHOR_ALREADY_BANNED', 'BLOCKED', 'blocked', /permanent ban was previously confirmed/],
    ['MESSAGE_BEFORE_TIMEOUT_END', 'SUPPRESSED', 'suppressed', /will not trigger a delayed action/],
    [
      'MESSAGE_BEFORE_UNBAN',
      'SUPPRESSED',
      'suppressed',
      /will not trigger a delayed timeout or ban/,
    ],
    ['AUTHOR_ACTION_IN_PROGRESS', 'BLOCKED', 'blocked', /awaiting a result/],
    ['TIMEOUT_WINDOW_ACTIVE', 'BLOCKED', 'blocked', /scheduling window has not ended/],
  ] as const;

  it.each(cases)('explains %s without implying success', (reason, status, label, description) => {
    const action = chatAuthorAction.parse({
      action: 'TIMEOUT',
      status,
      block_reason: reason,
      duration_seconds: 30,
    });

    render(createElement(ChatAuthorAction, { action }));

    const panel = within(screen.getByRole('group', { name: 'Author action result' }));

    expect(panel.getByText(`Timeout ${label}`)).toBeTruthy();
    expect(panel.getByText(description)).toBeTruthy();
    expect(panel.queryByText('Timeout confirmed')).toBeNull();
  });

  it('rejects inconsistent blocking metadata', () => {
    for (const fields of [
      { status: 'BLOCKED' },
      { status: 'SUPPRESSED' },
      { status: 'SUCCEEDED', block_reason: 'AUTHOR_ALREADY_BANNED' },
      { status: 'BLOCKED', block_reason: 'MESSAGE_BEFORE_TIMEOUT_END' },
      { status: 'BLOCKED', block_reason: 'MESSAGE_BEFORE_UNBAN' },
      { status: 'SUPPRESSED', block_reason: 'PREVIOUS_OUTCOME_UNKNOWN' },
    ]) {
      expect(
        chatAuthorAction.safeParse({
          action: 'TIMEOUT',
          duration_seconds: 30,
          ...fields,
        }).success,
      ).toBe(false);
    }
  });
});

describe('moderation event evidence', () => {
  it.each(['TIMEOUT', 'BAN'] as const)(
    '%s keeps an unknown request separate from matching evidence',
    (kind) => {
      const action = chatAuthorAction.parse({
        ...makeAction(kind, 'UNKNOWN'),
        evidence: {
          matching_event_observed: true,
          attribution: 'UNPROVEN',
        },
      });

      render(createElement(ChatAuthorAction, { action }));

      const panel = within(screen.getByRole('group', { name: 'Author action result' }));
      const label = kind === 'TIMEOUT' ? 'Timeout' : 'Ban';

      expect(panel.getByText(`${label} outcome unknown`)).toBeTruthy();
      expect(panel.getByText('Matching moderation event observed')).toBeTruthy();
      expect(panel.getByText(/does not prove that this application request caused/)).toBeTruthy();
      expect(panel.getByText(/No automatic retry/)).toBeTruthy();
      expect(panel.queryByText(`${label} confirmed`)).toBeNull();
    },
  );

  it('distinguishes unavailable evidence metadata from a checked empty result', () => {
    const view = render(
      createElement(ChatAuthorAction, {
        action: makeAction('TIMEOUT', 'UNKNOWN'),
      }),
    );

    expect(screen.queryByText(/No matching event evidence has been stored/)).toBeNull();

    view.rerender(
      createElement(ChatAuthorAction, {
        action: chatAuthorAction.parse({
          ...makeAction('TIMEOUT', 'UNKNOWN'),
          evidence: {
            matching_event_observed: false,
            attribution: 'UNPROVEN',
          },
        }),
      }),
    );

    expect(screen.getByText(/No matching event evidence has been stored/)).toBeTruthy();

    expect(screen.queryByText('Matching moderation event observed')).toBeNull();
  });

  it('updates evidence without changing the request outcome', () => {
    const initial = chatAuthorAction.parse({
      ...makeAction('TIMEOUT', 'UNKNOWN'),
      evidence: {
        matching_event_observed: false,
        attribution: 'UNPROVEN',
      },
    });

    const view = render(createElement(ChatAuthorAction, { action: initial }));

    view.rerender(
      createElement(ChatAuthorAction, {
        action: chatAuthorAction.parse({
          ...initial,
          evidence: {
            matching_event_observed: true,
            attribution: 'UNPROVEN',
          },
        }),
      }),
    );

    expect(screen.getByText('Timeout outcome unknown')).toBeTruthy();
    expect(screen.getByText('Matching moderation event observed')).toBeTruthy();
    expect(screen.queryByText('Timeout confirmed')).toBeNull();
    expect(screen.queryByText(/No matching event evidence has been stored/)).toBeNull();
  });

  it('rejects evidence that claims proven attribution', () => {
    expect(
      chatAuthorAction.safeParse({
        ...makeAction('BAN', 'UNKNOWN'),
        evidence: {
          matching_event_observed: true,
          attribution: 'PROVEN',
        },
      }).success,
    ).toBe(false);
  });

  it.each(['PENDING', 'DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT'] as const)(
    'rejects candidate evidence on %s results',
    (status) => {
      expect(
        chatAuthorAction.safeParse({
          ...makeAction('BAN', status),
          evidence: {
            matching_event_observed: true,
            attribution: 'UNPROVEN',
          },
        }).success,
      ).toBe(false);
    },
  );
});
