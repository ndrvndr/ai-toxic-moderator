import type { ChatObservation, ChatDeletion as Deletion } from '@moderator/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatDeletion } from '../features/live/components/chat-deletion.js';
import { ChatMessage } from '../features/live/components/chat-message.js';

afterEach(cleanup);

describe('chat deletion results', () => {
  it.each([undefined, null])('does not imply an action when deletion is %s', (deletion) => {
    const { container } = render(createElement(ChatDeletion, { deletion }));
    expect(container.childElementCount).toBe(0);
  });

  const cases: Array<[Deletion['status'], string]> = [
    ['PENDING', 'Deletion pending'],
    ['DISPATCHED', 'Deletion awaiting result'],
    ['SUCCEEDED', 'Deleted'],
    ['REJECTED', 'Deletion rejected'],
    ['NOT_SENT', 'Deletion not sent'],
    ['UNKNOWN', 'Deletion outcome unknown'],
  ];

  it.each(cases)('renders %s without confusing it with confirmed success', (status, label) => {
    render(createElement(ChatDeletion, { deletion: { action: 'DELETE', status } }));
    const panel = within(screen.getByRole('group', { name: 'Deletion result' }));
    expect(panel.getByText(label)).toBeTruthy();
    if (status !== 'SUCCEEDED') expect(panel.queryByText('Deleted')).toBeNull();
    if (status === 'UNKNOWN') {
      expect(panel.getByText(/may or may not have been deleted/)).toBeTruthy();
      expect(panel.getByText(/No automatic retry/)).toBeTruthy();
    }
  });

  it('updates the action result while preserving the original message and classification', () => {
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
      deletion: { action: 'DELETE', status: 'DISPATCHED' },
    };
    const view = render(createElement(ChatMessage, { message }));
    expect(screen.getByText('Deletion awaiting result')).toBeTruthy();
    view.rerender(
      createElement(ChatMessage, {
        message: { ...message, deletion: { action: 'DELETE', status: 'SUCCEEDED' } },
      }),
    );
    expect(screen.queryByText('Deletion awaiting result')).toBeNull();
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByText('Flagged')).toBeTruthy();
    expect(screen.getByText('A direct insult was detected.')).toBeTruthy();
    expect(screen.getByText('Original viewer message')).toBeTruthy();
  });
});
