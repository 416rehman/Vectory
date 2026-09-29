-- Administrator-only, actor-scoped device recovery authorization identities.
-- The request namespace is distinct from ordinary enrollment-token creation.
-- A source binding and cancellation tombstone survive missing tokens/devices.
CREATE TABLE device_recovery_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 device_id TEXT NOT NULL CHECK(length(device_id)=36),
 payload_sha256 TEXT CHECK(payload_sha256 IS NULL OR length(payload_sha256)=64),
 token_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('created','cancelled')),
 created_at TEXT NOT NULL,
 cancelled_at TEXT,
 PRIMARY KEY(actor_id,request_id),
 CHECK(state='cancelled' OR (payload_sha256 IS NOT NULL AND token_id IS NOT NULL)),
 CHECK((state='cancelled')=(cancelled_at IS NOT NULL))
);
