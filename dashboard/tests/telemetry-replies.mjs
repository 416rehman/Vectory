// The reply to `GET /configurations/{id}/telemetry` for harnesses that open a
// published pipeline: the editor reads it to learn whether a device runs the
// pipeline. By default no device does. The aggregate is complete, as the
// dashboard refuses anything short of it. Test data only.
const totals = {
  events_in_per_second: null,
  events_out_per_second: null,
  bytes_in_per_second: null,
  bytes_out_per_second: null,
  errors_per_minute: null,
  filtered_per_minute: null,
  dropped_per_minute: null,
};

/**
 * @param {string} configurationId
 * @param {object} [values] Anything to replace: devices, components, versions.
 */
export function pipelineTelemetry(configurationId, values = {}) {
  return {
    generated_at: "2026-09-26T12:00:00Z",
    devices_running: 0,
    devices_reporting: 0,
    device_ids: [],
    oldest_sample_at: null,
    newest_sample_at: null,
    ...totals,
    coverage: {},
    components: [],
    configuration_id: configurationId,
    versions: [],
    ...values,
  };
}

/** Whether a request path is that read. */
export const isPipelineTelemetry = (path, configurationId) =>
  path === `/configurations/${configurationId}/telemetry`;
