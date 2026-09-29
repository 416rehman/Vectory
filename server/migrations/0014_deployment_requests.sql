-- Fixed-size, durable operation identities. Do not expire these keys: doing so
-- could turn a delayed retry into another rollout. Future deletion needs a
-- tombstone or must retain the original deployment, not release the key.
CREATE TABLE deployment_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 deployment_kind TEXT NOT NULL DEFAULT 'deployment' CHECK(deployment_kind='deployment'),
 deployment_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(deployment_kind,deployment_id) REFERENCES records(kind,id) ON DELETE RESTRICT
);
