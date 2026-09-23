import { uuid } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';
import { parseYoutubeBanEvent, type YoutubeBanEventEvidence } from '@moderator/provider-adapters';

import { matchBanEvidence, type UnknownBanAttempt } from './ban-evidence-matcher';

type AttemptRow = {
  id: string;
  channel_id: string;
  session_id: string;
  live_chat_id: string;
  author_channel_id: string;
  moderator_channel_id: string;
  action: 'TIMEOUT' | 'BAN';
  duration_seconds: string | null;
  started_at: string;
  deadline_at: string;
};

export type BanEvidencePage = {
  attemptId: string;
  matches: Array<{
    observationId: string;
    evidence: YoutubeBanEventEvidence;
    attribution: 'UNPROVEN';
  }>;
  nextCursor: string | null;
};

export class BanEvidenceReader {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async nextAttempt(after: string | null = null): Promise<string | null> {
    if (after !== null) uuid.parse(after);

    const result = await this.pool.query<{ id: string }>(
      `
        SELECT id
        FROM youtube_ban_attempts
        WHERE status = 'UNKNOWN'
          AND credential_account_id IS NOT NULL
          AND moderator_channel_id IS NOT NULL
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT 1
      `,
      [after],
    );

    return result.rows[0]?.id ?? null;
  }

  async read(
    attemptId: string,
    after: string | null = null,
    limit = 100,
  ): Promise<BanEvidencePage | null> {
    uuid.parse(attemptId);
    if (after !== null) uuid.parse(after);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Evidence page size must be between 1 and 100.');
    }

    const attempts = await this.pool.query<AttemptRow>(
      `
        SELECT
          a.id,
          e.channel_id,
          e.session_id,
          e.live_chat_id,
          e.author_channel_id,
          a.moderator_channel_id,
          e.action,
          e.duration_seconds::text,
          to_char(
            a.started_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS started_at,
          to_char(
            a.deadline_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS deadline_at
        FROM youtube_ban_attempts a
        JOIN youtube_ban_executions e ON e.id = a.execution_id
        WHERE a.id = $1
          AND a.status = 'UNKNOWN'
          AND a.credential_account_id IS NOT NULL
          AND a.moderator_channel_id IS NOT NULL
      `,
      [attemptId],
    );

    const row = attempts.rows[0];
    if (!row) return null;

    const attempt: UnknownBanAttempt = {
      status: 'UNKNOWN',
      action: row.action,
      liveChatId: row.live_chat_id,
      targetChannelId: row.author_channel_id,
      moderatorChannelId: row.moderator_channel_id,
      durationSeconds: row.duration_seconds,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
    };

    const observations = await this.pool.query<{
      id: string;
      external_message_id: string;
      payload: unknown;
    }>(
      `
        SELECT o.id, o.external_message_id, o.payload
        FROM youtube_chat_observations o
        WHERE o.channel_id = $1
          AND o.session_id = $2
          AND o.event_type = 'userBannedEvent'
          AND o.published_at >= $3::timestamptz
          AND o.published_at <= $4::timestamptz
          AND ($5::uuid IS NULL OR o.id > $5::uuid)
        ORDER BY o.id
        LIMIT $6
      `,
      [row.channel_id, row.session_id, row.started_at, row.deadline_at, after, limit + 1],
    );

    const page = observations.rows.slice(0, limit);
    const matches: BanEvidencePage['matches'] = [];

    for (const observation of page) {
      const evidence = parseYoutubeBanEvent(observation.payload);

      if (!evidence || evidence.externalEventId !== observation.external_message_id) {
        continue;
      }

      const match = matchBanEvidence(attempt, evidence);
      if (!match.matched) continue;

      matches.push({
        observationId: observation.id,
        evidence,
        attribution: match.attribution,
      });
    }

    return {
      attemptId,
      matches,
      nextCursor: observations.rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
