import { aiShadowIdentity } from '@moderator/contracts';

import type { LaskarShadowAdapter } from './laskar-shadow-adapter';
import { loadLaskarShadow } from './load-laskar-shadow';

let adapter: LaskarShadowAdapter | null = null;
let busy = false;
process.on('disconnect', () => process.exit(0));
process.on('message', (message: unknown) => {
  void handle(message);
});

async function handle(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object' || busy) return;
  const value = message as Record<string, unknown>;
  busy = true;
  try {
    if (value.type === 'init' && !adapter && typeof value.cache_directory === 'string') {
      adapter = await loadLaskarShadow(value.cache_directory);
      if (adapter.revision !== value.revision) throw new Error('Model revision mismatch.');
      process.send?.({ type: 'ready', revision: adapter.revision });
    } else if (
      value.type === 'predict' &&
      adapter &&
      typeof value.request_id === 'string' &&
      typeof value.text === 'string'
    ) {
      const identity = aiShadowIdentity.parse(value.identity);
      const result = await adapter.predict(
        {
          channel_id: identity.channel_id,
          session_id: identity.session_id,
          observation_id: identity.observation_id,
          run_id: identity.run_id,
        },
        value.text,
      );
      process.send?.({ type: 'result', request_id: value.request_id, result });
    } else throw new Error('Invalid inference request.');
  } catch {
    process.send?.({ type: 'failed' });
    process.exitCode = 1;
    process.disconnect?.();
  } finally {
    busy = false;
  }
}
