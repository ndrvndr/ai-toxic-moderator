import { transaction, type createPool } from '@moderator/persistence';

import {
  decryptToken,
  encryptToken,
  GoogleProvider,
  GoogleProviderError,
  YOUTUBE_SCOPE,
} from './google-provider';

type DatabasePool = ReturnType<typeof createPool>;

type GoogleTokenConfig = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
};

export class GoogleTokenStore {
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: GoogleTokenConfig,
    private readonly provider: Pick<GoogleProvider, 'token'>,
  ) {}

  async accessToken(accountId: string): Promise<string> {
    return transaction(this.pool, async (client) => {
      // Shared with OAuth completion and every API/worker refresh request.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `google-token:${accountId}`,
      ]);

      const result = await client.query<{
        access_token_ciphertext: string;
        refresh_token_ciphertext: string;
        fresh: boolean;
      }>(
        "SELECT *,expires_at>clock_timestamp()+interval '60 seconds' AS fresh FROM google_credentials WHERE account_id=$1",
        [accountId],
      );

      const row = result.rows[0];

      if (!row) {
        throw new GoogleProviderError('RECONNECT_REQUIRED');
      }

      if (row.fresh) {
        return decryptToken(
          row.access_token_ciphertext,
          this.config.TOKEN_ENCRYPTION_KEY,
          `${accountId}:access`,
        );
      }

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

      if (refreshed.scope !== undefined && !refreshed.scope.split(' ').includes(YOUTUBE_SCOPE)) {
        throw new GoogleProviderError('RECONNECT_REQUIRED');
      }

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
  }
}
