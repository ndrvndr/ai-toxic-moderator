import { customBlacklistSnapshot, uuid, type CustomBlacklistSnapshot } from '@moderator/contracts';
import {
  CUSTOM_BLACKLIST_MATCHER_VERSION,
  CustomBlacklistMatcher,
  type CustomBlacklistDecision,
} from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';

export type RunBlacklistScope = {
  runId: string;
  channelId: string;
  sessionId: string;
};

export type RunBlacklistProvenance = {
  run_id: string;
  channel_id: string;
  session_id: string;
  blacklist_id: string | null;
  blacklist_revision: number | null;
  source: CustomBlacklistSnapshot['source'];
  matcher_version: typeof CUSTOM_BLACKLIST_MATCHER_VERSION;
};

export type RunBlacklistDecision = CustomBlacklistDecision & {
  provenance: RunBlacklistProvenance;
};

/** Read only the run's captured policy through the caller's transaction client. */
export class RunBlacklistMatcher {
  async resolve(client: PoolClient, scope: RunBlacklistScope) {
    const runId = uuid.parse(scope.runId).toLowerCase();
    const channelId = uuid.parse(scope.channelId).toLowerCase();
    const sessionId = uuid.parse(scope.sessionId).toLowerCase();
    const result = await client.query<CustomBlacklistSnapshot & { session_id: string }>(
      `SELECT snapshot.run_id, snapshot.channel_id, snapshot.blacklist_id,
              snapshot.blacklist_revision, snapshot.source, snapshot.configuration,
              run.session_id
       FROM monitoring_blacklist_snapshots snapshot
       JOIN monitoring_runs run ON run.id = snapshot.run_id
         AND run.channel_id = snapshot.channel_id
       WHERE snapshot.run_id = $1 AND snapshot.channel_id = $2 AND run.session_id = $3`,
      [runId, channelId, sessionId],
    );
    if (result.rows.length !== 1) {
      throw new Error(
        'The monitoring run has no unique blacklist snapshot in the requested scope.',
      );
    }
    const { session_id: selectedSessionId, ...row } = result.rows[0]!;
    const selected = customBlacklistSnapshot.parse(row);
    if (
      selected.run_id.toLowerCase() !== runId ||
      selected.channel_id.toLowerCase() !== channelId ||
      uuid.parse(selectedSessionId).toLowerCase() !== sessionId
    ) {
      throw new Error('The blacklist snapshot belongs to another run, channel, or session.');
    }
    const provenance: RunBlacklistProvenance = {
      run_id: runId,
      channel_id: channelId,
      session_id: sessionId,
      blacklist_id: selected.blacklist_id?.toLowerCase() ?? null,
      blacklist_revision: selected.blacklist_revision,
      source: selected.source,
      matcher_version: CUSTOM_BLACKLIST_MATCHER_VERSION,
    };
    return {
      matcher: new CustomBlacklistMatcher(selected.configuration),
      provenance,
      snapshot: selected,
    };
  }

  async match(
    client: PoolClient,
    scope: RunBlacklistScope,
    rawText: string,
  ): Promise<RunBlacklistDecision> {
    const { matcher, provenance } = await this.resolve(client, scope);
    return { ...matcher.match(rawText), provenance };
  }
}
