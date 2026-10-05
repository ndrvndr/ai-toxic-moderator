import type {
  AiModerationSettingsConfiguration,
  AiModerationSettingsRecord,
} from '@moderator/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  getAiModerationSettings,
  saveAiModerationSettings,
} from '../features/moderation-settings/api/ai-moderation-settings-api.js';
import { AiModerationSettingsEditor } from '../features/moderation-settings/components/ai-moderation-settings-editor.js';
import { aiModerationSettingsKey } from '../features/moderation-settings/hooks/use-ai-moderation-settings.js';
import { ApiError, apiRequest } from '../lib/api-client.js';

vi.mock('../lib/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client.js')>()),
  apiRequest: vi.fn(),
}));

const accountId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000002';
const otherChannel = '20000000-0000-4000-8000-000000000003';
const configuration: AiModerationSettingsConfiguration = {
  schema_version: 1,
  automatic_actions_enabled: false,
  model: {
    model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
    model_revision: '0e011be8ba6aca297059e7ab1a07d4f11054e653',
    model_variant: 'INT8',
    adapter_version: 'laskar-shadow-1',
  },
  score_metric: 'EXPECTED_SEVERITY',
  delete: { enabled: true, threshold: 0.6 },
  timeout: { enabled: true, threshold: 0.8, duration_seconds: 30 },
  ban: { enabled: false, threshold: 0.95 },
};

let client: QueryClient;
let records: Map<string, AiModerationSettingsRecord>;
function record(
  channel = channelId,
  revision = 1,
  config = configuration,
): AiModerationSettingsRecord {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    channel_id: channel,
    revision,
    configuration: config,
    created_by: accountId,
    created_at: '2026-10-04T00:00:00Z',
  };
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  records = new Map();
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockImplementation(async (path, options) => {
    const channel = path.split('/')[3]!.toLowerCase();
    if (options?.method === 'POST') {
      const input = JSON.parse(options.body as string);
      const saved = record(channel, input.expected_revision + 1, {
        ...input.configuration,
        model: configuration.model,
      });
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
function editor(canEdit = true, channel = channelId, account = accountId) {
  return createElement(AiModerationSettingsEditor, {
    accountId: account,
    channelId: channel,
    canEdit,
  });
}
function preferences(config: AiModerationSettingsConfiguration) {
  const { model, ...input } = config;
  return input;
}
const posts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => options?.method === 'POST');
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));
}
function fill() {
  change('Delete threshold', '0.6');
  change('Timeout threshold', '0.8');
  change('Ban threshold', '0.95');
}

it('selects all new AI actions without implicit thresholds and saves an explicit scoped configuration', async () => {
  render(editor(), { wrapper });
  await screen.findByText('No AI settings saved yet. Choose your action limits before saving.');
  for (const label of ['Delete threshold', 'Timeout threshold', 'Ban threshold']) {
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
  }
  for (const label of [
    'Allow AI to take action in new sessions',
    'Allow AI delete',
    'Allow AI timeout',
    'Allow AI ban',
  ]) {
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
  }
  fill();
  change('AI timeout seconds', '60');
  save();
  await screen.findByText('AI settings revision 1 saved.');
  const input = JSON.parse(posts()[0]![1]!.body as string);
  expect(input.expected_revision).toBe(0);
  expect(input.configuration).not.toHaveProperty('model');
  for (const label of ['AI model ID', 'AI model revision', 'AI adapter version'])
    expect(screen.queryByLabelText(label)).toBeNull();
  expect(screen.queryByText(/Model variant/)).toBeNull();
  expect(input.configuration).toMatchObject({
    automatic_actions_enabled: true,
    delete: { enabled: true, threshold: 0.6 },
    timeout: { enabled: true, threshold: 0.8, duration_seconds: 60 },
    ban: { enabled: true, threshold: 0.95 },
  });
  expect(posts()[0]![0]).toBe(`/v1/channels/${channelId}/ai-moderation-settings`);
  expect(
    client.getQueryData<AiModerationSettingsRecord>(aiModerationSettingsKey(accountId, channelId))
      ?.revision,
  ).toBe(1);
  expect(client.getQueryData(aiModerationSettingsKey(accountId, otherChannel))).toBeUndefined();
});

it('preserves disabled saved actions instead of applying new-channel defaults', async () => {
  records.set(
    channelId,
    record(channelId, 3, {
      ...configuration,
      automatic_actions_enabled: false,
      delete: { ...configuration.delete, enabled: false },
      timeout: { ...configuration.timeout, enabled: false },
      ban: { ...configuration.ban, enabled: false },
    }),
  );
  render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 3.');
  for (const label of [
    'Allow AI to take action in new sessions',
    'Allow AI delete',
    'Allow AI timeout',
    'Allow AI ban',
  ])
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Ban threshold') as HTMLInputElement).value).toBe('0.95');
  expect(posts()).toHaveLength(0);
});

it('explains an incomplete first save near the save button and focuses the error without sending HTTP', async () => {
  render(editor(), { wrapper });
  await screen.findByText('No AI settings saved yet. Choose your action limits before saving.');
  const button = screen.getByRole('button', { name: 'Save AI settings' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  save();
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('delete.threshold');
  expect(document.activeElement).toBe(alert);
  const form = button.closest('form')!;
  const controls = form.querySelector('fieldset')!;
  expect(controls.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(posts()).toHaveLength(0);
  fill();
  save();
  await screen.findByText('AI settings revision 1 saved.');
  expect(posts()).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(button.disabled).toBe(true);
});

it('preserves model identity, disables saved AI policy, and uses each newly returned revision', async () => {
  records.set(
    channelId,
    record(channelId, 4, { ...configuration, automatic_actions_enabled: true }),
  );
  render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 4.');
  fireEvent.click(screen.getByLabelText('Allow AI to take action in new sessions'));
  save();
  await screen.findByText('AI settings revision 5 saved.');
  const first = JSON.parse(posts()[0]![1]!.body as string);
  expect(first.expected_revision).toBe(4);
  expect(first.configuration.automatic_actions_enabled).toBe(false);
  expect(first.configuration).not.toHaveProperty('model');
  expect(records.get(channelId)?.configuration.model).toEqual(configuration.model);
  fireEvent.click(screen.getByLabelText('Allow AI ban'));
  save();
  await screen.findByText('AI settings revision 6 saved.');
  expect(JSON.parse(posts()[1]![1]!.body as string).expected_revision).toBe(5);
});

it.each([
  ['Delete threshold', '', 'delete.threshold'],
  ['Delete threshold', '0.8', 'timeout.threshold'],
  ['Timeout threshold', '0.95', 'ban.threshold'],
  ['Ban threshold', '1.1', 'ban.threshold'],
  ['AI timeout seconds', '0', 'timeout.duration_seconds'],
  ['AI timeout seconds', '1.5', 'timeout.duration_seconds'],
])('validates %s = %s before HTTP', async (label, value, path) => {
  records.set(channelId, record());
  render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 1.');
  change(label, value);
  save();
  expect(screen.getByRole('alert').textContent).toContain(path);
  expect(document.activeElement).toBe(screen.getByRole('alert'));
  expect(posts()).toHaveLength(0);
});

it.each([409, 0])(
  'retains draft after error %s and requires an explicit reload',
  async (status) => {
    records.set(channelId, record());
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        records.set(channelId, record(channelId, 2));
        throw new ApiError(
          status,
          status === 409 ? 'AI_SETTINGS_REVISION_CONFLICT' : 'NETWORK_ERROR',
        );
      }
      return { settings: records.get(channelId) ?? null };
    });
    render(editor(), { wrapper });
    await screen.findByText('Saved AI revision: 1.');
    change('Timeout threshold', '0.85');
    save();
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Timeout threshold') as HTMLInputElement).value).toBe('0.85');
    expect(
      (screen.getByRole('button', { name: 'Save AI settings' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.submit(screen.getByLabelText('Timeout threshold').closest('form')!);
    expect(posts()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload AI settings and discard changes' }));
    await screen.findByText('Latest AI settings loaded. Unsaved changes were discarded.');
    expect((screen.getByLabelText('Timeout threshold') as HTMLInputElement).value).toBe('0.8');
    expect(screen.getByText('Saved AI revision: 2.')).toBeTruthy();
  },
);

it('keeps a draft when reload fails transiently instead of replacing it with cached settings', async () => {
  records.set(channelId, record());
  render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 1.');
  change('Timeout threshold', '0.85');
  vi.mocked(apiRequest).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload AI settings and discard changes' }));
  await screen.findByText('Unable to reload AI settings. Check your access and try again.');
  expect((screen.getByLabelText('Timeout threshold') as HTMLInputElement).value).toBe('0.85');
  expect(posts()).toHaveLength(0);
});

it('shows moderators read-only settings without a save control', async () => {
  records.set(channelId, record());
  render(editor(false), { wrapper });
  const control = await screen.findByLabelText('Allow AI to take action in new sessions');
  expect(control.closest('fieldset')?.disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save AI settings' })).toBeNull();
  fireEvent.submit(control.closest('form')!);
  expect(posts()).toHaveLength(0);
});

it.each([401, 403, 404])(
  'hides form and clears scoped cache after save access failure %s',
  async (status) => {
    records.set(channelId, record());
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') throw new ApiError(status, 'ACCESS_DENIED');
      return { settings: records.get(channelId) ?? null };
    });
    render(editor(), { wrapper });
    await screen.findByText('Saved AI revision: 1.');
    change('Timeout threshold', '0.85');
    save();
    await screen.findByText(
      'AI settings access changed. Sign in and reload this page to verify your permissions.',
    );
    expect(screen.queryByLabelText('Timeout threshold')).toBeNull();
    expect(client.getQueryData(aiModerationSettingsKey(accountId, channelId))).toBeNull();
  },
);

it('hides previously cached settings after a read access failure', async () => {
  client.setQueryData(aiModerationSettingsKey(accountId, channelId), record());
  vi.mocked(apiRequest).mockRejectedValue(new ApiError(403, 'CHANNEL_FORBIDDEN'));
  render(editor(), { wrapper });
  await screen.findByText('AI settings are unavailable. Verify your account and channel access.');
  expect(screen.queryByLabelText('Timeout threshold')).toBeNull();
  expect(client.getQueryData(aiModerationSettingsKey(accountId, channelId))).toBeNull();
});

it('resets private drafts when the channel or account changes', async () => {
  records.set(channelId, record());
  records.set(otherChannel, record(otherChannel));
  const view = render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 1.');
  change('Timeout threshold', '0.85');
  view.rerender(editor(true, otherChannel));
  await waitFor(() =>
    expect((screen.getByLabelText('Timeout threshold') as HTMLInputElement).value).toBe('0.8'),
  );
  change('Timeout threshold', '0.9');
  view.rerender(editor(true, otherChannel, '10000000-0000-4000-8000-000000000002'));
  await waitFor(() =>
    expect((screen.getByLabelText('Timeout threshold') as HTMLInputElement).value).toBe('0.8'),
  );
  expect(posts()).toHaveLength(0);
});

it('blocks duplicate submissions while a save is pending', async () => {
  records.set(channelId, record());
  let resolveSave!: (value: unknown) => void;
  vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST')
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    return { settings: record() };
  });
  render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 1.');
  change('Timeout threshold', '0.85');
  save();
  await waitFor(() => expect(posts()).toHaveLength(1));
  fireEvent.submit(screen.getByLabelText('Timeout threshold').closest('form')!);
  expect(posts()).toHaveLength(1);
  const submitted = JSON.parse(posts()[0]![1]!.body as string);
  resolveSave({
    settings: record(channelId, 2, { ...submitted.configuration, model: configuration.model }),
  });
  await screen.findByText('AI settings revision 2 saved.');
});

it('rejects a response for another channel and refuses unexpected save revisions or configurations', async () => {
  vi.mocked(apiRequest).mockResolvedValue({ settings: record(otherChannel) });
  await expect(getAiModerationSettings(channelId, new AbortController().signal)).rejects.toThrow(
    'channel mismatch',
  );
  vi.mocked(apiRequest).mockResolvedValue({ settings: record(channelId, 4) });
  await expect(
    saveAiModerationSettings(channelId, {
      expected_revision: 0,
      configuration: preferences(configuration),
    }),
  ).rejects.toThrow('Unexpected AI settings save result');
  vi.mocked(apiRequest).mockResolvedValue({
    settings: record(channelId, 1, { ...configuration, automatic_actions_enabled: true }),
  });
  await expect(
    saveAiModerationSettings(channelId, {
      expected_revision: 0,
      configuration: preferences(configuration),
    }),
  ).rejects.toThrow('Unexpected AI settings save result');
});

it('loads historical model settings and accepts the server model on a new save without technical controls', async () => {
  const old = {
    ...configuration,
    model: { ...configuration.model, model_revision: 'a'.repeat(40) },
  };
  records.set(channelId, record(channelId, 4, old));
  render(editor(), { wrapper });
  await screen.findByText('Saved AI revision: 4.');
  expect(screen.queryByLabelText('AI model revision')).toBeNull();
  change('Timeout threshold', '0.85');
  save();
  await screen.findByText('AI settings revision 5 saved.');
  expect(records.get(channelId)?.configuration.model).toEqual(configuration.model);
  expect(JSON.parse(posts()[0]![1]!.body as string).configuration).not.toHaveProperty('model');
});

it('explains missing application AI setup while retaining action preferences', async () => {
  vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') throw new ApiError(503, 'AI_MODEL_NOT_CONFIGURED');
    return { settings: null };
  });
  render(editor(), { wrapper });
  await screen.findByText('No AI settings saved yet. Choose your action limits before saving.');
  fill();
  save();
  await screen.findByText(/AI setup is not ready. Contact the app administrator/);
  expect((screen.getByLabelText('Timeout threshold') as HTMLInputElement).value).toBe('0.8');
  expect(screen.queryByLabelText('AI model ID')).toBeNull();
  expect(posts()).toHaveLength(1);
});
