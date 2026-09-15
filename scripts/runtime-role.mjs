import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadConfig } from '@moderator/config';

const marker = 'AI Toxic Moderator development API';
const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw Error('Invalid role/schema identifier');
  return '"' + value + '"';
};
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
export async function provisionRuntimeRole(client, { role, password, schema = 'public' }) {
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
      'accounts',
      'channels',
      'channel_memberships',
      'stream_sessions',
      'evaluation_runs',
      'configuration_bundles',
    ])
      await client.query(`GRANT SELECT ON ${schemaSql}.${identifier(table)} TO ${roleSql}`);
    await client.query(
      `GRANT SELECT,INSERT,DELETE ON ${schemaSql}.dashboard_sessions TO ${roleSql}`,
    );
    await client.query(`GRANT INSERT ON ${schemaSql}.accounts TO ${roleSql}`);
    await client.query(`GRANT SELECT,INSERT ON ${schemaSql}.google_identities TO ${roleSql}`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE ON ${schemaSql}.google_credentials TO ${roleSql}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,DELETE ON ${schemaSql}.google_oauth_attempts TO ${roleSql}`,
    );
    for (const table of ['channels', 'channel_memberships', 'stream_sessions']) {
      await client.query(`GRANT INSERT ON ${schemaSql}.${identifier(table)} TO ${roleSql}`);
    }

    await client.query(`GRANT UPDATE(role) ON ${schemaSql}.channel_memberships TO ${roleSql}`);

    for (const table of ['youtube_channels', 'youtube_broadcasts']) {
      await client.query(`GRANT SELECT,INSERT ON ${schemaSql}.${identifier(table)} TO ${roleSql}`);
    }
    await client.query(`GRANT SELECT,INSERT ON ${schemaSql}.monitoring_runs TO ${roleSql}`);

    await client.query(
      `GRANT UPDATE(
    status,
    stop_requested_at,
    stopped_by_account_id,
    finished_at
  ) ON ${schemaSql}.monitoring_runs TO ${roleSql}`,
    );

    await client.query(
      `GRANT SELECT,INSERT ON ${schemaSql}.monitoring_start_requests TO ${roleSql}`,
    );
    await client.query(`GRANT SELECT ON ${schemaSql}.youtube_chat_observations TO ${roleSql}`);
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
    await provisionRuntimeRole(client, {
      role: process.env.RUNTIME_DB_ROLE ?? 'moderator_api',
      password: process.env.RUNTIME_DB_PASSWORD,
    });
    console.log(
      'Runtime API role provisioned. Configure DATABASE_URL with that role; keep migrations on MIGRATION_DATABASE_URL.',
    );
  } catch {
    console.error(
      'Runtime role setup failed. Check the admin connection, role ownership, and runtime password.',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
