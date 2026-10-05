import { moderationSettingsConfiguration, uuid } from '@moderator/contracts';
import { SettingsActionPlanner } from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';
import { z } from 'zod';

import type { ClassificationObservation } from './classification-store';

const snapshot = z
  .strictObject({
    run_id: uuid,
    settings_id: uuid.nullable(),
    settings_revision: z.number().int().positive().nullable(),
    source: z.enum(['SAVED', 'DEFAULT', 'LEGACY']),
    configuration: moderationSettingsConfiguration,
  })
  .superRefine((value, context) => {
    if (value.source === 'SAVED') {
      if (!value.settings_id || value.settings_revision === null) {
        context.addIssue({ code: 'custom', message: 'Saved snapshots require revision metadata.' });
      }
    } else if (
      value.settings_id !== null ||
      value.settings_revision !== null ||
      value.configuration.automatic_actions_enabled ||
      value.configuration.rules.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Default and legacy snapshots must disable actions.',
      });
    }
  });

/** Legacy snapshot reader retained for historical-policy compatibility tests; not used by the worker. */
export class RunSettingsPlanner {
  async resolve(client: PoolClient, observation: ClassificationObservation) {
    const runId = uuid.parse(observation.runId).toLowerCase();
    const channelId = uuid.parse(observation.channelId).toLowerCase();
    const sessionId = uuid.parse(observation.sessionId).toLowerCase();
    const result = await client.query(
      `SELECT snapshot.run_id, snapshot.settings_id, snapshot.settings_revision,
              snapshot.source, snapshot.configuration
       FROM monitoring_settings_snapshots snapshot
       JOIN monitoring_runs run ON run.id = snapshot.run_id
         AND run.channel_id = snapshot.channel_id
       WHERE snapshot.run_id = $1 AND snapshot.channel_id = $2 AND run.session_id = $3`,
      [runId, channelId, sessionId],
    );
    if (result.rows.length !== 1) {
      throw new Error('The classification run has no settings snapshot in the requested scope.');
    }
    const selected = snapshot.parse(result.rows[0]);
    if (selected.run_id !== runId) throw new Error('The settings snapshot belongs to another run.');
    return new SettingsActionPlanner(selected.configuration, `settings-run-${runId}`);
  }
}
