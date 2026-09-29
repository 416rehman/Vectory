-- Actor-scoped saved-settings creation keys do not expire or cascade away.
-- A missing original template remains a tombstone; a delayed retry cannot recreate it.
CREATE TABLE policy_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 policy_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
CREATE INDEX policy_requests_recent ON policy_requests(actor_id,created_at DESC,request_id DESC);
