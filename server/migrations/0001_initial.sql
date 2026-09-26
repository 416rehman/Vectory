CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','editor','operator','admin')),
 password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
 verifier TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE records (
 kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 created_at TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE INDEX records_recent ON records(kind,created_at DESC);
CREATE TRIGGER immutable_records BEFORE UPDATE ON records
 WHEN old.kind IN ('version','revision','audit') BEGIN
 SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER append_only_audit BEFORE DELETE ON records
 WHEN old.kind = 'audit' BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
CREATE TABLE devices (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 data TEXT NOT NULL CHECK(json_valid(data)), revoked INTEGER NOT NULL DEFAULT 0,
 desired_version_id TEXT, desired_generation INTEGER NOT NULL DEFAULT 0,
 policy TEXT NOT NULL DEFAULT '{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}',
 policy_generation INTEGER NOT NULL DEFAULT 0, assignment_id TEXT, policy_assignment_id TEXT
);
CREATE TABLE credentials (
 fingerprint TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
 expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX credentials_device ON credentials(device_id);
CREATE TABLE enrollment_tokens (
 id TEXT PRIMARY KEY, verifier TEXT NOT NULL UNIQUE,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE enrollments (
 request_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL,
 token_id TEXT NOT NULL REFERENCES enrollment_tokens(id),
 response TEXT NOT NULL CHECK(json_valid(response))
);
CREATE TABLE deployment_targets (
 deployment_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id),
 state TEXT NOT NULL DEFAULT 'pending', generation INTEGER NOT NULL DEFAULT 0,
 previous_version_id TEXT, released_at TEXT, verified_at TEXT, error TEXT,
 original INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(deployment_id,device_id)
);
CREATE INDEX targets_device ON deployment_targets(device_id);
CREATE TABLE telemetry (
 device_id TEXT NOT NULL REFERENCES devices(id), bucket INTEGER NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(device_id,bucket)
);
