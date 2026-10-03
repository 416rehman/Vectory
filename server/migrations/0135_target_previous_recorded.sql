-- A deployment target records what its device ran just before the deployment
-- first reached it (`previous_version_id`, `previous_artifact_sha256`,
-- `previous_generation`), once. The assignment can reach the device again, for
-- example when a higher-priority deployment that took it is removed; that
-- must not make the interim winner the version a rollback returns to.
-- `previous_recorded` is 0 from a target's release until the assignment first
-- takes the device, and 1 after.
--
-- Existing targets that took their device already recorded it. A released
-- target that has not taken the device yet (a higher-priority assignment holds
-- it) records when it does.
ALTER TABLE deployment_targets ADD COLUMN previous_recorded INTEGER NOT NULL DEFAULT 0 CHECK(previous_recorded IN (0,1));
UPDATE deployment_targets SET previous_recorded=1
 WHERE generation>0 AND state<>'removed'
   AND (previous_version_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM devices d WHERE d.id=deployment_targets.device_id AND d.assignment_id=deployment_targets.deployment_id));
