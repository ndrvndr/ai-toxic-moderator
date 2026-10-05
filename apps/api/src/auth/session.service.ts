import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AppConfig } from '@moderator/config';
import { meResponse } from '@moderator/contracts';
import { transaction } from '@moderator/persistence';

import { APP_CONFIG, DatabaseService } from '../database.module';
import { failure, type AuthenticatedAccount } from '../http';

export const SESSION_COOKIE = 'atm_dev_session';
export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
export function cookieToken(header: string | undefined): string | null {
  const values = (header ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(SESSION_COOKIE + '='));
  if (values.length !== 1) return null;
  const token = values[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export function sessionCookie(token: string, maxAge: number) {
  // HTTP loopback only. Production authentication must use Secure cookies over HTTPS.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async resolve(token: string | null): Promise<AuthenticatedAccount | null> {
    if ((!this.config.DEV_AUTH_ENABLED && !this.config.GOOGLE_AUTH_ENABLED) || !token) return null;
    const result = await this.database.pool.query(
      "SELECT a.id,a.display_name FROM dashboard_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND ((s.auth_provider='development' AND $2) OR (s.auth_provider='google' AND $3))",
      [tokenHash(token), this.config.DEV_AUTH_ENABLED, this.config.GOOGLE_AUTH_ENABLED],
    );
    return result.rows[0] ?? null;
  }
  async create(previousToken: string | null) {
    if (!this.config.DEV_AUTH_ENABLED)
      throw failure(404, 'NOT_FOUND', 'Development sign-in is disabled.');
    const token = randomBytes(32).toString('base64url');
    const expires = await transaction(this.database.pool, async (client) => {
      // Serialize per-account rotation without granting UPDATE on the accounts table.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        this.config.DEV_ACCOUNT_ID,
      ]);
      const account = await client.query('SELECT id FROM accounts WHERE id=$1', [
        this.config.DEV_ACCOUNT_ID,
      ]);
      if (!account.rows.length)
        throw failure(
          503,
          'DEV_ACCOUNT_UNAVAILABLE',
          'Seed the database before using development sign-in.',
        );
      await client.query(
        'DELETE FROM dashboard_sessions WHERE account_id=$1 AND (expires_at<=clock_timestamp() OR token_hash=$2)',
        [this.config.DEV_ACCOUNT_ID, previousToken ? tokenHash(previousToken) : null],
      );
      const result = await client.query(
        "INSERT INTO dashboard_sessions(id,account_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4 * interval '1 second') RETURNING expires_at",
        [
          randomUUID(),
          this.config.DEV_ACCOUNT_ID,
          tokenHash(token),
          this.config.SESSION_TTL_SECONDS,
        ],
      );
      await client.query(
        'DELETE FROM dashboard_sessions WHERE account_id=$1 AND id IN (SELECT id FROM dashboard_sessions WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET 10)',
        [this.config.DEV_ACCOUNT_ID],
      );
      return (result.rows[0].expires_at as Date).toISOString();
    });
    return { token, expires_at: expires };
  }
  async revoke(hash: string) {
    await this.database.pool.query('DELETE FROM dashboard_sessions WHERE token_hash=$1', [hash]);
  }
  async me(account: AuthenticatedAccount) {
    const memberships = await this.database.pool.query(
      'SELECT m.channel_id,m.role,c.display_name AS channel_name FROM channel_memberships m JOIN channels c ON c.id=m.channel_id WHERE m.account_id=$1 ORDER BY m.channel_id',
      [account.id],
    );
    return meResponse.parse({ account, memberships: memberships.rows });
  }
}
