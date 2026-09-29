-- Publishing has its own actor/key namespace, bound to one source pipeline.
-- Retain the mapping even if its immutable result is removed by future tooling.
CREATE TABLE publication_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 configuration_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 version_id TEXT NOT NULL,
 number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 9007199254740991),
 source_revision INTEGER NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
CREATE INDEX publication_requests_recent ON publication_requests(actor_id,configuration_id,created_at DESC,request_id DESC);
