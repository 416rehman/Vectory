-- Device checks (server/src/device_validations.rs): before deploying, an
-- operator asks the real hosts to validate a candidate pipeline version on
-- themselves, without activating it. One row per device per check; every
-- device of one request shares `id`.
--
-- `artifact` holds the candidate exactly as that device would be offered it
-- (its own variable values applied, device secrets still references) and only
-- while the check is pending: the answer, the expiry and a newer check for the
-- same device all clear it, and no other device can fetch it. `result_json`
-- is the bounded, redacted answer the agent sent. Rows are kept 24 hours.
CREATE TABLE device_validations (
 id TEXT NOT NULL CHECK(length(id)=36),
 device_id TEXT NOT NULL REFERENCES devices(id),
 device_name TEXT NOT NULL,
 configuration_id TEXT NOT NULL,
 version_id TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1048576),
 run_tests INTEGER NOT NULL CHECK(run_tests IN (0,1)),
 truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
 requested_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','passed','failed','offline','expired','unsupported')),
 result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 131072)),
 artifact BLOB CHECK(artifact IS NULL OR (state='pending' AND length(artifact)=size)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(id, device_id)
);
-- At most one outstanding check per device: a newer check supersedes the
-- older pending one in the same transaction.
CREATE UNIQUE INDEX device_validations_outstanding ON device_validations(device_id) WHERE state='pending';
-- Retention reads by age.
CREATE INDEX device_validations_created ON device_validations(created_at);
