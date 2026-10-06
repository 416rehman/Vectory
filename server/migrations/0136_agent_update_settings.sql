-- Agent updates: the one setting row and the release keys whose signatures
-- hosts trust (server/src/agent_updates.rs, server/src/agent_release_keys.rs).
--
-- A key is a public key line plus who holds the private half. With custody
-- `server` the seed lives sealed in keys/agent-release-<fingerprint>.sealed;
-- with `offline` the server holds only the public key. Keys are never deleted:
-- a retired or revoked key stays as history, and the statements that replaced
-- one key with another stay on the successor, so the public key bundle can
-- list them.
CREATE TABLE agent_release_keys (
 fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint)=64),
 public_key TEXT NOT NULL CHECK(length(public_key) BETWEEN 1 AND 256),
 custody TEXT NOT NULL CHECK(custody IN ('server','offline')),
 state TEXT NOT NULL CHECK(state IN ('current','retired','revoked')),
 created_at TEXT NOT NULL,
 created_by TEXT,
 created_by_name TEXT,
 retired_at TEXT,
 revoked_at TEXT,
 revoked_by TEXT,
 revoked_reason TEXT,
 -- The rollover that made this key current: the key it replaced and the
 -- statement and signature (base64) that key made.
 introduced_from TEXT CHECK(introduced_from IS NULL OR length(introduced_from)=64),
 introduced_statement TEXT,
 introduced_signature TEXT,
 CHECK((introduced_from IS NULL)=(introduced_statement IS NULL)
   AND (introduced_statement IS NULL)=(introduced_signature IS NULL))
);
-- One key signs new releases at a time.
CREATE UNIQUE INDEX agent_release_keys_current ON agent_release_keys(state) WHERE state='current';
CREATE INDEX agent_release_keys_recent ON agent_release_keys(created_at DESC,fingerprint);

-- `enabled` is off until an Administrator turns updates on. `custody` is chosen
-- once, with the first key, and stays when updates are turned off. `revision`
-- advances when `enabled`, `custody`, the current key or the stop state changes,
-- never when a release takes a counter. `counter_sequence` is the last release
-- counter handed out: one sequence for every key.
CREATE TABLE agent_update_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 custody TEXT CHECK(custody IS NULL OR custody IN ('server','offline')),
 current_key TEXT REFERENCES agent_release_keys(fingerprint),
 stopped_reason TEXT,
 stopped_by TEXT,
 stopped_by_name TEXT,
 stopped_at TEXT,
 counter_sequence INTEGER NOT NULL DEFAULT 0 CHECK(counter_sequence BETWEEN 0 AND 9007199254740991),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 updated_at TEXT,
 CHECK((stopped_reason IS NULL)=(stopped_at IS NULL))
);
INSERT INTO agent_update_settings(id) VALUES(1);

-- What each device last reported about agent updates, as it sent it (the
-- heartbeat member `agent_update`, validated) and when. A check-in without the
-- member removes the row: the server never infers a report and never keeps a
-- stale one. It is kept apart from the device record, which the device
-- projections copy member by member.
CREATE TABLE agent_update_reports (
 device_id TEXT PRIMARY KEY REFERENCES devices(id),
 report TEXT NOT NULL CHECK(json_valid(report) AND length(report)<=16384),
 reported_at TEXT NOT NULL
);
