import { uuid } from '@moderator/contracts';
import { appendLiveEvent, type PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';
import { ActionPlanStore } from './action-plan-store';
import { AI_UNOPPOSED_SQL, readAiActionEvidence } from './ai-dispatch-provenance';

/** Only persisted, recomputed AI evidence can produce executor-visible action slots. */
export class AiActionPlanStore {
  async save(client: PoolClient, decisionInput: string, runInput: string) {
    const decisionId = uuid.parse(decisionInput).toLowerCase();
    const runId = uuid.parse(runInput).toLowerCase();
    const savepoint = `ai_plans_${randomUUID().replaceAll('-', '')}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `ai-plans:${decisionId}`,
      ]);
      const record = await readAiActionEvidence(client, decisionId, runId);
      if (!record) throw new Error('AI action evidence is invalid or unavailable.');
      const eligible = await client.query(
        `SELECT d.id FROM youtube_ai_action_decisions d
         JOIN youtube_chat_classifications c ON c.id=d.classification_id AND c.channel_id=d.channel_id AND c.session_id=d.session_id
         JOIN youtube_chat_observations o ON o.id=d.observation_id AND o.channel_id=d.channel_id AND o.session_id=d.session_id
         JOIN monitoring_runs r ON r.id=d.run_id AND r.channel_id=d.channel_id AND r.session_id=d.session_id
         WHERE d.id=$1 AND r.id=$2 AND r.status='RUNNING' AND r.stop_requested_at IS NULL
           AND r.finished_at IS NULL AND ${AI_UNOPPOSED_SQL}`,
        [decisionId, runId],
      );
      const plans: Awaited<ReturnType<ActionPlanStore['save']>>[] = [];
      if (eligible.rows.length && record.decision.reason_code === 'THRESHOLD_MET') {
        const store = new ActionPlanStore();
        for (const plan of record.decision.plans) plans.push(await store.save(client, plan));
      }
      if (plans.some((plan) => !plan.reused)) {
        await appendLiveEvent(client, {
          channelId: record.decision.context.channel_id,
          sessionId: record.decision.context.session_id,
          runId,
          type: 'chat.updated',
        });
      }
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return plans;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}
