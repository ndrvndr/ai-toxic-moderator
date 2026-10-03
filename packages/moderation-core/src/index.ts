import type { MessageInput, Signal } from '@moderator/contracts';
/** Boundary for M1-06. No classifier is implemented by the foundation. */
export interface DetectionEngine {
  detect(message: MessageInput): Promise<readonly Signal[]>;
}
export * from './action-planner';
export * from './policy-evaluator';
export * from './rule-engine';
export * from './settings-action-planner';
