import { z } from 'zod';

const port = z.coerce.number().int().min(1024).max(65535);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test']).default('development'),
  API_PORT: port.default(3001),
  DATABASE_URL: z
    .url()
    .refine(
      (v) => ['postgresql:', 'postgres:'].includes(new URL(v).protocol),
      'PostgreSQL URL required',
    ),
  REDIS_HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  REDIS_PORT: port.default(56379),
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AI_SHADOW_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AI_SHADOW_RUN_ID: z.union([z.literal(''), z.uuid()]).default(''),
  AI_SHADOW_MODEL_REVISION: z
    .union([z.literal(''), z.string().regex(/^[a-f0-9]{40}$/)])
    .default(''),
  AI_SHADOW_CACHE_DIRECTORY: z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => !value.includes('\0'))
    .default('.cache/ai-prototype'),
  AI_SHADOW_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1).max(300_000).default(30_000),
  AI_SHADOW_INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(1).max(300_000).default(5_000),
  YOUTUBE_DELETE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DEV_AUTH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  YOUTUBE_DELETE_TEST_SESSION_ID: z.union([z.literal(''), z.uuid()]).default(''),
  YOUTUBE_DELETE_TEST_AUTHOR_ID: z
    .string()
    .regex(/^(?:UC[A-Za-z0-9_-]{22})?$/)
    .default(''),
  DEV_ACCOUNT_ID: z.uuid().default('10000000-0000-4000-8000-000000000001'),
  DASHBOARD_ORIGIN: z
    .url()
    .default('http://127.0.0.1:3000')
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        value === url.origin &&
        !url.username &&
        !url.password
      );
    }, 'An exact local HTTP origin is required'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  GOOGLE_AUTH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default('http://127.0.0.1:3001/v1/auth/google/callback'),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  YOUTUBE_BAN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  YOUTUBE_BAN_TEST_SESSION_ID: z.union([z.literal(''), z.uuid()]).default(''),
  YOUTUBE_BAN_TEST_AUTHOR_ID: z
    .string()
    .regex(/^(?:UC[A-Za-z0-9_-]{22})?$/)
    .default(''),
  YOUTUBE_BAN_TEST_ACTION: z.enum(['', 'TIMEOUT', 'BAN']).default(''),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      'Invalid development configuration: ' +
        result.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  const host = new URL(result.data.DATABASE_URL).hostname;
  if (
    result.data.AI_SHADOW_ENABLED &&
    (!result.data.WORKER_ENABLED ||
      !result.data.AI_SHADOW_RUN_ID ||
      !result.data.AI_SHADOW_MODEL_REVISION)
  ) {
    throw new Error(
      'AI shadow requires the worker, an explicit run ID, and a pinned model revision.',
    );
  }
  const banTestFields = [
    result.data.YOUTUBE_BAN_TEST_SESSION_ID,
    result.data.YOUTUBE_BAN_TEST_AUTHOR_ID,
    result.data.YOUTUBE_BAN_TEST_ACTION,
  ];

  const hasBanTestScope = banTestFields.some(Boolean);

  if (hasBanTestScope && !banTestFields.every(Boolean)) {
    throw new Error(
      'Controlled timeout and ban require a test session, author channel, and action.',
    );
  }

  if (
    hasBanTestScope &&
    result.data.YOUTUBE_BAN_ENABLED &&
    result.data.YOUTUBE_DELETE_ENABLED &&
    result.data.YOUTUBE_DELETE_TEST_SESSION_ID
  ) {
    throw new Error('Controlled deletion and controlled author actions cannot run simultaneously.');
  }
  if (
    Boolean(result.data.YOUTUBE_DELETE_TEST_SESSION_ID) !==
    Boolean(result.data.YOUTUBE_DELETE_TEST_AUTHOR_ID)
  ) {
    throw new Error('Controlled deletion requires both a test session and a test author channel.');
  }
  if (
    result.data.YOUTUBE_DELETE_ENABLED &&
    (!result.data.WORKER_ENABLED || !result.data.GOOGLE_AUTH_ENABLED)
  ) {
    throw new Error('YouTube deletion requires the worker and Google authentication.');
  }
  if (
    result.data.YOUTUBE_BAN_ENABLED &&
    (!result.data.WORKER_ENABLED || !result.data.GOOGLE_AUTH_ENABLED)
  ) {
    throw new Error('YouTube timeout and ban require the worker and Google authentication.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
    throw new Error('Foundation database must be local');
  if (result.data.GOOGLE_AUTH_ENABLED) {
    const config = result.data;
    if (
      !config.GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com') ||
      !config.GOOGLE_CLIENT_SECRET
    )
      throw new Error('Google OAuth credentials are required');
    if (!/^[0-9a-fA-F]{64}$/.test(config.TOKEN_ENCRYPTION_KEY))
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as hex');
    const expected = `${new URL(config.DASHBOARD_ORIGIN).protocol}//${new URL(config.DASHBOARD_ORIGIN).hostname}:${config.API_PORT}/v1/auth/google/callback`;
    if (config.GOOGLE_REDIRECT_URI !== expected)
      throw new Error('GOOGLE_REDIRECT_URI must use the dashboard hostname and API port');
  }
  return Object.freeze(result.data);
}
export type AppConfig = ReturnType<typeof loadConfig>;
