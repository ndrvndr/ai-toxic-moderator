import type { AppConfig } from '@moderator/config';
import { uuid } from '@moderator/contracts';
import { transaction, type createPool } from '@moderator/persistence';
import { AiActionPlanStore } from './ai-action-plan-store';
import { AI_UNOPPOSED_SQL } from './ai-dispatch-provenance';

/** Recovers committed audits whose action slots were not materialized before shutdown. */
export class AiActionPlanCycle {
  private readonly runId: string;
  private busy = false;

  constructor(
    runId: string,
    private readonly pool: ReturnType<typeof createPool>,
    private readonly store: Pick<AiActionPlanStore, 'save'> = new AiActionPlanStore(),
  ) {
    this.runId = uuid.parse(runId).toLowerCase();
  }

  async tick(signal: AbortSignal) {
    if (signal.aborted) return { kind: 'CANCELLED' as const };
    if (this.busy) return { kind: 'BUSY' as const };
    this.busy = true;
    try {
      const result = await this.pool.query<{ id: string }>(
        `SELECT d.id FROM youtube_ai_action_decisions d
         JOIN youtube_chat_classifications c ON c.id=d.classification_id AND c.channel_id=d.channel_id AND c.session_id=d.session_id
         JOIN youtube_chat_observations o ON o.id=d.observation_id AND o.channel_id=d.channel_id AND o.session_id=d.session_id
         JOIN monitoring_runs r ON r.id=d.run_id AND r.channel_id=d.channel_id AND r.session_id=d.session_id
         WHERE r.id=$1 AND r.status='RUNNING' AND r.stop_requested_at IS NULL AND r.finished_at IS NULL
           AND d.decision->>'reason_code'='THRESHOLD_MET' AND ${AI_UNOPPOSED_SQL}
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(d.decision->'plans') planned
             WHERE NOT EXISTS (SELECT 1 FROM youtube_moderation_action_plans p
               WHERE p.classification_id=d.classification_id AND p.channel_id=d.channel_id
                 AND p.session_id=d.session_id AND p.policy_version=planned->>'policy_version')
           )
         ORDER BY d.created_at,d.id LIMIT 1`,
        [this.runId],
      );
      if (signal.aborted) return { kind: 'CANCELLED' as const };
      const candidate = result.rows[0];
      if (!candidate) return { kind: 'IDLE' as const };
      const id = uuid.parse(candidate.id).toLowerCase();
      const saved = await transaction(this.pool, async (client) => {
        if (signal.aborted) return null;
        return this.store.save(client, id, this.runId);
      });
      return saved === null
        ? { kind: 'CANCELLED' as const }
        : {
            kind: 'PROCESSED' as const,
            decision_id: id,
            inserted: saved.filter((plan) => !plan.reused).length,
          };
    } finally {
      this.busy = false;
    }
  }
}

export function createAiActionPlanCycle(
  config: Pick<AppConfig, 'AI_SHADOW_ENABLED' | 'AI_SHADOW_RUN_ID'>,
  pool: ReturnType<typeof createPool>,
): AiActionPlanCycle | undefined {
  if (!config.AI_SHADOW_ENABLED) return undefined;
  return new AiActionPlanCycle(config.AI_SHADOW_RUN_ID, pool);
}
