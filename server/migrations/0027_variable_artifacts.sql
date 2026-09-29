-- Artifact bytes are content addressed and immutable. A common default is
-- stored once even when thousands of devices share it; generation references
-- preserve the exact bytes that were actually offered to each target.
CREATE TABLE artifact_blobs (
 sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1048576),
 artifact BLOB NOT NULL CHECK(length(artifact)=size)
);
CREATE TRIGGER artifact_blobs_no_update BEFORE UPDATE ON artifact_blobs BEGIN SELECT RAISE(ABORT,'artifact blobs are immutable'); END;
CREATE TRIGGER artifact_blobs_no_delete BEFORE DELETE ON artifact_blobs BEGIN SELECT RAISE(ABORT,'artifact blobs are immutable'); END;

CREATE TABLE desired_artifacts (
 device_id TEXT NOT NULL REFERENCES devices(id),
 generation INTEGER NOT NULL CHECK(generation > 0),
 version_id TEXT NOT NULL,
 sha256 TEXT NOT NULL REFERENCES artifact_blobs(sha256),
 created_at TEXT NOT NULL,
 PRIMARY KEY(device_id,generation)
);
CREATE INDEX desired_artifacts_digest ON desired_artifacts(sha256);
CREATE TRIGGER desired_artifacts_no_update BEFORE UPDATE ON desired_artifacts BEGIN SELECT RAISE(ABORT,'desired artifact identity is immutable'); END;
CREATE TRIGGER desired_artifacts_no_delete BEFORE DELETE ON desired_artifacts BEGIN SELECT RAISE(ABORT,'desired artifact identity is immutable'); END;

ALTER TABLE deployment_targets ADD COLUMN previous_artifact_sha256 TEXT;
ALTER TABLE deployment_targets ADD COLUMN previous_generation INTEGER;
