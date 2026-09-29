import type { DeploymentSummary, DeploymentTarget } from "./api";

/** One vocabulary for rollout outcomes and target progress on every deployment view. */
export type StatusTone = "success" | "danger" | "warning" | "info" | "neutral";

export const lifecycleLabels: Record<string, string> = {
  scheduled: "Scheduled",
  active: "In progress",
  paused: "Paused",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
  missed: "Schedule missed",
  unassigned: "Removed",
};
const lifecycleTones: Record<string, StatusTone> = {
  scheduled: "info",
  active: "info",
  paused: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  missed: "danger",
  unassigned: "neutral",
};

/** Filter options for deployment history, in reading order. */
export const statusFilters: { value: string; label: string }[] = [
  { value: "active", label: "In progress" },
  { value: "paused", label: "Paused" },
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Complete" },
  { value: "failed", label: "Failed" },
  { value: "rolled_back", label: "Rolled back" },
  { value: "cancelled", label: "Cancelled" },
  { value: "unassigned", label: "Removed" },
  { value: "missed", label: "Schedule missed" },
];

export type DeploymentDisplay = {
  /** The rollout's own outcome, never rewritten by later assignment changes. */
  label: string;
  tone: StatusTone;
  /** What happened to the assignment afterwards, if anything. */
  note: string | null;
};

type Lineage = Pick<
  DeploymentSummary,
  | "status"
  | "status_before_removal"
  | "status_before_rollback"
  | "rolled_back_by"
  | "rolled_back_to_version"
  | "replaced_by"
  | "failure_reason"
>;

function version(number: number | null | undefined) {
  return number ? `v${number}` : "another version";
}

export function describeDeployment(d: Lineage): DeploymentDisplay {
  const replaced = d.replaced_by || [];
  const latest = replaced[replaced.length - 1];
  if (d.rolled_back_by) {
    const before = d.status_before_rollback || "";
    return {
      label: "Rolled back",
      tone: "warning",
      note:
        [
          d.rolled_back_to_version
            ? `To ${version(d.rolled_back_to_version)}`
            : null,
          before === "completed"
            ? "after completing"
            : before === "failed"
              ? "after failing"
              : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
    };
  }
  if (d.status === "unassigned") {
    const before = d.status_before_removal || "";
    const base =
      lifecycleLabels[before] && before !== "unassigned" ? before : "";
    return {
      label: latest ? "Replaced" : base ? lifecycleLabels[base] : "Removed",
      tone: latest ? "neutral" : base ? lifecycleTones[base] : "neutral",
      note: latest
        ? `By ${version(latest.version_number)}`
        : base
          ? "Assignment removed"
          : null,
    };
  }
  const note = latest
    ? `Replaced on ${replaced.reduce((sum, entry) => sum + entry.device_count, 0)} ${replaced.reduce((sum, entry) => sum + entry.device_count, 0) === 1 ? "device" : "devices"} by ${version(latest.version_number)}`
    : d.status === "failed" && d.failure_reason === "threshold"
      ? "Stopped after device failures"
      : d.status === "failed" && d.failure_reason === "data_plane"
        ? "Stopped: a device isn't delivering"
        : d.status === "failed" && d.failure_reason === "incompatible"
          ? "A device became incompatible"
          : null;
  return {
    label: lifecycleLabels[d.status] || d.status.replaceAll("_", " "),
    tone: lifecycleTones[d.status] || "neutral",
    note,
  };
}

/** Whether a rollout can still release devices (and is worth polling fast). */
export function isLive(status: string) {
  return status === "active" || status === "paused" || status === "scheduled";
}

const targetLabels: Record<string, string> = {
  verified_applied: "Verified",
  desired: "Waiting for check-in",
  downloaded: "Downloaded",
  validated: "Validated",
  written: "Applying",
  reload_requested: "Restarting Vector",
  verification_unknown: "Needs verification",
  rolled_back: "Rolled back",
  incompatible: "Incompatible",
  failed: "Failed",
  blocked: "Blocked",
  degraded: "Not delivering",
  removed: "No longer targeted",
  revoked: "Revoked",
};
const targetTones: Record<string, StatusTone> = {
  verified_applied: "success",
  desired: "info",
  downloaded: "info",
  validated: "info",
  written: "info",
  reload_requested: "info",
  verification_unknown: "warning",
  rolled_back: "danger",
  incompatible: "danger",
  failed: "danger",
  blocked: "danger",
  degraded: "warning",
  pending: "neutral",
  removed: "neutral",
  revoked: "neutral",
};

/** Label for a device's progress within one rollout. */
export function targetLabel(
  state: string,
  options: { stopped?: boolean; replaced?: boolean } = {},
) {
  if (state === "pending") return options.stopped ? "Not released" : "Queued";
  if (state === "removed" && options.replaced) return "Replaced";
  return targetLabels[state] || state.replaceAll("_", " ");
}
export function targetTone(state: string): StatusTone {
  return targetTones[state] || "neutral";
}
export const targetFilterStates = [
  "verified_applied",
  "desired",
  "downloaded",
  "validated",
  "written",
  "reload_requested",
  "pending",
  "verification_unknown",
  "failed",
  "rolled_back",
  "incompatible",
  "blocked",
  "removed",
];

export type ProgressSegment = {
  key: "verified" | "applying" | "waiting" | "attention" | "failed" | "queued";
  label: string;
  count: number;
};
// Stack order follows progress, with failures at the far end. The order also
// keeps the amber and red marks apart (validated for color-vision deficiency).
const segmentStates: [ProgressSegment["key"], string, string[]][] = [
  ["verified", "Verified", ["verified_applied"]],
  ["attention", "Needs verification", ["verification_unknown"]],
  [
    "applying",
    "Applying",
    ["downloaded", "validated", "written", "reload_requested"],
  ],
  ["waiting", "Waiting for check-in", ["desired"]],
  ["queued", "Not released", ["pending"]],
  // Degraded (applied, not delivering) counts against the failure threshold.
  [
    "failed",
    "Failed",
    ["failed", "rolled_back", "incompatible", "blocked", "degraded"],
  ],
];
/**
 * Stacked progress from persisted target states. Only verified_applied counts
 * as verified; removed rows are history and stay out of the bar.
 */
export function progressSegments(
  counts: Record<string, number>,
  options: { stopped?: boolean } = {},
): ProgressSegment[] {
  const known = new Set(segmentStates.flatMap(([, , states]) => states));
  return segmentStates.map(([key, label, states]) => ({
    key,
    label: key === "queued" && !options.stopped ? "Queued" : label,
    count:
      states.reduce((sum, state) => sum + (counts[state] || 0), 0) +
      (key === "applying"
        ? Object.entries(counts)
            .filter(([state]) => !known.has(state) && state !== "removed")
            .reduce((sum, [, n]) => sum + n, 0)
        : 0),
  }));
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
export function duration(seconds: number) {
  if (seconds < 90) return "about 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ""}`;
}
export function interval(seconds: number) {
  return seconds % 60 === 0 && seconds >= 60
    ? `${seconds / 60} min`
    : `${seconds} s`;
}

export type ReleasePlan = {
  waves: number[];
  sentence: string;
  seconds: number;
};
/**
 * The scheduler releases the canary, then batches, each after every released
 * device verifies and the observation window passes. A wave needs roughly two
 * check-ins: one to pick up the change and one to report verification.
 */
export function releasePlan(options: {
  kind: "all" | "canary";
  devices: number;
  canarySize: number;
  batchSize: number;
  observeSeconds: number;
  checkInSeconds: number;
}): ReleasePlan {
  const devices = Math.max(0, Math.floor(options.devices));
  const check = Math.max(10, options.checkInSeconds || 60);
  const waves: number[] = [];
  if (options.kind === "canary" && devices > 0) {
    const canary = Math.min(devices, Math.max(1, options.canarySize));
    waves.push(canary);
    let rest = devices - canary;
    const batch = Math.max(1, options.batchSize);
    while (rest > 0) {
      waves.push(Math.min(batch, rest));
      rest -= batch;
    }
  } else if (devices > 0) waves.push(devices);
  const observe =
    options.kind === "canary" ? Math.max(0, options.observeSeconds) : 0;
  const seconds = waves.length * (2 * check + observe);
  const cadence = `at ${interval(check)} check-ins`;
  if (!devices) return { waves, sentence: "No devices selected", seconds: 0 };
  if (options.kind !== "canary")
    return {
      waves,
      seconds,
      sentence: `${devices === 1 ? "1 device" : `All ${devices} devices`} at once · ${duration(seconds)} ${cadence}`,
    };
  const [canary, ...batches] = waves;
  const sizes = new Set(batches);
  const batchText = !batches.length
    ? ""
    : sizes.size === 1
      ? ` → ${plural(batches.length, "batch", "batches")} of ${batches[0]}`
      : ` → ${plural(batches.length, "batch", "batches")} of up to ${Math.max(...batches)}`;
  return {
    waves,
    seconds,
    sentence: `${plural(canary, "canary device")}${batchText} · ${duration(seconds)} ${cadence}`,
  };
}

export type TimelineStep = {
  key: "released" | "downloaded" | "validated" | "applied" | "verified";
  label: string;
  at: string | null;
  state: "done" | "current" | "failed" | "waiting";
};
const stepStates: Record<TimelineStep["key"], string[]> = {
  released: [],
  downloaded: ["downloaded"],
  validated: ["validated"],
  applied: ["written", "reload_requested"],
  verified: ["verified_applied"],
};
const stepLabels: Record<TimelineStep["key"], string> = {
  released: "Released",
  downloaded: "Downloaded",
  validated: "Validated",
  applied: "Applied",
  verified: "Verified",
};
/**
 * Released → downloaded → validated → applied → verified for one device, from
 * persisted release/verification times and recorded apply-state changes. A
 * step a check-in skipped is done without a time; nothing is invented.
 */
export function timelineSteps(
  target: Pick<
    DeploymentTarget,
    "state" | "released_at" | "verified_at" | "timeline"
  >,
): TimelineStep[] {
  const keys = Object.keys(stepStates) as TimelineStep["key"][];
  const events = target.timeline || [];
  // A retry starts a new attempt: only read events after the last "desired".
  const restart = events.map((event) => event.state).lastIndexOf("desired");
  const attempt = restart >= 0 ? events.slice(restart) : events;
  const firstAt = (states: string[]) =>
    attempt.find((event) => states.includes(event.state))?.at || null;
  const reached = keys.map((key) =>
    key === "released"
      ? !!target.released_at
      : key === "verified"
        ? target.state === "verified_applied" || !!firstAt(stepStates.verified)
        : !!firstAt(stepStates[key]),
  );
  let last = -1;
  reached.forEach((value, index) => {
    if (value) last = index;
  });
  const failed = ["failed", "rolled_back", "incompatible", "blocked"].includes(
    target.state,
  );
  return keys.map((key, index) => {
    const at =
      key === "released"
        ? target.released_at || null
        : key === "verified"
          ? firstAt(stepStates.verified) ||
            (target.state === "verified_applied"
              ? target.verified_at || null
              : null)
          : firstAt(stepStates[key]);
    const state: TimelineStep["state"] =
      index <= last
        ? "done"
        : index === last + 1
          ? failed
            ? "failed"
            : target.released_at && target.state !== "removed"
              ? "current"
              : "waiting"
          : "waiting";
    return {
      key,
      label: stepLabels[key],
      at: state === "done" ? at : null,
      state,
    };
  });
}

/** "0:21", "3:05", "1:02:03" for a live countdown. */
export function countdown(milliseconds: number) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "Just now", "12 s ago", "4 min ago", "3 h ago", "2 days ago". */
export function since(value: string | null | undefined, now = Date.now()) {
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Plain words for the failure codes agents report; the code stays available. */
const errorExplanations: Record<string, string> = {
  APPLY_ROLLED_BACK:
    "Vector didn't come up healthy with this version, so the agent restored the last working config.",
  ACTIVATION_FAILED: "Vector couldn't start with this version.",
  PROCESS_EXITED: "Vector stopped after switching to this version.",
  PROCESS_STOPPED: "Vector stopped after switching to this version.",
  VALIDATION_FAILED:
    "Vector rejected this configuration when the device checked it.",
  ROLLBACK_FAILED:
    "Vector failed with this version, and the agent couldn't restore the previous config.",
  ROLLBACK_UNAVAILABLE:
    "Vector failed with this version, and there was no earlier config to restore.",
  WRITE_FAILED: "The agent couldn't write the configuration file.",
  DOWNLOAD_FAILED: "The agent couldn't download this version.",
  MANIFEST_EXPIRED:
    "The download expired before the device used it. It tries again on its next check-in.",
  INCOMPATIBLE: "This device's Vector version can't run this pipeline.",
  CAPABILITY_DENIED:
    "This device's local policy doesn't allow something this pipeline uses.",
  DYNAMIC_CAPABILITY_DENIED:
    "This device's local policy doesn't allow something this pipeline uses.",
  UNSUPPORTED_LOCAL_CAPABILITY:
    "This device's local policy doesn't allow something this pipeline uses.",
  NETWORK_DESTINATION_DENIED:
    "The pipeline sends to a destination this device doesn't allow.",
  LISTENER_DENIED:
    "The pipeline listens on an address this device doesn't allow.",
  FILE_ACCESS_DENIED:
    "The pipeline reads or writes a path this device doesn't allow.",
  PATH_UNSAFE: "The pipeline reads or writes a path this device doesn't allow.",
  CONSOLE_TARGET_DENIED: "Console output must go to stderr on this device.",
  TLS_VERIFICATION_REQUIRED:
    "The pipeline turns off TLS verification, which this device doesn't allow.",
  SECRET_RESOLUTION_FAILED:
    "A secret this pipeline uses isn't available on the device.",
  LOCAL_SECRET_REFERENCE_UNAVAILABLE:
    "A secret this pipeline uses isn't available on the device.",
  ADOPTION_REQUIRED:
    "The device must adopt its local config before it can be managed.",
};
/**
 * "APPLY_ROLLED_BACK (rollback)" becomes a sentence, keeping the code for
 * support. Anything unrecognized is shown as reported.
 */
export function explainError(error: string | null | undefined) {
  if (!error) return null;
  const match = /^([A-Z][A-Z0-9_]{2,63})(?: \(([a-z_ -]{1,64})\))?$/.exec(
    error.trim(),
  );
  const code = match?.[1];
  if (code && errorExplanations[code])
    return { summary: errorExplanations[code], code: error.trim() };
  return { summary: error, code: null };
}

/** Second-precision local time for rollout timing, with the date only when not today. */
export function exactTime(value: string | null | undefined, now = new Date()) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
