ALTER TABLE dashboard_sessions ADD COLUMN auth_provider text NOT NULL DEFAULT 'development'
 CHECK (auth_provider IN ('development', 'google'));
CREATE TABLE google_identities (
 subject text PRIMARY KEY,
 account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE google_credentials (
 account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 access_token_ciphertext text NOT NULL,
 refresh_token_ciphertext text NOT NULL,
 expires_at timestamptz NOT NULL,
 scopes text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE google_oauth_attempts (
 state_hash text PRIMARY KEY,
 browser_hash text NOT NULL,
 verifier_ciphertext text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX google_oauth_attempt_expiry ON google_oauth_attempts(expires_at);
