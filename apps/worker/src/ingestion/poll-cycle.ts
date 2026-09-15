import {
  YoutubeChatError,
  type GoogleTokenStore,
  type YoutubeChatAdapter,
} from '@moderator/provider-adapters';

import { BatchWriter } from './batch-writer';
import { LeaseStore, type WorkerLease } from './lease-store';

export class PollCycle {
  constructor(
    private readonly leases: LeaseStore,
    private readonly writer: BatchWriter,
    private readonly tokens: Pick<GoogleTokenStore, 'accessToken'>,
    private readonly chat: Pick<YoutubeChatAdapter, 'list'>,
  ) {}

  async run(lease: WorkerLease, signal?: AbortSignal) {
    this.checkCancellation(signal);

    const context = await this.leases.withLease(lease, async (client) => {
      const result = await client.query<{
        status: string;
        credential_account_id: string;
        live_chat_id: string;
      }>(
        `
          SELECT
            run.status,
            run.credential_account_id,
            broadcast.live_chat_id
          FROM monitoring_runs run
          JOIN youtube_broadcasts broadcast
            ON broadcast.channel_id = run.channel_id
            AND broadcast.session_id = run.session_id
          WHERE run.id = $1
        `,
        [lease.run_id],
      );

      return result.rows[0]!;
    });

    if (context.status === 'STOPPING') {
      return { kind: 'STOP_REQUESTED' as const };
    }

    const checkpoint = await this.writer.checkpoint(lease);

    if (!checkpoint.due) {
      return {
        kind: 'WAIT' as const,
        next_poll_at: checkpoint.next_poll_at,
      };
    }

    // Token refresh and YouTube requests must not run inside a lease transaction.
    const accessToken = await this.tokens.accessToken(context.credential_account_id);

    this.checkCancellation(signal);
    await this.leases.heartbeat(lease);

    const page = await this.chat.list({
      accessToken,
      liveChatId: context.live_chat_id,
      pageToken: checkpoint.next_page_token,
      ...(signal ? { signal } : {}),
    });

    this.checkCancellation(signal);

    const persisted = await this.writer.commit(lease, {
      expected_revision: checkpoint.revision,
      request_page_token: checkpoint.next_page_token,
      next_page_token: page.next_page_token,
      polling_interval_ms: page.polling_interval_ms,
      items: page.items,
    });

    return {
      kind: 'POLLED' as const,
      inserted: persisted.inserted,
      revision: persisted.revision,
      offline_at: page.offline_at,
      chat_ended: page.items.some((item) => item.snippet.type === 'chatEndedEvent'),
    };
  }

  private checkCancellation(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new YoutubeChatError('REQUEST_CANCELLED');
    }
  }
}
