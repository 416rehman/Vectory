CREATE TABLE user_mfa (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret_ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
 pending_expires_at TEXT NOT NULL, last_used_step INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE mfa_recovery_codes (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 verifier TEXT NOT NULL, PRIMARY KEY(user_id,verifier)
);
