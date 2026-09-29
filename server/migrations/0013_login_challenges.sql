-- Password verification is not an authenticated browser session. Only a hash of
-- the short-lived second-factor capability is retained; one is live per account.
CREATE TABLE login_challenges (
 verifier TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 user_revision INTEGER NOT NULL,
 password_fingerprint TEXT NOT NULL,
 mfa_fingerprint TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5)
);
CREATE INDEX login_challenges_expiry ON login_challenges(expires_at);

CREATE TRIGGER login_challenges_user_change AFTER UPDATE ON users BEGIN
 DELETE FROM login_challenges WHERE user_id=NEW.id;
END;
CREATE TRIGGER login_challenges_mfa_change
AFTER UPDATE OF secret_ciphertext,enabled ON user_mfa BEGIN
 DELETE FROM login_challenges WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER login_challenges_mfa_delete AFTER DELETE ON user_mfa BEGIN
 DELETE FROM login_challenges WHERE user_id=OLD.user_id;
END;
