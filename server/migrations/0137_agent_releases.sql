-- Agent releases (server/src/agent_releases.rs): a build this server ships,
-- prepared as one signed manifest. The manifest and signature bytes are stored
-- exactly as built and as uploaded: nobody re-serializes them, and a host
-- verifies the bytes it receives. A withdrawn release keeps its row and its
-- manifest for the audit trail; its files leave the release store once no
-- rollout needs them.
CREATE TABLE agent_releases (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 version TEXT NOT NULL CHECK(length(version) BETWEEN 5 AND 32),
 counter INTEGER NOT NULL UNIQUE CHECK(counter BETWEEN 1 AND 9007199254740991),
 manifest BLOB NOT NULL CHECK(length(manifest) BETWEEN 1 AND 16384),
 manifest_sha256 TEXT NOT NULL UNIQUE CHECK(length(manifest_sha256)=64),
 signature BLOB CHECK(signature IS NULL OR length(signature) BETWEEN 1 AND 4096),
 signer TEXT REFERENCES agent_release_keys(fingerprint),
 issued_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 -- What the manifest says about the hosts it needs, kept beside the bytes so
 -- a review never has to parse them: the oldest agent that may take the
 -- release (null: any) and the service definition generation it needs.
 min_from TEXT CHECK(min_from IS NULL OR length(min_from) BETWEEN 5 AND 32),
 service_definition INTEGER NOT NULL DEFAULT 1 CHECK(service_definition BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN ('awaiting_signature','ready','withdrawn')),
 prepared_by TEXT,
 prepared_by_name TEXT,
 prepared_at TEXT NOT NULL,
 withdrawn_by TEXT,
 withdrawn_at TEXT,
 withdrawn_reason TEXT,
 -- 1 once the files no rollout needs have left the release store.
 files_removed INTEGER NOT NULL DEFAULT 0 CHECK(files_removed IN (0,1)),
 CHECK((signature IS NULL)=(signer IS NULL)),
 CHECK(state<>'ready' OR signature IS NOT NULL),
 CHECK(state<>'awaiting_signature' OR signature IS NULL)
);
-- One release of a version at a time: a withdrawn one makes room for the next.
CREATE UNIQUE INDEX agent_releases_live_version ON agent_releases(version) WHERE state<>'withdrawn';
CREATE INDEX agent_releases_recent ON agent_releases(prepared_at DESC,id);

CREATE TABLE agent_release_artifacts (
 release_id TEXT NOT NULL REFERENCES agent_releases(id),
 os TEXT NOT NULL CHECK(os IN ('linux','darwin','windows')),
 arch TEXT NOT NULL CHECK(arch IN ('amd64','arm64')),
 file TEXT NOT NULL CHECK(length(file) BETWEEN 1 AND 128),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 134217728),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 PRIMARY KEY(release_id,os,arch)
);
CREATE INDEX agent_release_artifacts_sha256 ON agent_release_artifacts(sha256);
