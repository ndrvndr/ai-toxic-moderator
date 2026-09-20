import { z } from 'zod';

export const category = z.enum([
  'PROFANITY',
  'HARASSMENT',
  'HATE',
  'THREAT',
  'SEXUAL',
  'GAMBLING',
  'SPAM',
  'SCAM',
  'PII',
  'SELF_HARM_ENCOURAGEMENT',
  'IMPERSONATION',
  'SUSPICIOUS_LINK',
]);

export const outcome = z.enum(['ALLOW', 'REVIEW', 'ACTION_REQUIRED', 'ERROR']);
