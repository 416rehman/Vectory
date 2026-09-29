-- Create and duplicate share one actor/key namespace. Result/source retirement
-- must not erase a key and allow a delayed retry to allocate another pipeline.
CREATE TABLE pipeline_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 operation TEXT NOT NULL CHECK(operation IN ('create','duplicate')),
 source_configuration_id TEXT,
 source_revision INTEGER,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 configuration_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_id),
 CHECK((operation='create' AND source_configuration_id IS NULL AND source_revision IS NULL) OR
       (operation='duplicate' AND source_configuration_id IS NOT NULL AND length(source_configuration_id)=36 AND source_revision IS NOT NULL AND source_revision BETWEEN 1 AND 9007199254740991))
);
CREATE INDEX pipeline_requests_recent ON pipeline_requests(actor_id,created_at DESC,request_id DESC);
