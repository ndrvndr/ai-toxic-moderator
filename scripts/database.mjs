import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadConfig } from '@moderator/config';

import { matchesMigrationChecksum } from './migration-checksum.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export const ids = {
  account: '10000000-0000-4000-8000-000000000001',
  channel: '20000000-0000-4000-8000-000000000001',
  session: '30000000-0000-4000-8000-000000000001',
  bundle: '40000000-0000-4000-8000-000000000001',
  run: '50000000-0000-4000-8000-000000000001',
};
export async function migrate(client) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(817321)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const folder = path.join(root, 'packages/persistence/migrations');
    for (const name of (await readdir(folder)).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(path.join(folder, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [
        name,
      ]);
      if (existing.rows.length) {
        if (!matchesMigrationChecksum(sql, existing.rows[0].checksum)) {
          throw new Error('Applied migration changed: ' + name);
        }

        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
        name,
        checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
export async function seed(client) {
  const config = {
    stage: 'FOUNDATION',
    rules: [],
    policy: { mode: 'SIMULATION', enabled: false },
    note: 'Rule demo implementation pending M1-06',
  };
  const payload = JSON.stringify(config),
    hash = createHash('sha256').update(payload).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(817322)');
    await client.query(
      'INSERT INTO accounts(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [ids.account, 'Moderator development'],
    );
    await client.query(
      'INSERT INTO channels(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [ids.channel, 'Channel pilot sintetis'],
    );
    await client.query(
      "INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,'MODERATOR') ON CONFLICT DO NOTHING",
      [ids.channel, ids.account],
    );
    await client.query(
      'INSERT INTO stream_sessions(id,channel_id,label) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [ids.session, ids.channel, 'Sesi fixture lokal'],
    );
    await client.query(
      "INSERT INTO configuration_bundles(id,channel_id,schema_version,processor_version,ruleset_version,policy_version,model_status,configuration,content_hash) VALUES($1,$2,1,'processor-foundation-0','ruleset-foundation-0','policy-foundation-0','DISABLED',$3,$4) ON CONFLICT DO NOTHING",
      [ids.bundle, ids.channel, payload, hash],
    );
    const stored = await client.query(
      'SELECT content_hash FROM configuration_bundles WHERE id=$1',
      [ids.bundle],
    );
    if (stored.rows[0]?.content_hash !== hash)
      throw new Error('Seed bundle mismatch; publish a new version instead of overwriting');
    await client.query(
      "INSERT INTO evaluation_runs(id,channel_id,session_id,configuration_bundle_id,kind,mode) VALUES($1,$2,$3,$4,'PRIMARY','SIMULATION') ON CONFLICT DO NOTHING",
      [ids.run, ids.channel, ids.session, ids.bundle],
    );
    await client.query(
      'INSERT INTO channel_feed_counters(channel_id) VALUES($1) ON CONFLICT DO NOTHING',
      [ids.channel],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!['migrate', 'seed'].includes(command)) throw new Error('Use migrate or seed');
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  const client = new pg.Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    await (command === 'migrate' ? migrate : seed)(client);
    console.log(command + ' completed');
  } finally {
    await client.end();
  }
}
