/** Pure Overview logic: health buckets, telemetry coverage, rollout progress. */
import { deviceDisplayStatus, type DeviceStatusInput } from "./status";

export type HealthBucket =
  | "applied"
  | "updating"
  | "check"
  | "failed"
  | "offline"
  | "paused"
  | "unmanaged";
export const healthOrder: HealthBucket[] = [
  "applied",
  "updating",
  "check",
  "failed",
  "offline",
  "paused",
  "unmanaged",
];
export const healthLabels: Record<HealthBucket, string> = {
  applied: "Applied",
  updating: "Updating",
  check: "Check required",
  failed: "Failed",
  offline: "Offline",
  paused: "Paused",
  unmanaged: "No pipeline",
};
/** The device states each bucket stands for (for filters and links). */
export const healthStates: Record<HealthBucket, string[]> = {
  applied: ["verified"],
  updating: ["applying"],
  check: ["verification_unknown"],
  failed: ["failed", "rolled_back", "conflict"],
  offline: ["offline"],
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
  top: { id: string; name: string; eventsPerSecond: number }[];
  freshest: string | null;
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
