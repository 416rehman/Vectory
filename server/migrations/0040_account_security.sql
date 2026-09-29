-- Browser-session metadata for the account's session list. The session row
-- stays the authority; details follow it and disappear with it.
CREATE TABLE session_details (
 verifier TEXT PRIMARY KEY REFERENCES sessions(verifier) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 user_agent TEXT,
 client_address TEXT
);

-- Why a session ended, so a browser still holding that cookie can explain the
-- sign-out. Keyed by the same verifier hash; only a holder of the original
-- token can look it up. Paths that revoke for a known reason insert first; this
-- trigger records every other deletion (expiry cleanup, restore invalidation).
CREATE TABLE session_endings (
 verifier TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 ended_at TEXT NOT NULL
);
CREATE INDEX session_endings_age ON session_endings(ended_at);
CREATE TRIGGER sessions_record_ending AFTER DELETE ON sessions BEGIN
 INSERT OR IGNORE INTO session_endings(verifier,user_id,reason,ended_at)
 VALUES(
  OLD.verifier,
  OLD.user_id,
  CASE WHEN OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') THEN 'expired' ELSE 'revoked' END,
  strftime('%Y-%m-%dT%H:%M:%SZ','now')
 );
END;

-- Last successful sign-in, shown to administrators.
ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- One live single-use code per account: an administrator reset, an invitation
-- for an account that has never had a password, or a host-issued break-glass
-- reset from vectory-admin (no administrator issuer).
ALTER TABLE password_reset_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reset'
 CHECK(purpose IN ('reset','invite','local'));
