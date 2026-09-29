-- Durable actor-scoped creation identities. Never expire or cascade-delete a
-- mapping: a delayed retry must not create another group after result removal.
CREATE TABLE group_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 group_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
CREATE INDEX group_requests_recent ON group_requests(actor_id,created_at DESC,request_id DESC);
