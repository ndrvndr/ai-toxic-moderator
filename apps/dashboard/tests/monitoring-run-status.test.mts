import type { ChatObservation, MonitoringRun, SavedSession } from '@moderator/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MonitoringControls } from '../features/live/components/monitoring-controls.js';
import { MonitoringRunStatus } from '../features/live/components/monitoring-run-status.js';
import { SavedSessionViewer } from '../features/live/components/saved-session-viewer.js';

const mocks = vi.hoisted(() => ({
  monitoring: vi.fn(),
  chat: vi.fn(),
  events: vi.fn(),
  session: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../features/live/hooks/use-monitoring.js', () => ({ useMonitoring: mocks.monitoring }));
vi.mock('../features/live/hooks/use-live-chat.js', () => ({ useLiveChat: mocks.chat }));
vi.mock('../features/live/hooks/use-live-events.js', () => ({ useLiveEvents: mocks.events }));
vi.mock('../features/auth/hooks/use-session.js', () => ({ useSession: mocks.session }));

const run: MonitoringRun = {
  id: '40000000-0000-4000-8000-000000000004',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  youtube_broadcast_id: 'fixture-broadcast',
  status: 'RUNNING',
  requested_at: '2026-10-04T00:00:00Z',
  started_at: '2026-10-04T00:00:01Z',
  stop_requested_at: null,
  finished_at: null,
  last_error_code: null,
};
const message: ChatObservation = {
  id: '60000000-0000-4000-8000-000000000006',
  external_message_id: 'stored-message',
  event_type: 'textMessageEvent',
  published_at: '2026-10-04T00:00:02Z',
  received_at: '2026-10-04T00:00:03Z',
  display_text: 'Stored viewer message',
  author_channel_id: 'fixture-viewer',
  author_display_name: 'Viewer',
  evaluation_status: 'NOT_EVALUATED',
  evaluation: null,
  deletion: null,
  author_action: null,
};
const saved: SavedSession = {
  session_id: run.session_id,
  channel_id: run.channel_id,
  youtube_broadcast_id: run.youtube_broadcast_id,
  title: 'Saved livestream',
  created_at: run.requested_at,
  latest_status: 'FAILED',
};
let current: MonitoringRun;
let unavailable: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  current = { ...run };
  unavailable = false;
  mocks.session.mockReturnValue({ data: { account: { id: 'fixture-account' }, memberships: [] } });
  mocks.monitoring.mockImplementation(() => ({
    monitoring: {
      data: { run: current },
      isSuccess: !unavailable,
      isError: unavailable,
      isPending: false,
      refetch: vi.fn(),
    },
    start: { mutate: mocks.start, reset: vi.fn() },
    stop: { mutate: mocks.stop, reset: vi.fn() },
  }));
  mocks.events.mockReturnValue('connected');
  mocks.chat.mockReturnValue({
    isSuccess: true,
    data: { pages: [{ items: [message] }] },
    refetch: vi.fn(),
  });
});
afterEach(cleanup);

it.each([
  ['STARTING', 'Monitoring starting'],
  ['RUNNING', 'Monitoring running'],
  ['STOPPING', 'Monitoring stopping'],
  ['STOPPED', 'Monitoring ended'],
  ['FAILED', 'Monitoring stopped after an error'],
] as const)('describes lifecycle %s without implying AI or provider success', (status, label) => {
  render(createElement(MonitoringRunStatus, { run: { ...run, status } }));
  expect(screen.getByRole('status').textContent).toBe(label);
  expect(screen.queryByText('AI processing active')).toBeNull();
  expect(screen.queryByText('Deleted')).toBeNull();
});

it('describes a not-started run', () => {
  render(createElement(MonitoringRunStatus, { run: null }));
  expect(screen.getByText('Monitoring not started')).toBeTruthy();
});

it.each([
  ['YOUTUBE_QUOTA_EXCEEDED', 'Monitoring stopped: YouTube quota exhausted'],
  ['RECONNECT_REQUIRED', 'Monitoring stopped: reconnect Google'],
  ['YOUTUBE_FORBIDDEN', 'Monitoring stopped: YouTube access denied'],
  ['LIVE_CHAT_DISABLED', 'Monitoring stopped: live chat disabled'],
  ['LIVE_CHAT_NOT_FOUND', 'Monitoring stopped: live chat unavailable'],
  ['INVALID_PAGE_TOKEN', 'Monitoring stopped: chat could not resume'],
  ['INVALID_PROVIDER_RESPONSE', 'Monitoring stopped: unexpected YouTube response'],
  ['INVALID_REQUEST', 'Monitoring stopped: chat request rejected'],
  ['RETRY_DELAY_UNSUPPORTED', 'Monitoring stopped: retry unavailable'],
  ['GOOGLE_UNAVAILABLE', 'Monitoring stopped: Google unavailable'],
  ['YOUTUBE_UNAVAILABLE', 'Monitoring stopped: YouTube unavailable'],
  ['YOUTUBE_RATE_LIMITED', 'Monitoring stopped: YouTube rate limit'],
])('explains terminal reason %s', (code, label) => {
  render(
    createElement(MonitoringRunStatus, {
      run: { ...run, status: 'FAILED', last_error_code: code },
    }),
  );
  expect(screen.getByRole('status').textContent).toBe(label);
});

it('distinguishes a recorded stop request without inventing a natural end reason', () => {
  const view = render(
    createElement(MonitoringRunStatus, {
      run: { ...run, status: 'STOPPED', stop_requested_at: '2026-10-04T00:00:03Z' },
    }),
  );
  expect(screen.getByText('Monitoring stopped after a stop request')).toBeTruthy();
  view.rerender(createElement(MonitoringRunStatus, { run: { ...run, status: 'STOPPED' } }));
  expect(screen.getByText(/does not identify the exact end reason/)).toBeTruthy();
  expect(screen.queryByText('Livestream ended')).toBeNull();
});

it.each(['GOOGLE_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE', 'YOUTUBE_RATE_LIMITED'])(
  'separates pending retries from terminal errors for %s',
  (code) => {
    const view = render(
      createElement(MonitoringRunStatus, { run: { ...run, last_error_code: code } }),
    );
    expect(screen.getByText('Monitoring retrying')).toBeTruthy();
    expect(screen.getByText(/does not confirm that new chat has been collected/)).toBeTruthy();
    view.rerender(createElement(MonitoringRunStatus, { run }));
    expect(screen.getByText('Monitoring running')).toBeTruthy();
    expect(screen.queryByText('Monitoring retrying')).toBeNull();
  },
);

it.each([null, 'UNKNOWN_FUTURE_CODE', 'private database error with a secret'])(
  'uses a safe fallback for failure code %s',
  (code) => {
    render(
      createElement(MonitoringRunStatus, {
        run: { ...run, status: 'FAILED', last_error_code: code },
      }),
    );
    expect(screen.getByText('Monitoring stopped after an error')).toBeTruthy();
    if (code) expect(screen.queryByText(code)).toBeNull();
  },
);

it.each(['Live', 'History'])(
  '%s updates the quota reason without refresh while keeping stored chat and socket status separate',
  (page) => {
    const element =
      page === 'Live'
        ? createElement(MonitoringControls, {
            broadcastId: run.youtube_broadcast_id,
            liveChatAvailable: true,
          })
        : createElement(SavedSessionViewer, { accountId: 'fixture-account', session: saved });
    const view = render(element);
    expect(screen.getByText('Monitoring running')).toBeTruthy();
    current = {
      ...run,
      status: 'FAILED',
      finished_at: '2026-10-04T00:00:10Z',
      last_error_code: 'YOUTUBE_QUOTA_EXCEEDED',
    };
    view.rerender(
      element.type === MonitoringControls
        ? createElement(MonitoringControls, {
            broadcastId: run.youtube_broadcast_id,
            liveChatAvailable: true,
          })
        : createElement(SavedSessionViewer, { accountId: 'fixture-account', session: saved }),
    );
    expect(screen.getByText('Monitoring stopped: YouTube quota exhausted')).toBeTruthy();
    expect(screen.getByText(/will not retry automatically/)).toBeTruthy();
    expect(screen.getByText('Stored viewer message')).toBeTruthy();
    expect(screen.getByText('Live updates connected')).toBeTruthy();
    expect(screen.queryByText('AI processing error')).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  },
);

it('hides cached lifecycle explanations when the monitoring read fails', () => {
  current = { ...run, status: 'FAILED', last_error_code: 'YOUTUBE_QUOTA_EXCEEDED' };
  unavailable = true;
  render(
    createElement(MonitoringControls, {
      broadcastId: run.youtube_broadcast_id,
      liveChatAvailable: true,
    }),
  );
  expect(screen.getByText('Monitoring status is unavailable.')).toBeTruthy();
  expect(screen.queryByText('Monitoring stopped: YouTube quota exhausted')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Start Monitoring' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Start Monitoring' }));
  expect(mocks.start).not.toHaveBeenCalled();
});

it('stops only on a user click and explains that the YouTube stream keeps running', () => {
  render(
    createElement(MonitoringControls, {
      broadcastId: run.youtube_broadcast_id,
      liveChatAvailable: true,
    }),
  );
  expect(screen.getByText(/Stopping monitoring does not end your YouTube livestream/)).toBeTruthy();
  expect(screen.getByText(/Later settings changes apply to your next session/)).toBeTruthy();
  expect(mocks.stop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop Monitoring' }));
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(mocks.start).not.toHaveBeenCalled();
});

it('does not repeat a stop while the session is stopping', () => {
  current = { ...run, status: 'STOPPING' };
  render(
    createElement(MonitoringControls, {
      broadcastId: run.youtube_broadcast_id,
      liveChatAvailable: true,
    }),
  );
  expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }));
  expect(mocks.stop).not.toHaveBeenCalled();
});

it.each(['STARTING', 'STOPPING'] as const)(
  'chat summary describes %s without claiming active ingestion',
  (status) => {
    current = { ...run, status };
    render(
      createElement(MonitoringControls, {
        broadcastId: run.youtube_broadcast_id,
        liveChatAvailable: true,
      }),
    );
    const chat = within(screen.getByRole('region', { name: 'Livestream chat' }));
    expect(
      chat.getByText(
        `Newest first · Monitoring ${status === 'STARTING' ? 'starting' : 'stopping'}`,
      ),
    ).toBeTruthy();
    expect(chat.queryByText('Newest first · Monitoring active')).toBeNull();
  },
);
