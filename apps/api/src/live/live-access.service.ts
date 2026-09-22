import { Injectable } from '@nestjs/common';

import {
  InvalidLiveEventCursorError,
  LiveEventSessionNotFoundError,
  readLiveEvents,
  transaction,
} from '@moderator/persistence';

import { SessionService } from '../auth/session.service';
import { DatabaseService } from '../database.module';

export class LiveAccessError extends Error {
  constructor(
    readonly status: number,
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'LiveAccessError';
  }
}

export type LiveSubscription = {
  channelId: string;
  sessionId: string;
  after: string | null;
};

@Injectable()
export class LiveAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  async read(token: string | null, subscription: LiveSubscription) {
    const account = await this.sessions.resolve(token);

    if (!account) {
      throw new LiveAccessError(401, 4001, 'Authentication required.');
    }

    try {
      return await transaction(this.database.pool, async (client) => {
        const membership = await client.query<{ role: string }>(
          `
            SELECT role
            FROM channel_memberships
            WHERE channel_id = $1 AND account_id = $2
            FOR SHARE
          `,
          [subscription.channelId, account.id],
        );

        if (!['OWNER', 'MODERATOR'].includes(membership.rows[0]?.role ?? '')) {
          throw new LiveAccessError(403, 4003, 'Channel access denied.');
        }

        return readLiveEvents(client, {
          ...subscription,
          limit: 100,
        });
      });
    } catch (error) {
      if (error instanceof InvalidLiveEventCursorError) {
        throw new LiveAccessError(400, 4000, 'Invalid live event cursor.');
      }

      if (error instanceof LiveEventSessionNotFoundError) {
        throw new LiveAccessError(404, 4004, 'Live session not found.');
      }

      throw error;
    }
  }
}
