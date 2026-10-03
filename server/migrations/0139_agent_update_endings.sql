-- Update rollouts end in two more ways, and a rollout keeps the time it last
-- made progress (server/src/agent_update_rollouts/engine.rs).
--
-- `failure_reason` gains `stalled`: a rollout that still had work to do and made
-- no progress for 24 hours. `cancel_reason` gains `release_expired`: the release
-- the rollout offers expired. SQLite cannot change a CHECK in place, so each
-- column is replaced by one with the wider list, through a column of the new
-- shape: the table itself stays, with its rows, indexes and the foreign keys of
-- its targets and request keys.
ALTER TABLE agent_update_rollouts ADD COLUMN failure_reason_next TEXT
 CHECK(failure_reason_next IS NULL OR failure_reason_next IN ('threshold','data_plane','stalled'));
ALTER TABLE agent_update_rollouts ADD COLUMN cancel_reason_next TEXT
 CHECK(cancel_reason_next IS NULL OR cancel_reason_next IN ('operator','stop','key_revoked','release_withdrawn','release_expired'));
UPDATE agent_update_rollouts SET failure_reason_next=failure_reason, cancel_reason_next=cancel_reason;
ALTER TABLE agent_update_rollouts DROP COLUMN failure_reason;
ALTER TABLE agent_update_rollouts DROP COLUMN cancel_reason;
ALTER TABLE agent_update_rollouts RENAME COLUMN failure_reason_next TO failure_reason;
ALTER TABLE agent_update_rollouts RENAME COLUMN cancel_reason_next TO cancel_reason;

-- When the rollout last made progress at its own level: it resumed, released a
-- stage, or an observation started or ended. A change of a target is progress
-- too, and is read from the targets. Null until then: the rollout's creation is
-- the last progress.
ALTER TABLE agent_update_rollouts ADD COLUMN progressed_at TEXT;

-- What hosts report about updates is kept only while updates are on. A server
-- with updates off kept it all the same until now, and a counter a host
-- reported then must not move the next release's: those reports go.
DELETE FROM agent_update_reports WHERE (SELECT enabled FROM agent_update_settings WHERE id=1)=0;
