import {
  BUILTIN_MODERATION_RULE_CATALOG,
  type ModerationSettingsConfiguration,
  type ModerationSettingsRecord,
} from '@moderator/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getModerationSettings } from '../features/moderation-settings/api/moderation-settings-api.js';
import { ModerationSettingsEditor } from '../features/moderation-settings/components/moderation-settings-editor.js';
import { moderationSettingsKey } from '../features/moderation-settings/hooks/use-moderation-settings.js';
import { ApiError, apiRequest } from '../lib/api-client.js';

vi.mock('../lib/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client.js')>()),
  apiRequest: vi.fn(),
}));

const accountId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000002';
const otherChannelId = '20000000-0000-4000-8000-000000000003';
const empty: ModerationSettingsConfiguration = {
  schema_version: 1,
  automatic_actions_enabled: false,
  rules: [],
};
let client: QueryClient;
let records: Map<string, ModerationSettingsRecord>;

function record(
  channel: string,
  revision: number,
  configuration = empty,
): ModerationSettingsRecord {
  return {
    id: '40000000-0000-4000-8000-000000000004',
    channel_id: channel,
    revision,
    configuration,
    created_by: accountId,
    created_at: '2026-10-03T00:00:00Z',
  };
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  records = new Map();
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    const channel = path.split('/')[3]!;
    if (path.endsWith('/rules')) return { items: BUILTIN_MODERATION_RULE_CATALOG };
    if (options?.method === 'POST') {
      const input = JSON.parse(options.body as string) as {
        expected_revision: number;
        configuration: ModerationSettingsConfiguration;
      };
      const saved = record(channel, input.expected_revision + 1, input.configuration);
      records.set(channel, saved);
      return { settings: saved };
    }
    return { settings: records.get(channel) ?? null };
  });
});

afterEach(() => {
  cleanup();
  client.clear();
});

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

function editor(canEdit = true, account = accountId, channel = channelId) {
  return createElement(ModerationSettingsEditor, {
    accountId: account,
    channelId: channel,
    canEdit,
  });
}

const posts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'POST');
const actionSelect = () => screen.getByLabelText('Action for Direct insult');

it('saves owner changes with the current revision and updates only the scoped cache', async () => {
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  fireEvent.change(actionSelect(), { target: { value: 'TIMEOUT' } });
  fireEvent.change(screen.getByLabelText('Timeout seconds for Direct insult'), {
    target: { value: '60' },
  });
  fireEvent.click(screen.getByLabelText('Enable automatic actions in this configuration'));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText('Settings saved as revision 1.');
  expect(posts()).toHaveLength(1);
  const [path, options] = posts()[0]!;
  expect(path).toBe(`/v1/channels/${channelId}/moderation-settings`);
  expect(JSON.parse(options!.body as string)).toEqual({
    expected_revision: 0,
    configuration: {
      schema_version: 1,
      automatic_actions_enabled: true,
      rules: [
        {
          rule_id: 'id.harassment.direct-insult',
          rule_version: '1',
          minimum_severity: 2,
          action: 'TIMEOUT',
          duration_seconds: 60,
        },
      ],
    },
  });
  expect(
    client.getQueryData<ModerationSettingsRecord>(moderationSettingsKey(accountId, channelId))
      ?.revision,
  ).toBe(1);
  expect(client.getQueryData(moderationSettingsKey(accountId, otherChannelId))).toBeUndefined();
  expect(
    (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('preserves the draft after a conflict and requires reload before using the new revision', async () => {
  let postCount = 0;
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path.endsWith('/rules')) return { items: BUILTIN_MODERATION_RULE_CATALOG };
    if (options?.method === 'POST') {
      postCount++;
      if (postCount === 1) {
        records.set(channelId, record(channelId, 2));
        throw new ApiError(409, 'SETTINGS_REVISION_CONFLICT');
      }
      const input = JSON.parse(options.body as string);
      return { settings: record(channelId, input.expected_revision + 1, input.configuration) };
    }
    return { settings: records.get(channelId) ?? null };
  });
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  fireEvent.change(actionSelect(), { target: { value: 'TIMEOUT' } });
  fireEvent.change(screen.getByLabelText('Timeout seconds for Direct insult'), {
    target: { value: '45' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText(
    'Settings changed elsewhere. Reload saved settings before editing again.',
  );
  expect(
    (screen.getByLabelText('Timeout seconds for Direct insult') as HTMLInputElement).value,
  ).toBe('45');
  expect(
    (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await screen.findByText('Saved settings reloaded. Unsaved changes were discarded.');
  expect((actionSelect() as HTMLSelectElement).value).toBe('NONE');
  expect(screen.getByText('Saved revision 2')).toBeTruthy();
  fireEvent.change(actionSelect(), { target: { value: 'BAN' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText('Settings saved as revision 3.');
  expect(JSON.parse(posts().at(-1)![1]!.body as string).expected_revision).toBe(2);
});

it('moderators see a read-only form and cannot submit', async () => {
  render(editor(false), { wrapper });
  await screen.findByText('Read-only access. Only the channel owner can change these settings.');
  expect(
    (screen.getByRole('group', { name: 'Moderation configuration' }) as HTMLFieldSetElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  fireEvent.submit(actionSelect().closest('form')!);
  await act(async () => {
    await Promise.resolve();
  });
  expect(posts()).toHaveLength(0);
});

it('does not retry an unconfirmed save and recovers its committed revision through reload', async () => {
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path.endsWith('/rules')) return { items: BUILTIN_MODERATION_RULE_CATALOG };
    if (options?.method === 'POST') {
      const input = JSON.parse(options.body as string);
      records.set(channelId, record(channelId, 1, input.configuration));
      throw new ApiError(0, 'NETWORK_ERROR');
    }
    return { settings: records.get(channelId) ?? null };
  });
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  fireEvent.change(actionSelect(), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText(
    'The save could not be confirmed. Reload saved settings before trying again.',
  );
  expect((actionSelect() as HTMLSelectElement).value).toBe('DELETE');
  fireEvent.submit(actionSelect().closest('form')!);
  await act(async () => {
    await Promise.resolve();
  });
  expect(posts()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await screen.findByText('Saved settings reloaded. Unsaved changes were discarded.');
  expect(screen.getByText('Saved revision 1')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it.each([401, 403])('blocks further saves after access error %s', async (status) => {
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path.endsWith('/rules')) return { items: BUILTIN_MODERATION_RULE_CATALOG };
    if (options?.method === 'POST') throw new ApiError(status, 'ACCESS_CHANGED');
    return { settings: null };
  });
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText(
    'Your session or access permissions changed. Reload to check your access.',
  );
  expect(
    (screen.getByRole('group', { name: 'Moderation configuration' }) as HTMLFieldSetElement)
      .disabled,
  ).toBe(true);
  fireEvent.submit(actionSelect().closest('form')!);
  await act(async () => {
    await Promise.resolve();
  });
  expect(posts()).toHaveLength(1);
});

it('does not show ambiguous rules as automatic action selectors', async () => {
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  expect(screen.queryByLabelText('Action for Possible gambling promotion')).toBeNull();
  expect(screen.queryByLabelText('Action for Possible suspicious link')).toBeNull();
  expect(
    screen.getAllByText('This rule requires context and supports no automatic actions.'),
  ).toHaveLength(2);
});

it('rejects invalid timeout input before sending a save', async () => {
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  fireEvent.change(actionSelect(), { target: { value: 'TIMEOUT' } });
  fireEvent.change(screen.getByLabelText('Timeout seconds for Direct insult'), {
    target: { value: '0' },
  });
  fireEvent.submit(actionSelect().closest('form')!);
  await screen.findByText(
    'Check severity and timeout duration, and remove unsupported rule configurations.',
  );
  expect(posts()).toHaveLength(0);
});

it('prevents duplicate submissions while a save is in flight', async () => {
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (path.endsWith('/rules')) return { items: BUILTIN_MODERATION_RULE_CATALOG };
    if (options?.method === 'POST') {
      await response;
      return { settings: record(channelId, 1) };
    }
    return { settings: null };
  });
  render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  const form = actionSelect().closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(posts()).toHaveLength(1));
  await act(async () => {
    release();
    await response;
  });
  await screen.findByText('Settings saved as revision 1.');
  expect(posts()).toHaveLength(1);
});

it('drops unsaved drafts when changing channel or account', async () => {
  const view = render(editor(), { wrapper });
  await screen.findByText('No settings saved yet');
  fireEvent.change(actionSelect(), { target: { value: 'TIMEOUT' } });
  view.rerender(editor(true, accountId, otherChannelId));
  await screen.findByText('No settings saved yet');
  expect((actionSelect() as HTMLSelectElement).value).toBe('NONE');
  fireEvent.change(actionSelect(), { target: { value: 'BAN' } });
  view.rerender(editor(true, '10000000-0000-4000-8000-000000000005', otherChannelId));
  await screen.findByText('No settings saved yet');
  expect((actionSelect() as HTMLSelectElement).value).toBe('NONE');
  expect(posts()).toHaveLength(0);
});

it('hides the form when the settings read loses channel access', async () => {
  vi.mocked(apiRequest).mockRejectedValue(new ApiError(403, 'CHANNEL_FORBIDDEN'));
  render(editor(), { wrapper });
  await screen.findByText('Settings are unavailable. Check your session and channel access.');
  expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  expect(screen.queryByLabelText('Action for Direct insult')).toBeNull();
});

it('rejects a valid-shaped settings response belonging to another channel', async () => {
  vi.mocked(apiRequest).mockResolvedValue({ settings: record(otherChannelId, 1) });
  await expect(getModerationSettings(channelId, new AbortController().signal)).rejects.toThrow(
    'Moderation settings channel mismatch.',
  );
});

it('preserves historical unknown rules until explicitly removed', async () => {
  records.set(
    channelId,
    record(channelId, 1, {
      ...empty,
      rules: [
        {
          rule_id: 'retired.rule',
          rule_version: '1',
          minimum_severity: 2,
          action: 'DELETE',
        },
      ],
    }),
  );
  render(editor(), { wrapper });
  await screen.findByText('Unavailable rule configurations');
  expect(
    (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove configuration' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText('Settings saved as revision 2.');
  expect(JSON.parse(posts()[0]![1]!.body as string).configuration.rules).toEqual([]);
});
