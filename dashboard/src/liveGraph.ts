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

/** Thinnest and thickest connection, in pixels. */
export const EDGE_WIDTH_MIN = 1.5;
export const EDGE_WIDTH_MAX = 5;
/** A connection reaches its full width at 10,000 events a second. */
const EDGE_WIDTH_DECADES = 4;

/**
 * Stroke width for a rate, in proportion to its logarithm: 1.5 px for nothing
 * or no data, about 3 px at 100 events a second, 5 px from 10,000 up.
 */
export function edgeWidth(rate: number | null) {
  if (rate === null || !Number.isFinite(rate) || rate <= 0)
    return EDGE_WIDTH_MIN;
  const share = Math.min(1, Math.log10(1 + rate) / EDGE_WIDTH_DECADES);
  return (
    Math.round(
      (EDGE_WIDTH_MIN + (EDGE_WIDTH_MAX - EDGE_WIDTH_MIN) * share) * 100,
    ) / 100
  );
}

/** "12.4k events per second", for screen readers; "no data" when unreported. */
export function spokenRate(
  value: number | null | undefined,
  per: "second" | "minute" = "second",
  noun = "events",
) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "no data";
  return `${formatRate(value, "").trim()} ${noun} per ${per}`;
}

const LIVE_PREFERENCE = "vectory.editor.live";
/**
 * Whether this account turned Live on or off for one pipeline in this
 * browser. Null when nobody chose: Live then follows whether a device runs
 * the pipeline.
 */
export function readLivePreference(
  userId: string,
  pipelineId: string,
): boolean | null {
  try {
    const value = localStorage.getItem(
      `${LIVE_PREFERENCE}:${userId}:${pipelineId}`,
    );
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
}
export function writeLivePreference(
  userId: string,
  pipelineId: string,
  on: boolean,
) {
  try {
    localStorage.setItem(
      `${LIVE_PREFERENCE}:${userId}:${pipelineId}`,
      on ? "on" : "off",
    );
  } catch {
    /* The choice lasts for this visit. */
  }
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

/** A step's reading as one phrase, for its accessible name. */
export function nodeLiveSummary(
  kind: "sources" | "transforms" | "sinks",
  reading: NodeLive | null,
) {
  if (!reading) return "no device reports it";
  return [
    kind !== "sources" && `in ${spokenRate(reading.received)}`,
    kind !== "sinks" && `out ${spokenRate(reading.sent)}`,
    !!reading.errors && spokenRate(reading.errors, "minute", "errors"),
    !!reading.dropped &&
      spokenRate(reading.dropped, "minute", "dropped events"),
    reading.buffer !== null &&
      reading.buffer >= 0.01 &&
      `buffer ${Math.round(reading.buffer * 100)} percent full`,
  ]
    .filter(Boolean)
    .join(", ");
}

export type LiveTable = {
  steps: {
    id: string;
    title: string;
    kind: "sources" | "transforms" | "sinks";
    reading: NodeLive | null;
  }[];
  connections: {
    id: string;
    from: string;
    to: string;
    rate: number | null;
  }[];
};
/**
 * Every number the canvas draws, as rows: each step's reading and each
 * connection's rate, in the order the canvas lists them. This is what the
 * "Show as table" alternative shows, so nothing live is available only in a
 * line's width or a chip's position.
 */
export function liveTable(
  steps: {
    id: string;
    title: string;
    kind: LiveTable["steps"][number]["kind"];
  }[],
  connections: {
    id: string;
    source: string;
    sourceHandle?: string | null;
    target: string;
  }[],
  telemetry: PipelineTelemetry | null,
): LiveTable {
  return {
    steps: steps.map((step) => ({
      ...step,
      reading: nodeLive(telemetry, step.id),
    })),
    connections: connections.map((connection) => {
      const port =
        connection.sourceHandle && connection.sourceHandle !== "output"
          ? `.${connection.sourceHandle}`
          : "";
      return {
        id: connection.id,
        from: `${connection.source}${port}`,
        to: connection.target,
        rate: edgeRate(
          telemetry,
          connection.source,
          connection.sourceHandle || "output",
        ),
      };
    }),
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
