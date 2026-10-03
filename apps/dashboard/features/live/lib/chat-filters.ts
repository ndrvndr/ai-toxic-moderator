import type { ChatEvaluation, ChatObservation } from '@moderator/contracts';

export type ChatFilters = {
  outcome?: ChatObservation['evaluation_status'];
  category?: NonNullable<ChatEvaluation['primary_category']>;
};
