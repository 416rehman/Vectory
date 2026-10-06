-- Retention pruning and the fleet series read telemetry by time across all
-- devices; the primary key (device_id,bucket) only serves per-device reads.
CREATE INDEX telemetry_bucket ON telemetry(bucket);
