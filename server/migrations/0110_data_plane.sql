-- Private evaluator state for data-plane health (server/src/data_plane.rs):
-- consecutive-evaluation streaks per device for the version it runs. It is
-- bounded by the evaluator and never served to clients; operators see the
-- resulting DATA_PLANE_* issues and the device's `data_plane` summary.
CREATE TABLE data_plane_state (
 device_id TEXT PRIMARY KEY REFERENCES devices(id),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data) <= 131072)
);
