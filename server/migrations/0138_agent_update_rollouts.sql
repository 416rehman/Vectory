-- Update rollouts (server/src/agent_update_rollouts.rs): their own object with
-- their own tables. They never touch `records` deployments, desired
-- generations, policy generations or `deployment_targets`, so a pipeline
-- rollout and an update rollout can't gate, supersede or roll back each other.
CREATE TABLE agent_update_rollouts (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 name TEXT CHECK(name IS NULL OR length(name) BETWEEN 1 AND 120),
 release_id TEXT NOT NULL REFERENCES agent_releases(id),
 -- The selector as the request gave it, and the canary devices it named.
 selector TEXT NOT NULL CHECK(json_valid(selector)),
 canary_device_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(canary_device_ids)),
 canary_size INTEGER NOT NULL CHECK(canary_size BETWEEN 1 AND 100),
 batch_size INTEGER NOT NULL CHECK(batch_size BETWEEN 1 AND 50),
 observation_seconds INTEGER NOT NULL CHECK(observation_seconds BETWEEN 60 AND 86400),
 failure_threshold INTEGER NOT NULL CHECK(failure_threshold BETWEEN 0 AND 100),
 status TEXT NOT NULL CHECK(status IN ('active','paused','completed','cancelled','failed')),
 failure_reason TEXT CHECK(failure_reason IS NULL OR failure_reason IN ('threshold','data_plane')),
 cancel_reason TEXT CHECK(cancel_reason IS NULL OR cancel_reason IN ('operator','stop','key_revoked','release_withdrawn')),
 -- Set while a stage's observation runs, with what it observes.
 observation_started_at TEXT,
 observation_evidence TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 created_at TEXT NOT NULL,
 created_by TEXT,
 created_by_name TEXT,
 paused_at TEXT,
 completed_at TEXT,
 failed_at TEXT,
 cancelled_at TEXT
);
CREATE INDEX agent_update_rollouts_recent ON agent_update_rollouts(created_at DESC,id);
CREATE INDEX agent_update_rollouts_release ON agent_update_rollouts(release_id,created_at DESC);
-- The scheduler step reads only the rollouts that can still do something.
CREATE INDEX agent_update_rollouts_open ON agent_update_rollouts(status) WHERE status IN ('active','paused');

-- One row per device of a rollout. `stage` is the index of the stage that
-- released it (0 is the canary), null while `pending`. `from_version`,
-- `from_sha256` and `boot_id_before` describe the build the device ran before,
-- as its latest check-in showed; `baseline_issues` holds the data-plane issues
-- (identity and count) that were open when it was released, so a problem that
-- was already there is not counted against the build.
CREATE TABLE agent_update_targets (
 rollout_id TEXT NOT NULL REFERENCES agent_update_rollouts(id),
 device_id TEXT NOT NULL REFERENCES devices(id),
 device_name TEXT NOT NULL,
 stage INTEGER CHECK(stage IS NULL OR stage>=0),
 state TEXT NOT NULL CHECK(state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window','applying','restarted','verified','rolled_back','refused','failed','cancelled','skipped')),
 code TEXT CHECK(code IS NULL OR length(code)<=64),
 from_version TEXT CHECK(from_version IS NULL OR length(from_version)<=128),
 from_sha256 TEXT CHECK(from_sha256 IS NULL OR length(from_sha256)=64),
 boot_id_before TEXT CHECK(boot_id_before IS NULL OR length(boot_id_before)<=128),
 baseline_issues TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(baseline_issues)),
 created_at TEXT NOT NULL,
 released_at TEXT,
 updated_at TEXT NOT NULL,
 verified_at TEXT,
 PRIMARY KEY(rollout_id,device_id)
);
CREATE INDEX agent_update_targets_device ON agent_update_targets(device_id);
CREATE INDEX agent_update_targets_stage ON agent_update_targets(rollout_id,stage);
-- A device is in at most one update rollout that has not ended for it.
CREATE UNIQUE INDEX agent_update_targets_open_device ON agent_update_targets(device_id)
 WHERE state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window','applying','restarted');
-- The silence rules read only the targets that wait for something.
CREATE INDEX agent_update_targets_waiting ON agent_update_targets(state,updated_at)
 WHERE state IN ('offered','downloading','staged','applying','restarted');

-- Creation keys: the deployment request ledger's rules (actor-scoped, never
-- expired, an identical retry returns the original) for update rollouts.
CREATE TABLE agent_update_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 rollout_id TEXT NOT NULL REFERENCES agent_update_rollouts(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
CREATE INDEX agent_update_requests_recent ON agent_update_requests(actor_id,created_at DESC,request_id DESC);
