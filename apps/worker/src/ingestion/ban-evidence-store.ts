import { uuid } from '@moderator/contracts';
import { appendLiveEvent, transaction, type createPool } from '@moderator/persistence';
import { parseYoutubeBanEvent } from '@moderator/provider-adapters';

import { matchBanEvidence, type UnknownBanAttempt } from './ban-evidence-matcher';

type EvidenceSource = {
  action: 'TIMEOUT' | 'BAN';
  live_chat_id: string;
  author_channel_id: string;
  moderator_channel_id: string;
  duration_seconds: string | null;
  started_at: string;
  deadline_at: string;
  external_message_id: string;
  payload: unknown;
};

export type SaveBanEvidenceResult = 'INSERTED' | 'EXISTING' | 'NOT_MATCHED';

export class BanEvidenceStore {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async save(attemptId: string, observationId: string): Promise<SaveBanEvidenceResult> {
    uuid.parse(attemptId);
    uuid.parse(observationId);

    return transaction(this.pool, async (client) => {
      const source = await client.query<EvidenceSource>(
        `
          SELECT
            e.action,
            e.live_chat_id,
            e.author_channel_id,
            a.moderator_channel_id,
            e.duration_seconds::text,
            to_char(
              a.started_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS started_at,
            to_char(
              a.deadline_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS deadline_at,
            o.external_message_id,
            o.payload
          FROM youtube_ban_attempts a
          JOIN youtube_ban_executions e ON e.id = a.execution_id
          JOIN youtube_chat_observations o
            ON o.id = $2
            AND o.channel_id = e.channel_id
            AND o.session_id = e.session_id
          WHERE a.id = $1
            AND a.status = 'UNKNOWN'
            AND a.credential_account_id IS NOT NULL
            AND a.moderator_channel_id IS NOT NULL
            AND o.event_type = 'userBannedEvent'
            AND o.published_at BETWEEN a.started_at AND a.deadline_at
        `,
        [attemptId, observationId],
      );

      const row = source.rows[0];
      if (!row) return 'NOT_MATCHED';

      const evidence = parseYoutubeBanEvent(row.payload);

      if (!evidence || evidence.externalEventId !== row.external_message_id) {
        return 'NOT_MATCHED';
      }

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

      if (!matchBanEvidence(attempt, evidence).matched) {
        return 'NOT_MATCHED';
      }

      // Validate the payload timestamp against persisted metadata using
      // PostgreSQL precision rather than JavaScript millisecond precision.
      const timestamp = await client.query(
        `
          SELECT id
          FROM youtube_chat_observations
          WHERE id = $1
            AND published_at = $2::timestamptz
        `,
        [observationId, evidence.publishedAt],
      );

      if (!timestamp.rows.length) return 'NOT_MATCHED';

      const inserted = await client.query(
        `
          INSERT INTO youtube_ban_evidence(
            attempt_id,
            observation_id
          )
          VALUES($1, $2)
          ON CONFLICT (attempt_id, observation_id) DO NOTHING
          RETURNING attempt_id
        `,
        [attemptId, observationId],
      );

      if (inserted.rowCount !== 1) return 'EXISTING';

      const scope = await client.query<{
        channel_id: string;
        session_id: string;
        run_id: string;
      }>(
        `
    SELECT e.channel_id, e.session_id, c.run_id
    FROM youtube_ban_attempts a
    JOIN youtube_ban_executions e ON e.id = a.execution_id
    JOIN youtube_moderation_action_plans p
      ON p.id = e.plan_id
      AND p.channel_id = e.channel_id
      AND p.session_id = e.session_id
    JOIN youtube_chat_classifications c
      ON c.id = p.classification_id
      AND c.channel_id = p.channel_id
      AND c.session_id = p.session_id
    WHERE a.id = $1
  `,
        [attemptId],
      );

      const provenance = scope.rows[0];

      if (!provenance) {
        throw new Error('Evidence publication requires execution provenance.');
      }

      await appendLiveEvent(client, {
        channelId: provenance.channel_id,
        sessionId: provenance.session_id,
        runId: provenance.run_id,
        type: 'chat.updated',
      });

      return 'INSERTED';
    });
  }
}
