/**
 * Live numbers on the pipeline canvas, from `GET /configurations/{id}/telemetry`:
 * rates summed across the devices verified to run a version of this pipeline.
 * A value no device reported is null and reads as "no data", never zero.
 */
export type ComponentRates = {
  id: string;
  kind?: string | null;
  type?: string | null;
  devices_reporting: number;
  received_events_per_second?: number | null;
  sent_events_per_second?: number | null;
  errors_per_minute?: number | null;
  filtered_per_minute?: number | null;
  dropped_per_minute?: number | null;
  buffer_utilization_max?: number | null;
  sent_by_output?: Record<string, number> | null;
};
export type PipelineTelemetry = {
  configuration_id?: string;
  devices_running: number;
  devices_reporting: number;
  newest_sample_at?: string | null;
  components: ComponentRates[];
  versions?: {
    version_id: string;
    version_number: number | null;
    devices_running: number;
    devices_reporting: number;
  }[];
};

/** Compact, fixed-width-friendly events per second: "3.9/s", "1.2k/s". */
export function formatRate(value: number | null | undefined, unit = "/s") {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  if (value === 0) return `0${unit}`;
  if (value < 0.1) return `<0.1${unit}`;
  if (value < 10) return `${value.toFixed(1)}${unit}`;
  if (value < 1000) return `${Math.round(value)}${unit}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k${unit}`;
  return `${(value / 1_000_000).toFixed(1)}M${unit}`;
}

export function componentRates(
  telemetry: PipelineTelemetry | null,
  id: string,
) {
  return telemetry?.components.find((component) => component.id === id);
}

/**
 * Events per second leaving `source` through `port` ("output" is the
 * default output). Null when no device reports that output.
 */
export function edgeRate(
  telemetry: PipelineTelemetry | null,
  source: string,
  port = "output",
): number | null {
  const component = componentRates(telemetry, source);
  if (!component) return null;
  const outputs = component.sent_by_output;
  if (port && port !== "output") {
    const rate = outputs?.[port];
    return typeof rate === "number" ? rate : null;
  }
  // Vector names the default output `_default`; a component with one output
  // may report only its total.
  const fallback = outputs?._default;
  return typeof fallback === "number"
    ? fallback
    : (component.sent_events_per_second ?? null);
}

/** Stroke width for a rate: thin at a trickle, never louder than 4.5 px. */
export function edgeWidth(rate: number | null) {
  if (rate === null || rate <= 0) return 1.5;
  return Math.min(4.5, 1.75 + Math.log10(1 + rate));
}

export type NodeLive = {
  received: number | null;
  sent: number | null;
  errors: number | null;
  dropped: number | null;
  filtered: number | null;
  buffer: number | null;
  devices: number;
};

/** A step's live reading, or null when no device reports it. */
export function nodeLive(
  telemetry: PipelineTelemetry | null,
  id: string,
): NodeLive | null {
  const component = componentRates(telemetry, id);
  if (!component) return null;
  return {
    received: component.received_events_per_second ?? null,
    sent: component.sent_events_per_second ?? null,
    errors: component.errors_per_minute ?? null,
    dropped: component.dropped_per_minute ?? null,
    filtered: component.filtered_per_minute ?? null,
    buffer: component.buffer_utilization_max ?? null,
    devices: component.devices_reporting,
  };
}

const devices = (count: number) =>
  `${count} ${count === 1 ? "device" : "devices"}`;

export type LiveSummary = {
  tone: "live" | "empty" | "partial";
  message: string;
  /** Offer the monitoring pair: devices run the pipeline but report nothing. */
  suggestMonitoring: boolean;
};

/**
 * One line for the canvas banner: which versions the numbers describe and
 * how many devices report, or why there is nothing to show.
 */
export function liveSummary(
  telemetry: PipelineTelemetry,
  latestVersion: number | null,
): LiveSummary {
  const running = (telemetry.versions ?? []).filter(
    (version) => version.devices_running > 0,
  );
  if (!telemetry.devices_running)
    return {
      tone: "empty",
      message: latestVersion
        ? `No device runs this pipeline yet. Deploy v${latestVersion} to see live numbers.`
        : "No device runs this pipeline yet. Publish and deploy it to see live numbers.",
      suggestMonitoring: false,
    };
  const which = running.length
    ? running
        .map((version) =>
          running.length > 1
            ? `v${version.version_number} on ${version.devices_running}`
            : `v${version.version_number}`,
        )
        .join(", ")
    : "";
  if (!telemetry.devices_reporting)
    return {
      tone: "empty",
      message: `No device reports metrics for ${which || "this pipeline"} yet.`,
      suggestMonitoring: true,
    };
  const reporting =
    telemetry.devices_reporting < telemetry.devices_running
      ? `${telemetry.devices_reporting} of ${devices(telemetry.devices_running)} reporting`
      : `${devices(telemetry.devices_reporting)}`;
  const behind =
    latestVersion !== null &&
    running.length > 0 &&
    !running.some((version) => version.version_number === latestVersion)
      ? ` · v${latestVersion} isn't running yet`
      : "";
  return {
    tone:
      telemetry.devices_reporting < telemetry.devices_running
        ? "partial"
        : "live",
    message: `Live${which ? ` for ${which}` : ""} · ${reporting}${behind}`,
    suggestMonitoring: false,
  };
}
