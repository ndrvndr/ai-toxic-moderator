import { z } from 'zod';

import { category, outcome } from './moderation-enums';

export * from './chat';
export * from './history-action-statistics';
export * from './history-statistics';
export * from './moderation-action';
export { category, outcome } from './moderation-enums';
export * from './moderation-rule-catalog';
export * from './moderation-settings';
export * from './monitoring';
export * from './saved-sessions';
export * from './youtube-ingestion';

export const uuid = z.uuid();

const text = (max: number) =>
  z.string().refine((s) => s.trim().length > 0 && [...s].length <= max, 'Invalid text length');
export const messageInput = z.strictObject({
  external_message_id: text(128),
  author_external_id: text(128),
  author_display_name: text(100),
  raw_text: text(2000),
  published_at: z.iso.datetime({ offset: true }),
});
export const span = z
  .strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((s) => s.end > s.start, 'Span must be non-empty');
export const evidence = z
  .strictObject({
    representation_type: z.enum(['RAW', 'NORMALIZED']),
    matched_text: text(2000),
    normalized_span: span,
    raw_span: span.nullable(),
    mapping_quality: z.enum(['EXACT', 'UNAVAILABLE']),
  })
  .refine(
    (e) => (e.mapping_quality === 'EXACT') === (e.raw_span !== null),
    'Raw mapping must match quality',
  );
export const signal = z.strictObject({
  rule_id: text(128),
  rule_version: text(128),
  category,
  severity: z.number().int().min(0).max(4),
  strength: z.enum(['STRONG', 'AMBIGUOUS']),
  confidence: z.null(),
  intent: text(128),
  evidence: z.array(evidence).min(1),
});
export const feedbackInput = z
  .strictObject({
    label: z.enum([
      'CORRECT',
      'FALSE_POSITIVE',
      'FALSE_NEGATIVE',
      'WRONG_CATEGORY',
      'CONTEXT_MISUNDERSTOOD',
    ]),
    corrected_category: category.nullish(),
    corrected_outcome: outcome.nullish(),
    notes: text(2000).nullish(),
  })
  .superRefine((v, ctx) => {
    const error = (path: string) =>
      ctx.addIssue({
        code: 'custom',
        path: [path],
        message: 'Required correction missing or invalid',
      });
    if (v.label === 'FALSE_POSITIVE' && v.corrected_outcome !== 'ALLOW') error('corrected_outcome');
    if (v.label === 'WRONG_CATEGORY' && !v.corrected_category) error('corrected_category');
    if (v.label === 'FALSE_NEGATIVE') {
      if (!v.corrected_category) error('corrected_category');
      if (v.corrected_outcome !== 'REVIEW' && v.corrected_outcome !== 'ACTION_REQUIRED')
        error('corrected_outcome');
    }
  });
export const chatAccepted = z.strictObject({
  event_id: uuid,
  event_type: z.literal('chat.accepted'),
  schema_version: z.literal(1),
  channel_id: uuid,
  session_id: uuid,
  trace_id: uuid,
  occurred_at: z.iso.datetime(),
  payload: z.strictObject({ message_id: uuid, task_id: uuid, evaluation_run_id: uuid }),
});
export const versionBundle = z.strictObject({
  schema_version: z.literal(1),
  configuration_bundle_id: uuid,
  processor_version: text(128),
  ruleset_version: text(128),
  policy_version: text(128),
  model: z.strictObject({ status: z.literal('DISABLED'), version: z.null() }),
});
export const simulatedAction = z.strictObject({
  id: uuid,
  action_type: z.literal('DELETE'),
  status: z.literal('SIMULATED'),
});
export const decisionSummary = z
  .strictObject({
    id: uuid,
    message_id: uuid,
    session_id: uuid,
    evaluation_run_id: uuid,
    created_at: z.iso.datetime(),
    author_display_name: text(100),
    raw_text: text(2000),
    outcome,
    primary_category: category.nullable(),
    severity: z.number().int().min(0).max(4).nullable(),
    confidence: z.null(),
    reason: text(2000),
    mode: z.literal('SIMULATION'),
    actions: z.array(simulatedAction),
  })
  .refine(
    (d) => (d.outcome === 'ACTION_REQUIRED' ? d.actions.length > 0 : d.actions.length === 0),
    'Action plan conflicts with outcome',
  );
export const taskResponse = z.strictObject({
  id: uuid,
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
  decision_id: uuid.nullable(),
  last_error_code: z.string().nullable(),
});
export const ingestionResponse = z.strictObject({
  message_id: uuid,
  task_id: uuid,
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
  decision_id: uuid.nullable(),
  duplicate: z.boolean(),
});
export const feedbackRecord = z.strictObject({
  id: uuid,
  label: feedbackInput.shape.label,
  corrected_category: category.nullable(),
  corrected_outcome: outcome.nullable(),
  notes: z.string().nullable(),
  reviewer: z.strictObject({ id: uuid, display_name: text(100) }),
  created_at: z.iso.datetime(),
});
export const riskSnapshot = z.strictObject({
  content_risk: z.null(),
  intent_risk: z.null(),
  behavior_risk: z.null(),
  context_risk: z.null(),
  availability: z.literal('NOT_EVALUATED'),
});
export const decisionDetail = decisionSummary.safeExtend({
  message: z.strictObject({
    id: uuid,
    external_message_id: text(128),
    author_external_id: text(128),
    raw_text: text(2000),
    published_at: z.iso.datetime(),
    received_at: z.iso.datetime(),
  }),
  reason_code: z.enum([
    'NO_RULE_MATCH',
    'CONTEXT_REQUIRED',
    'GAMBLING_PROMOTION',
    'DIRECT_INSULT',
    'PROCESSING_FAILED',
  ]),
  representations: z.array(
    z.strictObject({
      type: z.enum(['RAW', 'NORMALIZED']),
      text: z.string(),
      processor_version: text(128),
      mapping_quality: z.enum(['EXACT', 'UNAVAILABLE']),
    }),
  ),
  signals: z.array(signal),
  risk_snapshot: riskSnapshot,
  version_bundle: versionBundle,
  feedback: z.array(feedbackRecord),
});
export const decimalCursor = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const decisionsPage = z.strictObject({
  items: z.array(decisionSummary),
  next_cursor: z.string().nullable(),
  watermark: decimalCursor,
});
export const sessionRecord = z.strictObject({
  id: uuid,
  label: text(200),
  source: z.literal('SYNTHETIC'),
  created_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  primary_run_id: uuid,
});
export const sessionsPage = z.strictObject({
  items: z.array(sessionRecord),
  next_cursor: z.string().nullable(),
});
export const meResponse = z.strictObject({
  account: z.strictObject({ id: uuid, display_name: text(100) }),
  memberships: z.array(
    z.strictObject({ channel_id: uuid, role: z.enum(['OWNER', 'MODERATOR', 'OPERATOR']) }),
  ),
});
export const feedResource = z.strictObject({
  schema_version: z.literal(1),
  event_id: uuid,
  channel_id: uuid,
  session_id: uuid,
  resource_id: uuid,
  occurred_at: z.iso.datetime(),
});
export const resyncRequired = z.strictObject({
  schema_version: z.literal(1),
  reason: z.enum(['CURSOR_EXPIRED', 'CURSOR_RESET']),
});
export const apiError = z.strictObject({
  error: z.strictObject({
    code: text(128),
    message: text(2000),
    field_errors: z.array(z.strictObject({ field: z.string(), code: text(128) })),
    trace_id: uuid,
  }),
});
export const decisionsQuery = z.strictObject({
  session_id: uuid.optional(),
  outcome: outcome.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: text(2048).optional(),
});
export type MessageInput = z.infer<typeof messageInput>;
export type ChatAccepted = z.infer<typeof chatAccepted>;
export type Signal = z.infer<typeof signal>;
export type DecisionSummary = z.infer<typeof decisionSummary>;
export const devSessionInput = z.strictObject({});
export const devSessionResponse = z.strictObject({ expires_at: z.iso.datetime() });
export const sessionsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: text(2048).optional(),
});
export const sessionCursor = z.strictObject({
  channel_id: uuid,
  created_at: z.iso.datetime({ offset: true }),
  id: uuid,
});
