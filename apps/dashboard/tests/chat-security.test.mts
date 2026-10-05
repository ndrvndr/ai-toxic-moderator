import type { ChatObservation } from '@moderator/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ChatMessage } from '../features/live/components/chat-message.js';
afterEach(cleanup);
it.each([false, true])(
  'renders untrusted author and message content literally (compact=%s)',
  (compact) => {
    const text =
      '<img src=x onerror="window.__chatAttack=true"><script>alert(1)</script> javascript:alert(1)';
    const author = '<svg onload="alert(2)">';
    const message: ChatObservation = {
      id: '10000000-0000-4000-8000-000000000001',
      external_message_id: 'security-fixture',
      event_type: 'textMessageEvent',
      published_at: '2026-10-05T00:00:00Z',
      received_at: '2026-10-05T00:00:01Z',
      display_text: text,
      author_display_name: author,
      author_channel_id: null,
      evaluation_status: 'NOT_EVALUATED',
      evaluation: null,
      deletion: null,
      author_action: null,
    };
    const view = render(createElement(ChatMessage, { message, compact }));
    expect(screen.getByText(text).textContent).toBe(text);
    expect(screen.getByText(author).textContent).toBe(author);
    expect(
      view.container.querySelector('img, script, svg[onload], a[href^="javascript:"]'),
    ).toBeNull();
    expect(view.container.querySelector('[onerror], [onload]')).toBeNull();
  },
);
