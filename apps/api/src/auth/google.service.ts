import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AppConfig } from '@moderator/config';
import { transaction } from '@moderator/persistence';

import { APP_CONFIG, DatabaseService } from '../database.module';
import { failure } from '../http';
import {
  decryptToken,
  encryptToken,
  GOOGLE_SCOPES,
  GoogleProvider,
  GoogleProviderError,
  YOUTUBE_SCOPE,
  type GoogleProviderErrorCode,
  type VerifiedBroadcast,
} from './google-provider';
import { tokenHash } from './session.service';

export const OAUTH_COOKIE = 'atm_google_oauth';
export function oauthCookie(token: string, maxAge = 600) {
  // Lax is required for the top-level callback navigation from Google to local HTTP.
  return `${OAUTH_COOKIE}=${token}; Path=/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export function oauthBrowserToken(header: string | undefined) {
  const entries = (header ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${OAUTH_COOKIE}=`));
  if (entries.length !== 1) return null;
  const token = entries[0]!.slice(OAUTH_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

const GOOGLE_ERROR_RESPONSES = {
  RECONNECT_REQUIRED: {
    status: 409,
    message: 'Reconnect your Google account to continue.',
  },
  GOOGLE_UNAVAILABLE: {
    status: 502,
    message: 'Google is temporarily unavailable. Please try again.',
  },
  YOUTUBE_FORBIDDEN: {
    status: 502,
    message: 'YouTube rejected the request. Check your Google connection and API access.',
  },
  INVALID_BROADCAST_ID: {
    status: 422,
    message: 'The YouTube broadcast ID is invalid.',
  },
  BROADCAST_NOT_FOUND: {
    status: 404,
    message: 'The YouTube broadcast could not be found.',
  },
  BROADCAST_NOT_OWNED: {
    status: 403,
    message: 'This broadcast does not belong to the connected YouTube account.',
  },
  BROADCAST_NOT_LIVE: {
    status: 409,
    message: 'The broadcast must be live before monitoring can start.',
  },
  LIVE_CHAT_UNAVAILABLE: {
    status: 409,
    message: 'Live chat is not available for this broadcast.',
  },
  YOUTUBE_LOOKUP_INCOMPLETE: {
    status: 503,
    message: 'YouTube channel ownership could not be fully verified. Please try again.',
  },
} satisfies Record<GoogleProviderErrorCode, { status: number; message: string }>;

@Injectable()
export class GoogleService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly provider: GoogleProvider,
  ) {}

  private enabled() {
    if (!this.config.GOOGLE_AUTH_ENABLED)
      throw failure(404, 'GOOGLE_AUTH_DISABLED', 'Login Google belum diaktifkan.');
  }

  async start(previousBrowserToken: string | null) {
    this.enabled();
    const state = randomBytes(32).toString('base64url');
    const browser = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await transaction(this.database.pool, async (client) => {
      await client.query(
        'DELETE FROM google_oauth_attempts WHERE expires_at<=clock_timestamp() OR browser_hash=$1',
        [previousBrowserToken ? tokenHash(previousBrowserToken) : null],
      );
      await client.query(
        "INSERT INTO google_oauth_attempts(state_hash,browser_hash,verifier_ciphertext,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes')",
        [
          tokenHash(state),
          tokenHash(browser),
          encryptToken(verifier, this.config.TOKEN_ENCRYPTION_KEY, `oauth:${tokenHash(state)}`),
        ],
      );
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID,
      redirect_uri: this.config.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), browser };
  }

  async complete(
    state: string,
    browser: string | null,
    code: string | undefined,
    denied: boolean,
    previousToken: string | null,
  ) {
    this.enabled();
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !browser)
      throw failure(
        400,
        'OAUTH_STATE_INVALID',
        'Sesi login Google tidak valid. Silakan mulai login kembali.',
      );
    // Atomic consumption prevents callback replay, including simultaneous requests.
    const attempt = await this.database.pool.query(
      'DELETE FROM google_oauth_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>clock_timestamp() RETURNING verifier_ciphertext',
      [tokenHash(state), tokenHash(browser)],
    );
    if (!attempt.rows.length)
      throw failure(
        400,
        'OAUTH_STATE_INVALID',
        'Sesi login Google sudah berakhir atau telah digunakan.',
      );
    if (denied) throw failure(400, 'OAUTH_DENIED', 'Izin Google dibatalkan.');
    if (!code || code.length > 4096)
      throw failure(400, 'OAUTH_CODE_INVALID', 'Kode login Google tidak valid.');
    const verifier = decryptToken(
      attempt.rows[0].verifier_ciphertext,
      this.config.TOKEN_ENCRYPTION_KEY,
      `oauth:${tokenHash(state)}`,
    );
    const tokens = await this.provider.token({
      client_id: this.config.GOOGLE_CLIENT_ID,
      client_secret: this.config.GOOGLE_CLIENT_SECRET,
      redirect_uri: this.config.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
    const scopes = (tokens.scope ?? '').split(' ');
    if (!scopes.includes(YOUTUBE_SCOPE) || !scopes.includes('openid'))
      throw failure(
        403,
        'GOOGLE_SCOPE_REQUIRED',
        'Izin profil dan pengelolaan YouTube diperlukan.',
      );
    const profile = await this.provider.profile(tokens.access_token);
    const token = randomBytes(32).toString('base64url');
    await transaction(this.database.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `google:${profile.sub}`,
      ]);
      const identity = await client.query(
        'SELECT account_id FROM google_identities WHERE subject=$1',
        [profile.sub],
      );
      const accountId: string = identity.rows[0]?.account_id ?? randomUUID();
      if (!identity.rows.length) {
        await client.query('INSERT INTO accounts(id,display_name) VALUES($1,$2)', [
          accountId,
          profile.name,
        ]);
        await client.query('INSERT INTO google_identities(subject,account_id) VALUES($1,$2)', [
          profile.sub,
          accountId,
        ]);
      }
      // Same lock as the refresh path prevents replacing a newly authorized grant with stale tokens.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `google-token:${accountId}`,
      ]);
      const stored = await client.query(
        'SELECT refresh_token_ciphertext FROM google_credentials WHERE account_id=$1',
        [accountId],
      );
      const refresh = tokens.refresh_token
        ? encryptToken(
            tokens.refresh_token,
            this.config.TOKEN_ENCRYPTION_KEY,
            `${accountId}:refresh`,
          )
        : stored.rows[0]?.refresh_token_ciphertext;
      if (!refresh)
        throw failure(
          403,
          'GOOGLE_OFFLINE_REQUIRED',
          'Akses offline belum diberikan. Hubungkan Google kembali.',
        );
      await client.query(
        "INSERT INTO google_credentials(account_id,access_token_ciphertext,refresh_token_ciphertext,expires_at,scopes) VALUES($1,$2,$3,clock_timestamp()+$4 * interval '1 second',$5) ON CONFLICT(account_id) DO UPDATE SET access_token_ciphertext=EXCLUDED.access_token_ciphertext,refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,expires_at=EXCLUDED.expires_at,scopes=EXCLUDED.scopes,updated_at=clock_timestamp()",
        [
          accountId,
          encryptToken(
            tokens.access_token,
            this.config.TOKEN_ENCRYPTION_KEY,
            `${accountId}:access`,
          ),
          refresh,
          tokens.expires_in,
          tokens.scope,
        ],
      );
      if (previousToken)
        await client.query('DELETE FROM dashboard_sessions WHERE token_hash=$1', [
          tokenHash(previousToken),
        ]);
      await client.query(
        'DELETE FROM dashboard_sessions WHERE account_id=$1 AND expires_at<=clock_timestamp()',
        [accountId],
      );
      await client.query(
        "INSERT INTO dashboard_sessions(id,account_id,token_hash,expires_at,auth_provider) VALUES($1,$2,$3,clock_timestamp()+$4 * interval '1 second','google')",
        [randomUUID(), accountId, tokenHash(token), this.config.SESSION_TTL_SECONDS],
      );
      await client.query(
        'DELETE FROM dashboard_sessions WHERE account_id=$1 AND id IN (SELECT id FROM dashboard_sessions WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET 10)',
        [accountId],
      );
    });
    return token;
  }

  private async withAccessToken<T>(
    accountId: string,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    this.enabled();
    try {
      const token = await transaction(this.database.pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `google-token:${accountId}`,
        ]);
        const result = await client.query(
          "SELECT *,expires_at>clock_timestamp()+interval '60 seconds' AS fresh FROM google_credentials WHERE account_id=$1",
          [accountId],
        );
        const row = result.rows[0];
        if (!row) throw new GoogleProviderError('RECONNECT_REQUIRED');
        if (row.fresh)
          return decryptToken(
            row.access_token_ciphertext,
            this.config.TOKEN_ENCRYPTION_KEY,
            `${accountId}:access`,
          );
        const refreshed = await this.provider.token({
          client_id: this.config.GOOGLE_CLIENT_ID,
          client_secret: this.config.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: decryptToken(
            row.refresh_token_ciphertext,
            this.config.TOKEN_ENCRYPTION_KEY,
            `${accountId}:refresh`,
          ),
        });
        if (refreshed.scope && !refreshed.scope.split(' ').includes(YOUTUBE_SCOPE))
          throw new GoogleProviderError('RECONNECT_REQUIRED');
        await client.query(
          "UPDATE google_credentials SET access_token_ciphertext=$2,refresh_token_ciphertext=$3,expires_at=clock_timestamp()+$4 * interval '1 second',updated_at=clock_timestamp() WHERE account_id=$1",
          [
            accountId,
            encryptToken(
              refreshed.access_token,
              this.config.TOKEN_ENCRYPTION_KEY,
              `${accountId}:access`,
            ),
            refreshed.refresh_token
              ? encryptToken(
                  refreshed.refresh_token,
                  this.config.TOKEN_ENCRYPTION_KEY,
                  `${accountId}:refresh`,
                )
              : row.refresh_token_ciphertext,
            refreshed.expires_in,
          ],
        );
        return refreshed.access_token;
      });
      return await operation(token);
    } catch (error) {
      if (error instanceof GoogleProviderError) {
        const response = GOOGLE_ERROR_RESPONSES[error.code];
        throw failure(response.status, error.code, response.message);
      }

      throw error;
    }
  }

  async broadcasts(accountId: string) {
    return this.withAccessToken(accountId, (accessToken) => this.provider.broadcasts(accessToken));
  }

  async verifyBroadcast(accountId: string, broadcastId: string): Promise<VerifiedBroadcast> {
    return this.withAccessToken(accountId, (accessToken) =>
      this.provider.verifyBroadcast(accessToken, broadcastId),
    );
  }
}
