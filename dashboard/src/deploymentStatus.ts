import type { DeploymentSummary, DeploymentTarget } from "./api";
import { countLabel } from "./countLabel";
import {
  applyStates,
  applyStepLabels,
  deploymentStatuses,
  statusOf,
  targetStates,
  type StatusTone,
} from "./status";

/*
 * Rollout outcomes and target progress for every deployment view. Labels and
 * tones come from status.ts; this module only decides which state applies.
 */

/** The lifecycle statuses the server stores for a deployment. */
export const deploymentLifecycle = [
  "scheduled",
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "missed",
  "unassigned",
] as const;

/** Filter options for deployment history, in reading order. */
export const statusFilters: { value: string; label: string }[] = (
  [
    "active",
    "paused",
    "scheduled",
    "completed",
    "failed",
    "rolled_back",
    "cancelled",
    "unassigned",
    "missed",
  ] as const
).map((value) => ({ value, label: deploymentStatuses[value].label }));

export type DeploymentDisplay = {
  /** The status.ts deployment state this outcome displays as. */
  state: string;
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
> &
  Partial<
    Pick<
      DeploymentSummary,
      | "verified_count"
      | "target_count"
      | "state_counts"
      | "configuration_name"
      | "rolled_back_to_configuration_name"
    >
  >;

/**
 * A lineage link's version as a person reads it: "v3" within the page's own
 * pipeline, "Edge syslog processing v1" when the link crosses to another
 * one (a rollback usually does). Never a bare number from another pipeline.
 */
export function lineageLabel(
  entry: {
    configuration_name?: string | null;
    version_number?: number | null;
  },
  ownPipeline: string | null | undefined,
  fallback = "another version",
) {
  const name = entry.configuration_name || null;
  const number = entry.version_number || null;
  if (name && name !== ownPipeline) return number ? `${name} v${number}` : name;
  return number ? `v${number}` : fallback;
}

export function describeDeployment(d: Lineage): DeploymentDisplay {
  const replaced = d.replaced_by || [];
  const latest = replaced[replaced.length - 1];
  if (d.rolled_back_by) {
    const before = d.status_before_rollback || "";
    return {
      ...display("rolled_back"),
      note:
        [
          d.rolled_back_to_version || d.rolled_back_to_configuration_name
            ? `To ${lineageLabel(
                {
                  configuration_name: d.rolled_back_to_configuration_name,
                  version_number: d.rolled_back_to_version,
                },
                d.configuration_name,
              )}`
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
      Object.hasOwn(deploymentStatuses, before) && before !== "unassigned"
        ? before
        : "";
    return {
      ...display(latest ? "replaced" : base || "unassigned"),
      note: latest
        ? `By ${lineageLabel(latest, d.configuration_name)}`
        : base
          ? "Assignment removed"
          : null,
    };
  }
  // A rollout stops on failure, but its devices can verify afterwards (a
  // retry, or the host fixed). Once every current device is verified, say so
  // instead of contradicting the counts with "Failed".
  const current = (d.target_count ?? 0) - ((d.state_counts || {}).removed ?? 0);
  if (
    d.status === "failed" &&
    !latest &&
    current > 0 &&
    d.verified_count === current
  )
    return {
      ...display("recovered"),
      note: "Stopped after a failure; every device verified since",
    };
  const note = latest
    ? `Replaced on ${replaced.reduce((sum, entry) => sum + entry.device_count, 0)} ${replaced.reduce((sum, entry) => sum + entry.device_count, 0) === 1 ? "device" : "devices"} by ${lineageLabel(latest, d.configuration_name)}`
    : d.status === "failed" && d.failure_reason === "threshold"
      ? "Stopped after device failures"
      : d.status === "failed" && d.failure_reason === "data_plane"
        ? "Stopped: a device isn't delivering"
        : d.status === "failed" && d.failure_reason === "incompatible"
          ? "A device became incompatible"
          : null;
  return { ...display(d.status), note };
}
function display(state: string) {
  const { label, tone } = statusOf("deployment", state);
  return { state, label, tone };
}

/**
 * "2 of 3 applied": how many of the devices a rollout currently follows
 * applied it (the agent verified Vector runs it). One wording for the list,
 * the group view, cards and the rollout page.
 */
export function appliedText(
  d: Pick<
    DeploymentSummary,
    "target_count" | "verified_count" | "state_counts" | "rolled_back_by"
  >,
) {
  const current = d.target_count - (d.state_counts.removed || 0);
  if (!current && d.target_count) return "No devices follow this now";
  if (!current) return "No devices";
  return `${d.verified_count} of ${current} applied${d.rolled_back_by ? ", then rolled back" : ""}`;
}

/** Whether a rollout can still release devices (and is worth polling fast). */
export function isLive(status: string) {
  return status === "active" || status === "paused" || status === "scheduled";
}

/** The status.ts target state for a device's progress within one rollout. */
export function targetState(
  state: string,
  options: { stopped?: boolean; replaced?: boolean } = {},
) {
  if (state === "pending" && options.stopped) return "not_released";
  if (state === "removed" && options.replaced) return "replaced";
  return state;
}
/** Label for a device's progress within one rollout. */
export function targetLabel(
  state: string,
  options: { stopped?: boolean; replaced?: boolean } = {},
) {
  return statusOf("target", targetState(state, options)).label;
}
export function targetTone(state: string): StatusTone {
  return statusOf("target", state).tone;
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
  ["verified", applyStates.verified_applied.label, ["verified_applied"]],
  [
    "attention",
    applyStates.verification_unknown.label,
    ["verification_unknown"],
  ],
  [
    "applying",
    applyStates.written.label,
    ["downloaded", "validated", "written", "reload_requested"],
  ],
  ["waiting", applyStates.desired.label, ["desired"]],
  ["queued", targetStates.not_released.label, ["pending"]],
  // Degraded (applied, not delivering) counts against the failure threshold.
  [
    "failed",
    applyStates.failed.label,
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
    label:
      key === "queued" && !options.stopped ? targetStates.pending.label : label,
    count:
      states.reduce((sum, state) => sum + (counts[state] || 0), 0) +
      (key === "applying"
        ? Object.entries(counts)
            .filter(([state]) => !known.has(state) && state !== "removed")
            .reduce((sum, [, n]) => sum + n, 0)
        : 0),
  }));
}

/**
 * Recorded target counts with devices that verified but aren't delivering
 * moved from verified to degraded (which the failed segment counts), so the
 * bar agrees with the stages and failure groups. Returns how many moved.
 */
export function withDegraded(
  counts: Record<string, number>,
  degraded: number,
): { counts: Record<string, number>; moved: number } {
  const verified = counts.verified_applied || 0;
  const moved = Math.max(0, Math.min(Math.trunc(degraded) || 0, verified));
  if (!moved) return { counts, moved: 0 };
  return {
    counts: {
      ...counts,
      verified_applied: verified - moved,
      degraded: (counts.degraded || 0) + moved,
    },
    moved,
  };
}

/** A rough duration from seconds: "about 12 min". Not time.ts duration (ms). */
export function approxDuration(seconds: number) {
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
      sentence: `${devices === 1 ? "1 device" : `All ${devices} devices`} at once · ${approxDuration(seconds)} ${cadence}`,
    };
  const [canary, ...batches] = waves;
  const sizes = new Set(batches);
  const batchText = !batches.length
    ? ""
    : sizes.size === 1
      ? ` → ${countLabel(batches.length, "batch", "batches")} of ${batches[0]}`
      : ` → ${countLabel(batches.length, "batch", "batches")} of up to ${Math.max(...batches)}`;
  return {
    waves,
    seconds,
    sentence: `${countLabel(canary, "canary device")}${batchText} · ${approxDuration(seconds)} ${cadence}`,
  };
}

/** The apply step an agent's failure stage belongs to. */
export type ApplyStep =
  "downloaded" | "validated" | "written" | "reloaded" | "verified";
/**
 * The six apply steps, one table for the device page and the rollout page:
 * each step's label and the apply state that marks reaching it.
 */
export const applyStepTable: {
  key: "released" | ApplyStep;
  label: string;
  state: string;
}[] = [
  { key: "released", label: applyStepLabels.released, state: "desired" },
  {
    key: "downloaded",
    label: applyStepLabels.downloaded,
    state: "downloaded",
  },
  { key: "validated", label: applyStepLabels.validated, state: "validated" },
  { key: "written", label: applyStepLabels.written, state: "written" },
  {
    key: "reloaded",
    label: applyStepLabels.reloaded,
    state: "reload_requested",
  },
  {
    key: "verified",
    label: applyStepLabels.applied,
    state: "verified_applied",
  },
];
export type TimelineStep = {
  key: (typeof applyStepTable)[number]["key"];
  label: string;
  at: string | null;
  state: "done" | "current" | "failed" | "waiting";
};
const failureStageSteps: Record<string, ApplyStep> = {
  fetch: "downloaded",
  download: "downloaded",
  downloaded: "downloaded",
  verify: "downloaded",
  validation: "validated",
  validate: "validated",
  validated: "validated",
  secrets: "validated",
  credentials: "validated",
  capability: "validated",
  compatibility: "validated",
  preflight: "validated",
  materialization: "validated",
  write: "written",
  written: "written",
  staging: "written",
  commit: "written",
  reload: "reloaded",
  reload_requested: "reloaded",
  startup: "reloaded",
  start: "reloaded",
  rollback: "reloaded",
  recovery: "reloaded",
  observation: "reloaded",
  verification: "verified",
  telemetry: "verified",
};
/**
 * Which apply step failed, from the stage the agent reported ("validation",
 * "rollback", …). The device page and the rollout page both read this, so
 * they never blame different steps. "apply" is the unspecific default and
 * maps to nothing; callers fall back to the device state.
 */
export function failedApplyStep(
  stage: string | null | undefined,
): ApplyStep | null {
  return failureStageSteps[(stage || "").toLowerCase()] ?? null;
}
const stagePhrases: Record<ApplyStep, string> = {
  downloaded: "while downloading",
  validated: "while Vector checked it",
  written: "while writing the config",
  reloaded: "while restarting Vector",
  verified: "while confirming Vector runs it",
};
/** "while restarting Vector" for a reported stage; empty when unknown. */
export function failureStagePhrase(stage: string | null | undefined) {
  const step = failedApplyStep(stage);
  return step ? stagePhrases[step] : "";
}
/**
 * Released → Downloaded → Validated → Written → Loaded in Vector → Applied for
 * one device, from persisted release/verification times and recorded
 * apply-state changes. A step a check-in skipped is done without a time;
 * nothing is invented. A failure is placed at the stage the agent reported
 * (a reload failure marks Loaded in Vector, as the device page does); without
 * one, a rollback means Vector didn't come up after the reload, and anything
 * else falls after the last recorded step.
 */
export function timelineSteps(
  target: Pick<
    DeploymentTarget,
    "state" | "released_at" | "verified_at" | "timeline"
  > & { failure_stage?: string | null },
): TimelineStep[] {
  const keys = applyStepTable.map((step) => step.key);
  const labelOf = (key: TimelineStep["key"]) =>
    applyStepTable.find((step) => step.key === key)!.label;
  // Released is read from the release time, not from a recorded state.
  const statesOf = (key: TimelineStep["key"]) =>
    key === "released"
      ? []
      : [applyStepTable.find((step) => step.key === key)!.state];
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
        ? target.state === "verified_applied" || !!firstAt(statesOf("verified"))
        : !!firstAt(statesOf(key)),
  );
  let last = -1;
  reached.forEach((value, index) => {
    if (value) last = index;
  });
  const failed = ["failed", "rolled_back", "incompatible", "blocked"].includes(
    target.state,
  );
  const reported = failed ? failedApplyStep(target.failure_stage) : null;
  const failedKey: TimelineStep["key"] | null = !failed
    ? null
    : (reported ?? (target.state === "rolled_back" ? "reloaded" : null));
  if (failedKey) {
    const failedAt = keys.indexOf(failedKey);
    return keys.map((key, index) => {
      const at =
        key === "released"
          ? target.released_at || null
          : key === "verified"
            ? null
            : firstAt(statesOf(key));
      const state: TimelineStep["state"] =
        index < failedAt ? "done" : index === failedAt ? "failed" : "waiting";
      return {
        key,
        label: labelOf(key),
        at: state === "done" ? at : null,
        state,
      };
    });
  }
  return keys.map((key, index) => {
    const at =
      key === "released"
        ? target.released_at || null
        : key === "verified"
          ? firstAt(statesOf("verified")) ||
            (target.state === "verified_applied"
              ? target.verified_at || null
              : null)
          : firstAt(statesOf(key));
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
      label: labelOf(key),
      at: state === "done" ? at : null,
      state,
    };
  });
}

/**
 * Agent findings that only a pipeline change can clear: retrying the same
 * version meets the same port in use, VRL error or invalid option. Host
 * problems (a missing directory, a permission) are not among them.
 */
export function pipelineFixable(code: string | null | undefined) {
  if (!code) return false;
  return (
    [
      "ADDRESS_IN_USE",
      "INPUT_NOT_FOUND",
      "EVENT_TYPE_MISMATCH",
      "UNKNOWN_FIELD",
      "UNKNOWN_COMPONENT_TYPE",
      "MISSING_FIELD",
    ].includes(code) ||
    code.startsWith("VRL_") ||
    code.startsWith("INVALID_")
  );
}

// A request to open a rollout's rollback review once its page loads (the
// Overview's Roll back). In memory and short-lived only: a URL can never
// request an action, and the review still needs an explicit confirmation.
let rollbackIntent: { id: string; at: number } | null = null;
export function requestRollbackReview(deploymentId: string, now = Date.now()) {
  rollbackIntent = { id: deploymentId.toLowerCase(), at: now };
}
/** True once, within 30 s, for the rollout the request named. */
export function takeRollbackReview(deploymentId: string, now = Date.now()) {
  const intent = rollbackIntent;
  rollbackIntent = null;
  return (
    !!intent &&
    intent.id === deploymentId.toLowerCase() &&
    now - intent.at >= 0 &&
    now - intent.at < 30_000
  );
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

const sentence = (text: string) =>
  text
    .trim()
    .replace(/[.\s]+$/, "")
    .toLocaleLowerCase();
/**
 * What a failure says, once. The reason is the agent's leading diagnostic
 * when it sent one (the specific cause), otherwise the plain explanation of
 * its error. `effect` keeps a known error code's explanation (what happened
 * on the device) only beside a diagnostic that says something else; `code`
 * is the agent's code, for support.
 */
export function failureText(
  diagnostic: string | null | undefined,
  error: string | null | undefined,
) {
  const explained = explainError(error);
  const cause = diagnostic?.trim() || null;
  return {
    reason: cause || explained?.summary || null,
    effect:
      cause &&
      explained?.code &&
      sentence(explained.summary) !== sentence(cause)
        ? explained.summary
        : null,
    code: explained?.code || null,
  };
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
