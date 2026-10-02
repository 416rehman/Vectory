import type { CanaryWatch, CanaryWatchDevice, RolloutLane } from "./api";
import {
  gateReasonHelp,
  gateReasonLabels,
  gateReasons,
  readGateReason,
  type CanaryGate,
  type GateReason,
} from "./canaryGateModel";
import { formatRate } from "./liveGraph";
import { formatPercent } from "./telemetryChart";

const nameOf = (device: { device_name: string | null }) =>
  device.device_name || "an unnamed device";

/**
 * Devices named for a sentence: "edge-nyc-02", "edge-nyc-02 and edge-nyc-03",
 * "edge-nyc-02 and 3 more". `total` counts every device the sentence is about,
 * named or not; with no names it says how many.
 */
export function nameList(names: string[], total: number, noun = "device") {
  if (total <= 0) return "";
  if (total === 1) return names[0] ?? `1 ${noun}`;
  if (total === 2 && names.length >= 2) return `${names[0]} and ${names[1]}`;
  if (names.length) return `${names[0]} and ${total - 1} more`;
  return `${total} ${noun}s`;
}

/** The watched devices the gate holds back for `reason`. */
function held(watch: CanaryWatch | null | undefined, reason: GateReason) {
  return (watch?.devices ?? []).filter(
    (device) => readGateReason(device.gate_reason) === reason,
  );
}
function subject(
  reason: GateReason,
  count: number,
  watch: CanaryWatch | null | undefined,
) {
  const names = held(watch, reason).map(nameOf);
  return nameList(names, count, "released device");
}
/** The fewest delivery checks any of these devices has had, against the goal. */
function sampleProgress(devices: CanaryWatchDevice[]) {
  const counted = devices.filter((device) => device.samples);
  if (!counted.length) return null;
  const measured = Math.min(...counted.map((d) => d.samples!.measured));
  const needed = Math.max(...counted.map((d) => d.samples!.needed));
  return { measured, needed };
}

export type GateHeadline = {
  title: string;
  detail: string | null;
  /** Reasons to list with their counts: only when more than one applies. */
  listed: GateReason[];
};
// What holds the rollout back, most serious first.
const priority: GateReason[] = [
  "degraded",
  "unavailable",
  "superseded",
  "paused",
  "stale",
  "unverified",
  "measuring",
];

/**
 * One sentence on what the canary gate is waiting for, naming the devices. It
 * reads the same evidence as the stage lanes: a device that has applied is
 * never called unverified, and measuring says how far the measuring is.
 */
export function gateHeadline(
  gate: CanaryGate,
  watch?: CanaryWatch | null,
): GateHeadline {
  const active = gateReasons.filter((reason) => gate.reasons[reason] > 0);
  const listed = active.length > 1 ? active : [];
  if (gate.state === "paused")
    return {
      title: "Rollout paused",
      detail:
        "Resume the rollout to begin a new observation period once the released devices have applied and are delivering.",
      listed,
    };
  if (gate.released_count === 0)
    return {
      title: "Waiting for the first release",
      detail:
        gate.pending_count > 0
          ? `${gate.pending_count} ${gate.pending_count === 1 ? "device is" : "devices are"} waiting for release.`
          : null,
      listed,
    };
  if (gate.state === "observing")
    return {
      title: "Observation in progress",
      detail:
        "Every released device has applied and is delivering. The server keeps checking them before it releases the next stage or completes the rollout.",
      listed,
    };
  const reason = priority.find((key) => gate.reasons[key] > 0);
  if (!reason)
    return {
      title: "Waiting for the next rollout check",
      detail:
        "Every released device has applied. The server starts the observation period at its next check.",
      listed,
    };
  const count = gate.reasons[reason];
  const who = subject(reason, count, watch);
  const many = count > 1;
  const titles: Record<GateReason, string> = {
    degraded: `${who} applied but ${many ? "aren't" : "isn't"} delivering`,
    unavailable: `${who} ${many ? "were" : "was"} revoked or replaced`,
    superseded: `Another assignment is effective on ${who}`,
    paused: `Sync is paused on ${who}`,
    stale: `Waiting for ${who} to check in`,
    unverified: `Waiting for ${who} to apply`,
    measuring: (() => {
      const progress = sampleProgress(held(watch, "measuring"));
      return `Measuring delivery on ${who}${progress ? ` (${progress.measured} of ${progress.needed} samples)` : ""}`;
    })(),
  };
  return { title: titles[reason], detail: gateReasonHelp[reason], listed };
}

/** What one watched device is doing about the gate, for the lane's table. */
export function deviceNote(device: CanaryWatchDevice) {
  const reason = readGateReason(device.gate_reason);
  if (!reason) return null;
  if (reason === "measuring" && device.samples)
    return `${gateReasonLabels.measuring} · ${device.samples.measured} of ${device.samples.needed} samples`;
  return {
    superseded: "Another assignment is effective",
    stale: "Not checking in",
    paused: "Sync paused",
    unverified: "Waiting to apply",
    unavailable: "Revoked or replaced",
    measuring: gateReasonLabels.measuring,
    degraded: "Not delivering",
  }[reason];
}

export type WatchCell = {
  now: string;
  /** The same reading before the release, or null when there is none. */
  before: string | null;
  /** Both, in words, for a screen reader. */
  speech: string;
};
export type WatchRow = {
  id: string;
  name: string;
  note: string | null;
  events: WatchCell;
  errors: WatchCell;
  buffer: WatchCell;
  /** Nothing before the release to compare with (a newly enrolled device). */
  noBaseline: boolean;
  /** Why there is no current reading, when there isn't one. */
  noReading: string | null;
};
const rate = (value: number | null | undefined) =>
  formatRate(typeof value === "number" ? value : null, "");
const fill = (value: number | null | undefined) =>
  typeof value === "number" && value >= 0 && value <= 1
    ? formatPercent(value)
    : "—";
function cell(
  now: string | null,
  before: string | null,
  spoken: (value: string) => string,
): WatchCell {
  return {
    now: now ?? "—",
    before,
    speech: [
      now === null ? "no current reading" : `${spoken(now)} now`,
      before === null ? "no baseline yet" : `${spoken(before)} before release`,
    ].join(", "),
  };
}

/** The canary's delivery now beside the minutes before its release, per device. */
export function watchRows(watch: CanaryWatch | null | undefined): WatchRow[] {
  return (watch?.devices ?? []).map((device) => {
    const now = device.now;
    const base = device.baseline;
    const pair = (a: number | null | undefined, b: number | null | undefined) =>
      `${rate(a)} → ${rate(b)}`;
    return {
      id: device.device_id,
      name: device.device_name || "Unnamed device",
      note: deviceNote(device),
      noBaseline: !base,
      noReading: now
        ? null
        : device.samples
          ? "No recent reading"
          : "Metrics are off",
      events: cell(
        now ? pair(now.events_in_per_second, now.events_out_per_second) : null,
        base
          ? pair(base.events_in_per_second, base.events_out_per_second)
          : null,
        (value) => value.replace(" → ", " in and ") + " out events per second",
      ),
      errors: cell(
        now ? rate(now.errors_per_minute) : null,
        base ? rate(base.errors_per_minute) : null,
        (value) => `${value} errors per minute`,
      ),
      buffer: cell(
        now ? fill(now.buffer_utilization) : null,
        base ? fill(base.buffer_utilization) : null,
        (value) => `buffer ${value} full`,
      ),
    };
  });
}
/** "10 minutes" for the baseline window the server reports. */
export function watchWindow(watch: CanaryWatch) {
  const minutes = Math.max(1, Math.round(watch.window_seconds / 60));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** What "Release next stage now" would release, and what it skips. */
export type EarlyRelease = {
  /** Devices the next stage releases, and how many wait in all. */
  next: number;
  waiting: number;
  /** What is cut short: the delivery check, or the observation period. */
  skipping: "measuring" | "observing";
  /** Who is being measured or observed: "edge-nyc-02". */
  subject: string;
};
/**
 * The next stage may be released early only while the released devices have
 * applied and are delivering, and either the delivery check is still being
 * measured or the observation period is running. The server enforces this
 * again and refuses otherwise.
 */
export function earlyRelease({
  status,
  gate,
  lanes,
  watch,
}: {
  status: string;
  gate: CanaryGate | null;
  lanes: RolloutLane[];
  watch?: CanaryWatch | null;
}): EarlyRelease | null {
  if (status !== "active" || !gate || gate.state === "paused") return null;
  if (gate.released_count === 0) return null;
  const blockers = gateReasons.filter(
    (reason) => reason !== "measuring" && gate.reasons[reason] > 0,
  );
  if (blockers.length) return null;
  const queued = lanes.filter((lane) => lane.state === "queued");
  if (!queued.length) return null;
  const measuring = gate.reasons.measuring > 0;
  const released = lanes.filter((lane) => lane.released_at !== null);
  const last = released.at(-1);
  const names = measuring
    ? held(watch, "measuring").map(nameOf)
    : (last?.devices ?? []).map(nameOf);
  const total = measuring ? gate.reasons.measuring : (last?.size ?? 0);
  return {
    next: queued[0].size,
    waiting: queued.reduce((sum, lane) => sum + lane.size, 0),
    skipping: measuring ? "measuring" : "observing",
    subject:
      nameList(names, total, "released device") || "the released devices",
  };
}
