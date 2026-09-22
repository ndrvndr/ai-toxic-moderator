import type { ChatAuthorAction as AuthorAction, ChatObservation } from '@moderator/contracts';
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
      expect(panel.getByText(/This execution was triggered by this message/)).toBeTruthy();

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
