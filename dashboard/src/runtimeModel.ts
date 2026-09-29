import { z } from "zod";

// Response shapes for Vector runtime evidence: redacted diagnostics, the
// host's runtime settings, Vector log summaries and telemetry. The server
// validates every field on ingest (see contracts/CONTRACT.md); these schemas
// mirror its bounds so a contract change fails loudly instead of rendering
// guesses.

const componentKind = z.enum(["source", "transform", "sink"]);

/** One redacted finding from Vector's own output. */
export const DiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string().min(1).max(48),
  component_kind: componentKind.optional(),
  component_id: z.string().min(1).max(100).optional(),
  route_output: z.string().min(1).max(100).optional(),
  field: z.string().min(1).max(128).optional(),
  line: z.number().int().min(1).max(1_000_000).optional(),
  column: z.number().int().min(1).max(1_000_000).optional(),
  reason: z.string().min(1).max(32).optional(),
  message: z.string().min(1).max(300),
  hint: z.string().min(1).max(200).optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export const DiagnosticsSchema = z.array(DiagnosticSchema).max(10);

/** Where a finding is: component (and route output) and VRL position. */
export function diagnosticPlace(diagnostic: Diagnostic) {
  const place: string[] = [];
  if (diagnostic.component_id)
    place.push(
      diagnostic.route_output
        ? `${diagnostic.component_id}.${diagnostic.route_output}`
        : diagnostic.component_id,
    );
  if (diagnostic.line)
    place.push(
      diagnostic.column
        ? `line ${diagnostic.line}, column ${diagnostic.column}`
        : `line ${diagnostic.line}`,
    );
  return place;
}

/** The first error (else the first finding): what to explain in one line. */
export function leadingDiagnostic(diagnostics: Diagnostic[] | undefined) {
  return (
    diagnostics?.find((diagnostic) => diagnostic.severity === "error") ??
    diagnostics?.[0]
  );
}

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** "Reason (component, line 1, column 2). Fix." for one finding. */
export function describeDiagnostic(diagnostic: Diagnostic) {
  const place = diagnosticPlace(diagnostic);
  const message = diagnostic.message.replace(/\.$/, "");
  const reason = sentence(
    place.length ? `${message} (${place.join(", ")})` : message,
  );
  return diagnostic.hint ? `${reason} ${sentence(diagnostic.hint)}` : reason;
}

/** What the host contributes to Vector's runtime beyond the signed artifact. */
export const HostRuntimeSchema = z.object({
  data_dir: z.string().min(1).max(4096).optional(),
  data_dir_source: z
    .enum(["pipeline", "host", "adopted", "vector_default", "agent_default"])
    .optional(),
  graceful_shutdown_seconds: z.number().int().min(1).max(3600).optional(),
  metrics_source: z.enum(["explicit", "discovered", "none"]).optional(),
  metrics_address: z.string().min(1).max(64).optional(),
  activation: z.enum(["reload", "restart"]).optional(),
});
export type HostRuntime = z.infer<typeof HostRuntimeSchema>;

export const VectorLogGroupSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  level: z.enum(["error", "warn"]),
  component_id: z.string().min(1).max(100).optional(),
  component_kind: componentKind.optional(),
  component_type: z.string().min(1).max(64).optional(),
  error_type: z.string().min(1).max(64).optional(),
  stage: z.string().min(1).max(64).optional(),
  reason: z.string().min(1).max(32).optional(),
  message: z.string().min(1).max(300),
  count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  first_seen: z.string(),
  last_seen: z.string(),
});
export type VectorLogGroup = z.infer<typeof VectorLogGroupSchema>;
export const VectorLogSummarySchema = z.object({
  reported_at: z.string(),
  items: z.array(VectorLogGroupSchema).max(20),
});
export type VectorLogSummary = z.infer<typeof VectorLogSummarySchema>;

// Missing values are unavailable, never zero.
const metric = z.number().min(0).max(1e15).nullable().optional();
const ratio = z.number().min(0).max(1).nullable().optional();

export const ComponentTelemetrySchema = z
  .object({
    id: z.string().max(100),
    type: z.string().max(100).optional(),
    kind: componentKind.optional(),
    events_per_second: metric,
    received_events_per_second: metric,
    received_bytes_per_second: metric,
    sent_bytes_per_second: metric,
    errors: metric,
    errors_per_minute: metric,
    discarded_events: metric,
    discarded_intentional: metric,
    discarded_error: metric,
    filtered_per_minute: metric,
    dropped_per_minute: metric,
    buffer_events: metric,
    buffer_bytes: metric,
    buffer_max_events: metric,
    buffer_max_bytes: metric,
    buffer_utilization: ratio,
    utilization: ratio,
    latency_mean_seconds: metric,
    sent_by_output: z
      .record(z.string().max(100), z.number().min(0).max(1e15))
      .optional(),
  })
  .passthrough();
export type ComponentTelemetry = z.infer<typeof ComponentTelemetrySchema>;

/** A device sample, or a downsampled history point (bucket + samples). */
export const TelemetrySampleSchema = z
  .object({
    sampled_at: z.string(),
    bucket: z.number().int().optional(),
    samples: z.number().int().min(1).optional(),
    events_per_second: metric,
    events_out_per_second: metric,
    bytes_in_per_second: metric,
    bytes_out_per_second: metric,
    errors: metric,
    errors_per_minute: metric,
    uptime_seconds: metric,
    memory_bytes: metric,
    cpu_seconds: metric,
    discarded_events: metric,
    discarded_intentional: metric,
    discarded_error: metric,
    filtered_per_minute: metric,
    dropped_per_minute: metric,
    buffer_bytes: metric,
    buffer_events: metric,
    buffer_utilization: ratio,
    components: z.array(ComponentTelemetrySchema).max(50).optional(),
  })
  .passthrough();
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;

export const TELEMETRY_RANGES = [
  "15m",
  "1h",
  "2h",
  "6h",
  "24h",
  "7d",
  "30d",
] as const;
export type TelemetryRange = (typeof TELEMETRY_RANGES)[number];

export const TelemetryHistorySchema = z.object({
  device_id: z.string(),
  range: z.enum(TELEMETRY_RANGES).optional(),
  step_seconds: z.number().int().min(60).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  samples: z.array(TelemetrySampleSchema).max(360),
});
export type TelemetryHistory = z.infer<typeof TelemetryHistorySchema>;

const fleetTotals = {
  events_in_per_second: metric,
  events_out_per_second: metric,
  bytes_in_per_second: metric,
  bytes_out_per_second: metric,
  errors_per_minute: metric,
  filtered_per_minute: metric,
  dropped_per_minute: metric,
};
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const coverage = z.record(z.string(), count);

export const TelemetrySummarySchema = z.object({
  generated_at: z.string(),
  range: z.enum(TELEMETRY_RANGES),
  step_seconds: z.number().int().min(60),
  from: z.string(),
  devices_total: count,
  devices_reporting: count,
  devices_metrics_disabled: count,
  devices_without_metrics_endpoint: count,
  fresh_seconds: count,
  newest_sample_at: z.string().nullable(),
  ...fleetTotals,
  buffer_utilization_max: ratio,
  coverage,
  series: z
    .array(
      z.object({
        bucket: z.number().int(),
        at: z.string(),
        devices_reporting: count,
        events_in_per_second: metric,
        events_out_per_second: metric,
        errors_per_minute: metric,
        dropped_per_minute: metric,
        buffer_utilization_max: ratio,
      }),
    )
    .max(360),
});
export type TelemetrySummary = z.infer<typeof TelemetrySummarySchema>;

const ComponentAggregateSchema = z.object({
  id: z.string().max(100),
  kind: componentKind.nullable(),
  type: z.string().max(100).nullable(),
  devices_reporting: count,
  received_events_per_second: metric,
  sent_events_per_second: metric,
  received_bytes_per_second: metric,
  sent_bytes_per_second: metric,
  errors_per_minute: metric,
  filtered_per_minute: metric,
  dropped_per_minute: metric,
  buffer_events: metric,
  buffer_bytes: metric,
  buffer_utilization_max: ratio,
  utilization_max: ratio,
  latency_mean_seconds_max: metric,
  sent_by_output: z
    .record(z.string().max(100), z.number().min(0).max(1e15))
    .nullable(),
});
const aggregate = {
  generated_at: z.string(),
  devices_running: count,
  devices_reporting: count,
  device_ids: z.array(z.string()),
  oldest_sample_at: z.string().nullable(),
  newest_sample_at: z.string().nullable(),
  ...fleetTotals,
  coverage,
  components: z.array(ComponentAggregateSchema),
};
export const VersionTelemetrySchema = z.object({
  ...aggregate,
  version_id: z.string(),
  configuration_id: z.string(),
  version_number: z.number().int().min(1),
});
export const ConfigurationTelemetrySchema = z.object({
  ...aggregate,
  configuration_id: z.string(),
  versions: z.array(
    z.object({
      version_id: z.string(),
      version_number: z.number().int().min(1).nullable(),
      devices_running: count,
      devices_reporting: count,
    }),
  ),
});
