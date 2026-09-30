/** Pure Overview logic: health buckets, telemetry coverage, what runs where. */
import { countLabel } from "./countLabel";
import { deviceStatuses } from "./status";
import type {
  OverviewBusyDevice,
  OverviewCounts,
  OverviewRunning,
} from "./api";

export type HealthBucket =
  | "applied"
  | "degraded"
  | "updating"
  | "check"
  | "failed"
  | "offline"
  | "paused"
  | "unmanaged";
export const healthOrder: HealthBucket[] = [
  "applied",
  "degraded",
  "updating",
  "check",
  "failed",
  "offline",
  "paused",
  "unmanaged",
];
export const healthLabels: Record<HealthBucket, string> = {
  applied: deviceStatuses.verified.label,
  degraded: deviceStatuses.degraded.label,
  updating: deviceStatuses.applying.label,
  check: deviceStatuses.verification_unknown.label,
  failed: deviceStatuses.failed.label,
  offline: deviceStatuses.offline.label,
  paused: deviceStatuses.paused.label,
  unmanaged: deviceStatuses.unmanaged.label,
};
/** The device states each bucket stands for (for filters and links). */
export const healthStates: Record<HealthBucket, string[]> = {
  applied: ["verified"],
  // Applied, but an open data-plane issue says it isn't delivering.
  degraded: ["degraded"],
  updating: ["applying"],
  check: ["verification_unknown"],
  failed: ["failed", "rolled_back", "conflict"],
  // Never connected is still not connected: it is not an update in progress.
  offline: ["offline", "awaiting_first_check_in"],
  paused: ["paused", "pause_requested"],
  unmanaged: ["unmanaged"],
};

export const TELEMETRY_FRESH_MS = 3 * 60 * 1000;
export type FleetTelemetry = {
  /** Live devices that could report (not revoked). */
  eligible: number;
  /** Devices with a sample in the last three minutes. */
  reporting: number;
  /** Devices whose last sample is older than that. */
  stale: number;
  /** Sum of fresh events/s, or null when no fresh device reports a rate. */
  eventsPerSecond: number | null;
  /** Devices contributing to the events/s sum. */
  rateDevices: number;
  /** Sum of fresh sink delivery rates, when agents report them. */
  eventsOutPerSecond: number | null;
  outDevices: number;
  /** Sum of cumulative component errors since each Vector started. */
  errors: number | null;
  /** Sum of fresh error rates, when agents report them. */
  errorsPerMinute: number | null;
  /** Devices without a fresh sample whose agent settings turn metrics off. */
  disabled: number;
  top: FleetDeviceRate[];
  freshest: string | null;
};
export type FleetDeviceRate = {
  id: string;
  name: string;
  eventsPerSecond: number;
  /** Sink delivery rate when the agent reports it, else null. */
  eventsOutPerSecond: number | null;
};
export const present = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Fleet throughput as the server summed it from each device's latest sample.
 * Missing data stays missing: a fleet no fresh device reported on has a null
 * total, never a zero.
 */
export function telemetryFromCounts(
  telemetry: OverviewCounts["telemetry"],
  busiest: OverviewBusyDevice[],
): FleetTelemetry {
  return {
    eligible: telemetry.eligible,
    reporting: telemetry.reporting,
    stale: telemetry.stale,
    eventsPerSecond: telemetry.events_in_per_second,
    rateDevices: telemetry.events_in_devices,
    eventsOutPerSecond: telemetry.events_out_per_second,
    outDevices: telemetry.events_out_devices,
    errors: telemetry.errors,
    errorsPerMinute: telemetry.errors_per_minute,
    disabled: telemetry.disabled,
    top: busiest.map((device) => ({
      id: device.id,
      name: device.name,
      eventsPerSecond: device.events_in_per_second,
      eventsOutPerSecond: device.events_out_per_second,
    })),
    freshest: telemetry.newest_sample_at,
  };
}

/** Whether the agent sent a metrics sample in the last three minutes. */
export function reportsMetrics(
  device: { telemetry?: { sampled_at: string } | null },
  now = Date.now(),
) {
  const sampled = Date.parse(device.telemetry?.sampled_at || "");
  return Number.isFinite(sampled) && now - sampled <= TELEMETRY_FRESH_MS;
}
/** "Nothing is failing" only where Vectory measures delivery everywhere. */
export function quietSummary(unmeasured: number) {
  return unmeasured
    ? "Nothing is failing that Vectory can measure"
    : "Nothing is failing";
}
/**
 * The pipeline most running devices have no metrics from, to offer "Add
 * monitoring to <pipeline>"; null when every running pipeline reports.
 */
export function monitoringTarget(
  running: Pick<
    OverviewRunning,
    | "configuration_id"
    | "configuration_name"
    | "device_count"
    | "devices_reporting"
  >[],
) {
  const tally = new Map<string, { id: string; name: string; count: number }>();
  for (const row of running) {
    const silent = row.device_count - row.devices_reporting;
    if (silent <= 0 || !row.configuration_name) continue;
    const entry = tally.get(row.configuration_id) || {
      id: row.configuration_id,
      name: row.configuration_name,
      count: 0,
    };
    entry.count += silent;
    tally.set(entry.id, entry);
  }
  return (
    [...tally.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    )[0] || null
  );
}
/**
 * What runs on devices without a pipeline: a local configuration adopted at
 * setup keeps running until a deployment replaces it; anywhere else Vector
 * starts only with the first deployment.
 */
export function unmanagedDetail(count: number, adopted: number) {
  const one = count === 1;
  if (!adopted)
    return `Vector starts on ${one ? "it" : "them"} when you deploy a pipeline.`;
  if (adopted >= count)
    return one
      ? "A local configuration adopted at setup keeps running until you deploy one."
      : "Local configurations adopted at setup keep running until you deploy one.";
  return `${adopted.toLocaleString()} ${adopted === 1 ? "runs" : "run"} a local configuration adopted at setup until you deploy one; Vector starts on the others when you deploy.`;
}

/** "Edge collectors", "Edge collectors and Web tier", "A, B, C and 2 more". */
export function groupList(names: string[], more = 0) {
  if (more > 0) return `${names.join(", ")} and ${more.toLocaleString()} more`;
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
/**
 * Events in and out per second across a version's devices: "14.0 → 4.5/s".
 * Null before any device reported; an unknown rate is never shown as 0.
 */
export function runningRate(
  row: Pick<OverviewRunning, "events_in_per_second" | "events_out_per_second">,
) {
  const input = row.events_in_per_second;
  const output = row.events_out_per_second;
  if (input === null && output === null) return null;
  if (input !== null && output !== null)
    return `${formatRate(input)} → ${formatRate(output)}/s`;
  return input !== null
    ? `${formatRate(input)}/s in`
    : `${formatRate(output ?? 0)}/s out`;
}
const canaryPhases: Record<
  NonNullable<OverviewRunning["canary"]>["phase"],
  string
> = {
  measuring: "measuring delivery",
  observing: "observing for problems",
  waiting: "waiting to start observing",
};
/**
 * What a running version says besides "running": devices not delivering, and
 * a canary rollout of it with what it is doing. Each note links to the page
 * that explains it.
 */
export function runningNotes(row: OverviewRunning) {
  const notes: { text: string; tone: "danger" | "info"; href: string }[] = [];
  if (row.not_delivering > 0)
    notes.push({
      text: `${row.not_delivering.toLocaleString()} not delivering`,
      tone: "danger",
      href: `#/devices?running=${encodeURIComponent(row.version_id)}&status=degraded`,
    });
  const canary = row.canary;
  if (canary) {
    const names = canary.device_names;
    const where =
      names.length <= 2 && canary.device_count === names.length
        ? names.join(" and ")
        : countLabel(canary.device_count, "device");
    notes.push({
      text: `canary on ${where} · ${canaryPhases[canary.phase]}`,
      tone: "info",
      href: `#/deployments/${encodeURIComponent(canary.deployment_id)}`,
    });
  }
  return notes;
}

export type ChecklistState = {
  releases: number | null;
  devices: number;
  checkedIn: number;
  pipelines: number;
  versions: number;
  applied: number;
};
export type ChecklistStep = {
  id: "downloads" | "device" | "pipeline" | "publish" | "deploy";
  done: boolean;
};
/** First-run steps from real state; downloads count as done once a device exists. */
export function checklist(state: ChecklistState): ChecklistStep[] {
  return [
    {
      id: "downloads",
      done: (state.releases ?? 0) > 0 || state.devices > 0,
    },
    { id: "device", done: state.checkedIn > 0 },
    { id: "pipeline", done: state.pipelines > 0 },
    { id: "publish", done: state.versions > 0 },
    { id: "deploy", done: state.applied > 0 },
  ];
}

/** "1 device", "3 devices". */
export { countLabel } from "./countLabel";

/** One Needs-you row: a device group, possibly with the rollout it stopped. */
export type NeedsYouRow<G, R> =
  | { kind: "group"; group: G; rollout: R | null }
  | { kind: "rollout"; rollout: R };
/**
 * Needs you, one row per problem, most urgent first: devices losing data
 * (not delivering), then failed applies, then rollouts that stopped, then
 * everything else in the server's order. A device group and the stopped
 * rollout its devices share read as one row. Dismissed rollouts are left out;
 * device problems can't be dismissed while they last.
 */
export function needsYouRows<
  G extends { cause: string; deployment_id?: string | null },
  R extends { key: string; deployment: { id: string } },
>(groups: G[], rollouts: R[], dismissed: ReadonlySet<string>) {
  const open = rollouts.filter((rollout) => !dismissed.has(rollout.key));
  const merged = new Set<R>();
  const withRollout = (group: G): NeedsYouRow<G, R> => {
    const id = group.deployment_id?.toLowerCase();
    const rollout =
      open.find(
        (candidate) =>
          !merged.has(candidate) &&
          candidate.deployment.id.toLowerCase() === id,
      ) || null;
    if (rollout) merged.add(rollout);
    return { kind: "group", group, rollout };
  };
  const urgent = [
    ...groups.filter((group) => group.cause === "degraded"),
    ...groups.filter((group) => group.cause === "failed"),
  ].map(withRollout);
  return [
    ...urgent,
    ...open
      .filter((rollout) => !merged.has(rollout))
      .map((rollout): NeedsYouRow<G, R> => ({ kind: "rollout", rollout })),
    ...groups
      .filter((group) => group.cause !== "degraded" && group.cause !== "failed")
      .map((group): NeedsYouRow<G, R> => ({
        kind: "group",
        group,
        rollout: null,
      })),
  ];
}

/** A rate for display: "0", "0.42", "4.9", "1,284", "12.3K". */
export function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  if (value < 10000) return Math.round(value).toLocaleString();
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** A round axis maximum at or above the value: 1, 2, 2.5, 5, 10, 20… */
export function niceCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10])
    if (step * power >= value) return step * power;
  return 10 * power;
}

/** One point of a fleet series: the bucket's start and how many devices it holds. */
export type SeriesBucket = { at: string; devices: number | null };
/**
 * The series without its newest bucket while that bucket is still collecting.
 * A minute that has heard from one of four devices sums to a quarter of the
 * fleet and reads as an outage; the line ends at the last complete bucket.
 * A bucket that ended under a minute ago with fewer devices than the one
 * before is treated as still collecting too (late check-ins, clock skew).
 */
export function completeSeries<T extends SeriesBucket>(
  series: T[],
  now = Date.now(),
  /** The server's bucket width; a gap in the data must not stretch it. */
  stepMs = 60_000,
): T[] {
  if (series.length < 2) return series;
  const last = series[series.length - 1];
  const previous = series[series.length - 2];
  const start = Date.parse(last.at);
  if (!Number.isFinite(start) || !(stepMs > 0)) return series;
  const end = start + stepMs;
  const thin =
    last.devices !== null &&
    previous.devices !== null &&
    last.devices < previous.devices;
  const collecting = end > now || (thin && end + 60_000 > now);
  return collecting ? series.slice(0, -1) : series;
}
