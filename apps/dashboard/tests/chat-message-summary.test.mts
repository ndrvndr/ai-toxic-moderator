import type { ChatObservation } from '@moderator/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it } from 'vitest';

import { ChatMessage } from '../features/live/components/chat-message.js';

const message: ChatObservation = {
  id: '10000000-0000-4000-8000-000000000001',
  external_message_id: 'compact-message',
  event_type: 'textMessageEvent',
  published_at: '2026-10-05T00:00:00Z',
  received_at: '2026-10-05T00:00:01Z',
  display_text: 'Viewer message',
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
  deletion: { action: 'DELETE', status: 'PENDING' },
  author_action: { action: 'TIMEOUT', status: 'UNKNOWN', duration_seconds: 30 },
};

afterEach(cleanup);

it('shows uncertain and pending outcomes outside the closed details', () => {
  const view = render(createElement(ChatMessage, { message, compact: true }));
  expect(screen.getByText('Rule check: Flagged')).toBeTruthy();
  expect(
    within(screen.getByRole('group', { name: 'Moderation summary' })).getByText('Deletion pending'),
  ).toBeTruthy();
  expect(screen.getByText('Timeout request outcome unknown')).toBeTruthy();
  expect(screen.getByText(/This request won’t be retried automatically/)).toBeTruthy();
  expect(view.container.querySelector('details')?.open).toBe(false);
  expect(screen.getByRole('group', { name: 'Author action result' }).closest('details')?.open).toBe(
    false,
  );
  fireEvent.click(screen.getByText('Moderation details'));
  expect(view.container.querySelector('details')?.open).toBe(true);
  expect(screen.getByRole('group', { name: 'Author action result' })).toBeTruthy();
});

it('updates confirmed outcomes without hiding the original message or claiming an active timeout', () => {
  const view = render(createElement(ChatMessage, { message, compact: true }));
  view.rerender(
    createElement(ChatMessage, {
      compact: true,
      message: {
        ...message,
        deletion: { action: 'DELETE', status: 'SUCCEEDED' },
        author_action: { action: 'TIMEOUT', status: 'SUCCEEDED', duration_seconds: 30 },
      },
    }),
  );
  expect(screen.getByText('Message deleted')).toBeTruthy();
  expect(screen.getByText('Timeout request confirmed')).toBeTruthy();
  expect(screen.getByText('Viewer message')).toBeTruthy();
  expect(screen.queryByText(/result is uncertain/)).toBeNull();
  expect(screen.queryByText('Timeout active')).toBeNull();
});

it('does not invent a moderation result for a system event', () => {
  const view = render(
    createElement(ChatMessage, {
      compact: true,
      message: {
        ...message,
        event_type: 'chatEndedEvent',
        display_text: 'Stream chat ended',
        evaluation_status: 'NOT_EVALUATED',
        evaluation: null,
        deletion: null,
        author_action: null,
      },
    }),
  );
  expect(screen.getByText('Stream chat ended')).toBeTruthy();
  expect(view.container.querySelector('details')).toBeNull();
  expect(screen.queryByText(/confirmed/)).toBeNull();
});
