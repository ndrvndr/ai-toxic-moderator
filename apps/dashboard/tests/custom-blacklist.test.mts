import type { CustomBlacklistConfiguration, CustomBlacklistRecord } from '@moderator/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getCustomBlacklist } from '../features/moderation-settings/api/custom-blacklist-api.js';
import { CustomBlacklistEditor } from '../features/moderation-settings/components/custom-blacklist-editor.js';
import { CustomBlacklistForm } from '../features/moderation-settings/components/custom-blacklist-form.js';
import { customBlacklistKey } from '../features/moderation-settings/hooks/use-custom-blacklist.js';
import { ApiError, apiRequest } from '../lib/api-client.js';

vi.mock('../lib/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client.js')>()),
  apiRequest: vi.fn(),
}));

const accountId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000002';
const otherChannel = '20000000-0000-4000-8000-000000000003';
const configuration: CustomBlacklistConfiguration = {
  schema_version: 1,
  enabled: true,
  rules: [
    {
      id: '30000000-0000-4000-8000-000000000001',
      enabled: true,
      match_type: 'WORD',
      pattern: 'abc',
      action: 'DELETE',
    },
  ],
};
let client: QueryClient;
let records: Map<string, CustomBlacklistRecord>;
function record(channel = channelId, revision = 1, config = configuration): CustomBlacklistRecord {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    channel_id: channel,
    revision,
    configuration: config,
    created_by: accountId,
    created_at: '2026-10-03T00:00:00Z',
  };
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  records = new Map();
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    const channel = path.split('/')[3]!;
    if (options?.method === 'POST') {
      const input = JSON.parse(options.body as string);
      const saved = record(channel, input.expected_revision + 1, input.configuration);
      records.set(channel, saved);
      return { blacklist: saved };
    }
    return { blacklist: records.get(channel) ?? null };
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}
function editor(canEdit = true, channel = channelId, account = accountId) {
  return createElement(CustomBlacklistEditor, { accountId: account, channelId: channel, canEdit });
}
const posts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'POST');
function add(pattern: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Add blocked word' }));
  fireEvent.change(screen.getByLabelText('Blocked text for entry 1'), {
    target: { value: pattern },
  });
}
function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save blocked words' }));
}

it('creates a normalized owner configuration with a timeout and scoped revision', async () => {
  render(editor(), { wrapper });
  await screen.findByText(
    'Your list is empty. Add a word, phrase, or website domain to get started.',
  );
  add(' ABC ');
  fireEvent.click(screen.getByLabelText('Enable blocked words'));
  fireEvent.change(screen.getByLabelText('Action for entry 1'), {
    target: { value: 'DELETE_TIMEOUT' },
  });
  fireEvent.change(screen.getByLabelText('Timeout seconds for entry 1'), {
    target: { value: '60' },
  });
  save();
  await screen.findByText('Blacklist revision 1 saved.');
  const input = JSON.parse(posts()[0]![1]!.body as string);
  expect(input.expected_revision).toBe(0);
  expect(input.configuration.rules[0]).toMatchObject({
    pattern: 'abc',
    action: 'DELETE_TIMEOUT',
    duration_seconds: 60,
  });
  expect(input.configuration.enabled).toBe(true);
  expect(
    client.getQueryData<CustomBlacklistRecord>(customBlacklistKey(accountId, channelId))?.revision,
  ).toBe(1);
  expect(client.getQueryData(customBlacklistKey(accountId, otherChannel))).toBeUndefined();
});

it('disables and removes saved entries by appending configurations', async () => {
  records.set(channelId, record());
  render(editor(), { wrapper });
  await screen.findByLabelText('Blocked text for entry 1');
  fireEvent.click(screen.getByLabelText('Entry 1 enabled'));
  save();
  await screen.findByText('Blacklist revision 2 saved.');
  expect(JSON.parse(posts()[0]![1]!.body as string).configuration.rules[0].enabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Remove entry 1' }));
  save();
  await screen.findByText('Blacklist revision 3 saved.');
  expect(JSON.parse(posts()[1]![1]!.body as string).configuration.rules).toEqual([]);
});

it('rejects blank patterns, duplicate normalized entries and invalid timeout durations before HTTP', async () => {
  render(editor(), { wrapper });
  await screen.findByText(
    'Your list is empty. Add a word, phrase, or website domain to get started.',
  );
  add('');
  save();
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Blocked text for entry 1'), { target: { value: 'abc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add blocked word' }));
  fireEvent.change(screen.getByLabelText('Blocked text for entry 2'), {
    target: { value: ' ABC ' },
  });
  save();
  expect(screen.getByRole('alert').textContent).toContain('normalized pattern');
  fireEvent.click(screen.getByRole('button', { name: 'Remove entry 2' }));
  fireEvent.change(screen.getByLabelText('Action for entry 1'), {
    target: { value: 'DELETE_TIMEOUT' },
  });
  fireEvent.change(screen.getByLabelText('Timeout seconds for entry 1'), {
    target: { value: '0' },
  });
  save();
  expect(posts()).toHaveLength(0);
});

it.each([409, 0])(
  'retains the draft and blocks further writes after save failure %s until explicit reload',
  async (status) => {
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        records.set(channelId, record(channelId, 2));
        throw new ApiError(status, 'SAVE_FAILED');
      }
      return { blacklist: records.get(channelId) ?? null };
    });
    render(editor(), { wrapper });
    await screen.findByText(
      'Your list is empty. Add a word, phrase, or website domain to get started.',
    );
    add('draft');
    save();
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Blocked text for entry 1') as HTMLInputElement).value).toBe(
      'draft',
    );
    expect(
      (screen.getByRole('button', { name: 'Save blocked words' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(posts()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload blacklist and discard changes' }));
    await screen.findByText('Latest blacklist loaded. Unsaved changes were discarded.');
    expect((screen.getByLabelText('Blocked text for entry 1') as HTMLInputElement).value).toBe(
      'abc',
    );
    expect(screen.getByText('Saved revision: 2. Up to 100 entries.')).toBeTruthy();
  },
);

it('shows a read-only configuration to moderators without a save control', async () => {
  records.set(channelId, record());
  render(editor(false), { wrapper });
  const pattern = await screen.findByLabelText('Blocked text for entry 1');
  expect(pattern.closest('fieldset')?.parentElement?.closest('fieldset')?.disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save blocked words' })).toBeNull();
  fireEvent.submit(pattern.closest('form')!);
  expect(posts()).toHaveLength(0);
});

it.each([401, 403, 404])(
  'hides entries and clears their cache after a save access failure %s',
  async (status) => {
    records.set(channelId, record());
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') throw new ApiError(status, 'ACCESS_DENIED');
      return { blacklist: records.get(channelId) ?? null };
    });
    render(editor(), { wrapper });
    await screen.findByLabelText('Blocked text for entry 1');
    fireEvent.change(screen.getByLabelText('Blocked text for entry 1'), {
      target: { value: 'private-draft' },
    });
    fireEvent.change(screen.getByLabelText('Match type for entry 1'), {
      target: { value: 'PHRASE' },
    });
    save();
    await screen.findByText(
      'Blacklist access changed. Sign in and reload this page to verify your permissions.',
    );
    expect(screen.queryByLabelText('Blocked text for entry 1')).toBeNull();
    expect(client.getQueryData(customBlacklistKey(accountId, channelId))).toBeNull();
  },
);

it('resets the draft on channel and account changes', async () => {
  const view = render(editor(), { wrapper });
  await screen.findByText(
    'Your list is empty. Add a word, phrase, or website domain to get started.',
  );
  add('private');
  view.rerender(editor(true, otherChannel));
  await waitFor(() => expect(screen.queryByLabelText('Blocked text for entry 1')).toBeNull());
  await screen.findByRole('button', { name: 'Add blocked word' });
  add('other');
  view.rerender(editor(true, otherChannel, '10000000-0000-4000-8000-000000000002'));
  await screen.findByText(
    'Your list is empty. Add a word, phrase, or website domain to get started.',
  );
  expect(posts()).toHaveLength(0);
});

it('rejects an API record for a different channel', async () => {
  vi.mocked(apiRequest).mockResolvedValue({ blacklist: record(otherChannel) });
  await expect(getCustomBlacklist(channelId, new AbortController().signal)).rejects.toThrow(
    'channel mismatch',
  );
});

it('saves a domain ban without a timeout field', async () => {
  render(editor(), { wrapper });
  await screen.findByText(
    'Your list is empty. Add a word, phrase, or website domain to get started.',
  );
  add('EXAMPLE.COM');
  fireEvent.change(screen.getByLabelText('Match type for entry 1'), {
    target: { value: 'DOMAIN' },
  });
  fireEvent.change(screen.getByLabelText('Action for entry 1'), {
    target: { value: 'DELETE_BAN' },
  });
  save();
  await screen.findByText('Blacklist revision 1 saved.');
  const rule = JSON.parse(posts()[0]![1]!.body as string).configuration.rules[0];
  expect(rule.pattern).toBe('example.com');
  expect(rule.action).toBe('DELETE_BAN');
  expect(rule.duration_seconds).toBeUndefined();
});

it('submits only once when the form is submitted twice before the save completes', async () => {
  let resolveSave!: (value: unknown) => void;
  vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST')
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    return { blacklist: null };
  });
  render(editor(), { wrapper });
  await screen.findByText(
    'Your list is empty. Add a word, phrase, or website domain to get started.',
  );
  add('abc');
  const form = screen.getByLabelText('Blocked text for entry 1').closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(posts()).toHaveLength(1));
  const input = JSON.parse(posts()[0]![1]!.body as string);
  resolveSave({ blacklist: record(channelId, 1, input.configuration) });
  await screen.findByText('Blacklist revision 1 saved.');
  expect(posts()).toHaveLength(1);
});

it('blocks requests exceeding the body limit before saving', () => {
  // Multi-byte text exceeds the byte limit with fewer rendered entries.
  const oversized: CustomBlacklistConfiguration = {
    schema_version: 1,
    enabled: true,
    rules: Array.from({ length: 20 }, (_, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      enabled: true,
      match_type: 'PHRASE',
      pattern: `${index} ${'漢'.repeat(240)}`,
      action: 'DELETE',
    })),
  };
  expect(
    new Blob([JSON.stringify({ expected_revision: 1, configuration: oversized })]).size,
  ).toBeGreaterThan(16 * 1024);
  render(
    createElement(CustomBlacklistForm, {
      accountId,
      channelId,
      canEdit: true,
      initial: record(channelId, 1, oversized),
      onReload: vi.fn().mockResolvedValue(null),
    }),
    { wrapper },
  );
  const pattern = screen.getByLabelText('Blocked text for entry 1');
  fireEvent.click(screen.getByLabelText('Enable blocked words'));
  // Submit the loaded form directly instead of computing accessible names for
  // every button in a large fixture. Other tests cover the Save button itself.
  fireEvent.submit(pattern.closest('form')!);
  expect(
    screen.getByText('The blacklist exceeds the 16 KB request limit. Shorten or remove entries.'),
  ).toBeTruthy();
  expect(posts()).toHaveLength(0);
});
