import { aiShadowResult, type AiShadowResult } from '@moderator/contracts';
import { transaction, type createPool } from '@moderator/persistence';

import { AiShadowStore } from './ai-shadow-store';

export class AiShadowResultWriter {
  constructor(
    private readonly pool: ReturnType<typeof createPool>,
    private readonly store: Pick<AiShadowStore, 'save'> = new AiShadowStore(),
  ) {}

  async save(input: AiShadowResult) {
    const result = aiShadowResult.parse(input);
    // Only persistence holds a transaction; the coordinator has already finished inference.
    return transaction(this.pool, (client) => this.store.save(client, result));
  }
}
