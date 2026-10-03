import { aiShadowResult, type AiShadowResult } from '@moderator/contracts';
import { appendLiveEvent, transaction, type createPool } from '@moderator/persistence';

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
      const saved = await this.store.save(client, result);
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
