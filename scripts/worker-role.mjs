import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadConfig } from '@moderator/config';

const marker = 'AI Toxic Moderator development worker';
const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw Error('Invalid role/schema identifier');
  return '"' + value + '"';
};
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
export async function provisionWorkerRole(client, { role, password, schema = 'public' }) {
  const roleSql = identifier(role),
    schemaSql = identifier(schema);
  if (typeof password !== 'string' || password.length < 16 || password.includes('\0'))
    throw Error('Runtime password must contain at least 16 characters');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(817323)');
    const current = await client.query(
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
      [role],
    );
    if (current.rows.length) {
      const row = current.rows[0];
      if (
        row.marker !== marker ||
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls
      )
        throw Error('Existing role is not an unprivileged managed runtime role');
      const ownership = await client.query(
        'SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1 UNION ALL SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname=$1',
        [role],
      );
      if (ownership.rows.length) throw Error('Runtime role must not own tables or schemas');
      await client.query(`ALTER ROLE ${roleSql} LOGIN NOINHERIT PASSWORD ${literal(password)}`);
    } else {
      await client.query(
        `CREATE ROLE ${roleSql} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${literal(password)}`,
      );
      await client.query(`COMMENT ON ROLE ${roleSql} IS ${literal(marker)}`);
    }
    await client.query(`REVOKE ALL ON SCHEMA ${schemaSql} FROM ${roleSql}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schemaSql} TO ${roleSql}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schemaSql} FROM ${roleSql}`);
    for (const table of [
      'monitoring_runs',
      'monitoring_settings_snapshots',
      'youtube_broadcasts',
      'channel_memberships',
      'stream_sessions',
    ]) {
      await client.query(`GRANT SELECT ON ${schemaSql}.${identifier(table)} TO ${roleSql}`);
    }

    await client.query(
      `GRANT UPDATE(
    status,
    started_at,
    finished_at,
    last_error_code
  ) ON ${schemaSql}.monitoring_runs TO ${roleSql}`,
    );

    for (const table of ['monitoring_worker_leases', 'youtube_chat_checkpoints']) {
      await client.query(
        `GRANT SELECT,INSERT,UPDATE ON ${schemaSql}.${identifier(table)} TO ${roleSql}`,
      );
    }

    await client.query(
      `GRANT SELECT,INSERT ON ${schemaSql}.youtube_chat_observations TO ${roleSql}`,
    );
    await client.query(
      `GRANT SELECT,INSERT ON ${schemaSql}.youtube_chat_classifications TO ${roleSql}`,
    );
    await client.query(
      `GRANT SELECT,INSERT ON ${schemaSql}.youtube_moderation_action_plans TO ${roleSql}`,
    );
    for (const table of [
      'youtube_delete_executions',
      'youtube_delete_attempts',
      'youtube_ban_executions',
      'youtube_ban_attempts',
      'youtube_ban_evidence',
    ]) {
      await client.query(`GRANT SELECT,INSERT ON ${schemaSql}.${identifier(table)} TO ${roleSql}`);
    }
    // Row locking the execution serializes attempt creation. Identity changes remain forbidden.
    await client.query(`GRANT UPDATE(id) ON ${schemaSql}.youtube_delete_executions TO ${roleSql}`);
    await client.query(`GRANT UPDATE(id) ON ${schemaSql}.youtube_ban_executions TO ${roleSql}`);
    await client.query(
      `GRANT UPDATE(status, finished_at, http_status, error_code, ban_id) ON ${schemaSql}.youtube_ban_attempts TO ${roleSql}`,
    );
    await client.query(
      `GRANT UPDATE(status, finished_at, http_status, error_code)
       ON ${schemaSql}.youtube_delete_attempts TO ${roleSql}`,
    );

    await client.query(`GRANT SELECT ON ${schemaSql}.google_credentials TO ${roleSql}`);

    await client.query(
      `GRANT UPDATE(
    access_token_ciphertext,
    refresh_token_ciphertext,
    expires_at,
    updated_at
  ) ON ${schemaSql}.google_credentials TO ${roleSql}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE ON ${schemaSql}.live_event_counters TO ${roleSql}`,
    );

    await client.query(`GRANT SELECT,INSERT ON ${schemaSql}.live_events TO ${roleSql}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    await provisionWorkerRole(client, {
      role: process.env.WORKER_DB_ROLE ?? 'moderator_worker',
      password: process.env.WORKER_DB_PASSWORD,
    });
    console.log('Runtime worker role provisioned. Configure WORKER_DATABASE_URL with that role.');
  } catch {
    console.error(
      'Worker role setup failed. Check the admin connection, role ownership, and worker password.',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
