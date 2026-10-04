import type { MessageInput, Signal } from '@moderator/contracts';
/** Boundary for M1-06. No classifier is implemented by the foundation. */
export interface DetectionEngine {
  detect(message: MessageInput): Promise<readonly Signal[]>;
}
export * from './action-planner';
export * from './ai-action-planner';
export * from './blacklist-action-planner';
export * from './custom-blacklist-matcher';
export * from './policy-evaluator';
export * from './rule-engine';
export * from './settings-action-planner';
