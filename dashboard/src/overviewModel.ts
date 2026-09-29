/** Pure Overview logic: health buckets, telemetry coverage, rollout progress. */
import {
  deviceDisplayStatus,
  deviceStatuses,
  type DeviceStatusInput,
} from "./status";

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

export function healthBucket(device: DeviceStatusInput): HealthBucket | null {
  const status = deviceDisplayStatus(device);
  if (status === "revoked") return null;
  for (const bucket of healthOrder)
    if (healthStates[bucket].includes(status)) return bucket;
  // A state added later reads as in progress rather than healthy.
  return "updating";
}

export function healthCounts(devices: DeviceStatusInput[]) {
  const counts = Object.fromEntries(healthOrder.map((b) => [b, 0])) as Record<
    HealthBucket,
    number
  >;
  let total = 0;
  for (const device of devices) {
    const bucket = healthBucket(device);
    if (!bucket) continue;
    counts[bucket]++;
    total++;
  }
  return { counts, total };
}

type TelemetryDevice = {
  id: string;
  name: string;
  status: string;
  effective_policy?: { telemetry_enabled?: boolean } | null;
  telemetry?: {
    sampled_at: string;
    events_per_second?: number | null;
    /** Sink delivery rate, reported by newer agents. */
    events_out_per_second?: number | null;
    errors?: number | null;
    errors_per_minute?: number | null;
  } | null;
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
 * Fleet throughput from each device's latest sample. Missing data stays
 * missing: a device without a fresh sample adds nothing, never a zero.
 */
export function fleetTelemetry(
  devices: TelemetryDevice[],
  now = Date.now(),
): FleetTelemetry {
  let reporting = 0,
    stale = 0,
    rateDevices = 0,
    rate = 0,
    out = 0,
    outDevices = 0,
    errors = 0,
    errorDevices = 0,
    errorRate = 0,
    errorRateDevices = 0,
    disabled = 0,
    eligible = 0;
  let freshest: number | null = null;
  const top: FleetTelemetry["top"] = [];
  for (const device of devices) {
    if (device.status === "revoked") continue;
    eligible++;
    const sampled = Date.parse(device.telemetry?.sampled_at || "");
    const fresh =
      Number.isFinite(sampled) && now - sampled <= TELEMETRY_FRESH_MS;
    if (!fresh) {
      if (Number.isFinite(sampled)) stale++;
      if (device.effective_policy?.telemetry_enabled === false) disabled++;
      continue;
    }
    reporting++;
    freshest = freshest === null ? sampled : Math.max(freshest, sampled);
    const sample = device.telemetry!;
    if (present(sample.events_per_second)) {
      rate += sample.events_per_second;
      rateDevices++;
      top.push({
        id: device.id,
        name: device.name,
        eventsPerSecond: sample.events_per_second,
        eventsOutPerSecond: present(sample.events_out_per_second)
          ? sample.events_out_per_second
          : null,
      });
    }
    if (present(sample.events_out_per_second)) {
      out += sample.events_out_per_second;
      outDevices++;
    }
    if (present(sample.errors)) {
      errors += sample.errors;
      errorDevices++;
    }
    if (present(sample.errors_per_minute)) {
      errorRate += sample.errors_per_minute;
      errorRateDevices++;
    }
  }
  top.sort((a, b) => b.eventsPerSecond - a.eventsPerSecond);
  return {
    eligible,
    reporting,
    stale,
    eventsPerSecond: rateDevices ? rate : null,
    rateDevices,
    eventsOutPerSecond: outDevices ? out : null,
    outDevices,
    errors: errorDevices ? errors : null,
    errorsPerMinute: errorRateDevices ? errorRate : null,
    disabled,
    top: top.slice(0, 5),
    freshest: freshest === null ? null : new Date(freshest).toISOString(),
  };
}

export type RolloutProgress = {
  total: number;
  verified: number;
  inFlight: number;
  waiting: number;
  attention: number;
  failed: number;
};
const inFlightStates = [
  "desired",
  "downloaded",
  "validated",
  "written",
  "reload_requested",
];
/** Split persisted target states into the four stacks a rollout bar shows. */
export function rolloutProgress(
  counts: Record<string, number>,
): RolloutProgress {
  const progress: RolloutProgress = {
    total: 0,
    verified: 0,
    inFlight: 0,
    waiting: 0,
    attention: 0,
    failed: 0,
  };
  for (const [state, value] of Object.entries(counts || {})) {
    if (!present(value) || value <= 0 || state === "removed") continue;
    progress.total += value;
    if (state === "verified_applied") progress.verified += value;
    else if (inFlightStates.includes(state)) progress.inFlight += value;
    else if (["failed", "rolled_back", "incompatible"].includes(state))
      progress.failed += value;
    else if (["verification_unknown", "blocked"].includes(state))
      progress.attention += value;
    else progress.waiting += value;
  }
  return progress;
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
export const countLabel = (count: number, word: string, many = `${word}s`) =>
  `${count.toLocaleString()} ${count === 1 ? word : many}`;

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
