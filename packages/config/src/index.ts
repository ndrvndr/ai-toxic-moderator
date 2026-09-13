import { z } from 'zod';
const port = z.coerce.number().int().min(1024).max(65535);
const schema = z.object({
  NODE_ENV:z.enum(['development','test']).default('development'),
  API_PORT:port.default(3001),
  DATABASE_URL:z.url().refine(v => ['postgresql:','postgres:'].includes(new URL(v).protocol),'PostgreSQL URL required'),
  REDIS_HOST:z.enum(['127.0.0.1','localhost','::1']).default('127.0.0.1'),
  REDIS_PORT:port.default(56379),
  WORKER_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if(!result.success) throw new Error('Invalid development configuration: '+result.error.issues.map(i=>i.path.join('.')).join(', '));
  const host = new URL(result.data.DATABASE_URL).hostname;
  if(!['127.0.0.1','localhost','[::1]'].includes(host)) throw new Error('Foundation database must be local');
  return Object.freeze(result.data);
}
export type AppConfig = ReturnType<typeof loadConfig>;
