-- One-shot actor-scoped identities for administrator password-reset issuance.
-- Only the SHA-256 verifier of a random 256-bit code is retained; the code is
-- never recoverable through a request status read or cancellation.
-- Older codes have no issuer identity, so they cannot be safely revoked when
-- an administrator loses access. Expire those outstanding codes on upgrade.
DELETE FROM password_reset_codes;
ALTER TABLE password_reset_codes ADD COLUMN issuer_id TEXT REFERENCES users(id);
CREATE INDEX password_reset_codes_issuer ON password_reset_codes(issuer_id);
CREATE TABLE password_reset_requests (
 actor_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 user_id TEXT NOT NULL REFERENCES users(id),
 state TEXT NOT NULL CHECK(state IN ('issued','cancelled')),
 was_issued INTEGER NOT NULL CHECK(was_issued IN (0,1)),
 verifier TEXT CHECK(verifier IS NULL OR length(verifier)=64),
 expires_at TEXT,
 created_at TEXT NOT NULL,
 cancelled_at TEXT,
 PRIMARY KEY(actor_id,request_id),
 CHECK (
  (state='issued' AND was_issued=1 AND verifier IS NOT NULL AND expires_at IS NOT NULL AND cancelled_at IS NULL) OR
  (state='cancelled' AND verifier IS NULL AND expires_at IS NULL AND cancelled_at IS NOT NULL)
 )
);
CREATE INDEX password_reset_requests_target ON password_reset_requests(user_id);
