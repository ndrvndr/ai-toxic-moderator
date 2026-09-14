CREATE TABLE dashboard_sessions (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at > created_at)
);
CREATE INDEX dashboard_session_account ON dashboard_sessions(account_id, created_at DESC, id DESC);
CREATE INDEX dashboard_session_expiry ON dashboard_sessions(expires_at);
