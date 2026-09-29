-- One-time enrollment token creation identities. Never store the token secret.
-- Cancellation before creation leaves a permanent actor/key fence; deletion of
-- a result must never make a delayed request eligible for creation again.
CREATE TABLE token_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 payload_sha256 TEXT CHECK(payload_sha256 IS NULL OR length(payload_sha256)=64),
 token_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('created','cancelled')),
 created_at TEXT NOT NULL,
 cancelled_at TEXT,
 PRIMARY KEY(actor_id,request_id),
 CHECK(state='cancelled' OR (payload_sha256 IS NOT NULL AND token_id IS NOT NULL)),
 CHECK((state='cancelled')=(cancelled_at IS NOT NULL))
);
