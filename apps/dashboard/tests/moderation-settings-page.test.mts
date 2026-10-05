import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ModerationSettingsPage } from '../features/moderation-settings/components/moderation-settings-page.js';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  blacklist: vi.fn(),
  ai: vi.fn(),
  setup: vi.fn(),
}));
vi.mock('../features/auth/hooks/use-session.js', () => ({ useSession: mocks.session }));
vi.mock('../features/moderation-settings/components/custom-blacklist-editor.js', () => ({
  CustomBlacklistEditor: mocks.blacklist,
}));
vi.mock('../features/moderation-settings/components/ai-moderation-settings-editor.js', () => ({
  AiModerationSettingsEditor: mocks.ai,
}));
vi.mock('../features/moderation-settings/components/channel-setup.js', () => ({
  ChannelSetup: mocks.setup,
}));
const accountId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000002';
const otherChannel = '20000000-0000-4000-8000-000000000003';
function session(
  memberships: { channel_id: string; channel_name?: string; role: string }[],
  account = accountId,
) {
  mocks.session.mockReturnValue({
    data: { account: { id: account }, memberships },
    isPending: false,
    isError: false,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.blacklist.mockReturnValue(null);
  mocks.ai.mockReturnValue(null);
  mocks.setup.mockReturnValue(null);
  session([{ channel_id: channelId, channel_name: 'Andre Live', role: 'OWNER' }]);
});
afterEach(cleanup);

it('offers blocked words and AI before monitoring and displays the channel name', () => {
  render(createElement(ModerationSettingsPage));
  expect(screen.getByRole('heading', { name: 'Blocked words' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'AI action limits' })).toBeTruthy();
  expect(screen.getByText(/Your changes apply the next time you start monitoring/)).toBeTruthy();
  expect(screen.getByText('Settings for Andre Live')).toBeTruthy();
  expect(screen.queryByText(channelId)).toBeNull();
  expect(screen.queryByText(/Built-in rules/)).toBeNull();
  expect(screen.getAllByRole('link')).toHaveLength(2);
  for (const editor of [mocks.blacklist, mocks.ai]) {
    expect(editor.mock.calls.at(-1)?.[0]).toEqual({ accountId, channelId, canEdit: true });
  }
});

it('keeps moderator access read-only across all settings sections', () => {
  session([{ channel_id: channelId, role: 'MODERATOR' }]);
  render(createElement(ModerationSettingsPage));
  expect(screen.getByText(/Only the channel owner can save changes/)).toBeTruthy();
  for (const editor of [mocks.blacklist, mocks.ai]) {
    expect(editor.mock.calls.at(-1)?.[0]).toEqual({ accountId, channelId, canEdit: false });
  }
});

it('switches every editor to the selected channel and its editing permission', () => {
  session([
    { channel_id: channelId, channel_name: 'Andre Live', role: 'OWNER' },
    { channel_id: otherChannel, channel_name: 'Another streamer', role: 'MODERATOR' },
  ]);
  render(createElement(ModerationSettingsPage));
  expect(screen.getByRole('option', { name: 'Andre Live · Owner' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: otherChannel } });
  for (const editor of [mocks.blacklist, mocks.ai]) {
    expect(editor.mock.calls.at(-1)?.[0]).toEqual({
      accountId,
      channelId: otherChannel,
      canEdit: false,
    });
  }
});

it('does not open editors for an operator-only account', () => {
  session([{ channel_id: channelId, role: 'OPERATOR' }]);
  render(createElement(ModerationSettingsPage));
  expect(mocks.setup).toHaveBeenCalled();
  for (const editor of [mocks.blacklist, mocks.ai]) expect(editor).not.toHaveBeenCalled();
});
