import { aiShadowResult, type AiShadowResult } from '@moderator/contracts';
import { appendLiveEvent, transaction, type createPool } from '@moderator/persistence';

import { AI_MAX_QUEUE_AGE_MS, expiredAiInput } from './ai-backlog-policy';
import { AiShadowStore } from './ai-shadow-store';

export class AiShadowResultWriter {
  constructor(
    private readonly pool: ReturnType<typeof createPool>,
    private readonly store: Pick<AiShadowStore, 'save'> = new AiShadowStore(),
    private readonly publish: typeof appendLiveEvent = appendLiveEvent,
  ) {}

  async save(input: AiShadowResult) {
    const result = aiShadowResult.parse(input);
    // Only persistence holds a transaction; the coordinator has already finished inference.
    return transaction(this.pool, async (client) => {
      let considered = result;
      if (result.status === 'SUCCEEDED') {
        // Use the database clock again after inference and connection acquisition.
        const age = await client.query<{ expired: boolean }>(
          `SELECT clock_timestamp() - received_at >= $5::double precision * interval '1 millisecond' AS expired
           FROM youtube_chat_observations
           WHERE id=$1 AND channel_id=$2 AND session_id=$3 AND first_observed_run_id=$4`,
          [
            result.observation_id,
            result.channel_id,
            result.session_id,
            result.run_id,
            AI_MAX_QUEUE_AGE_MS,
          ],
        );
        if (typeof age.rows[0]?.expired !== 'boolean')
          throw new Error('AI input age could not be verified.');
        if (age.rows[0].expired)
          considered = expiredAiInput({
            channel_id: result.channel_id,
            session_id: result.session_id,
            observation_id: result.observation_id,
            run_id: result.run_id,
            model_id: result.model_id,
            model_revision: result.model_revision,
            model_variant: result.model_variant,
            adapter_version: result.adapter_version,
          });
      }
      const saved = await this.store.save(client, considered);
      if (saved.inserted) {
        await this.publish(client, {
          channelId: saved.result.channel_id,
          sessionId: saved.result.session_id,
          runId: saved.result.run_id,
          type: 'chat.updated',
        });
      }
      return saved;
    });
  }
}
