/**
 * One status language for the whole dashboard.
 *
 * Every backend state has exactly one entry per domain: a short label, a tone,
 * an icon name and a one-line description. Tables, cards, activity rows and
 * search results all read from here, so the same state never has two names.
 */
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";
export type StatusIcon =
  | "check"
  | "progress"
  | "clock"
  | "pause"
  | "minus"
  | "offline"
  | "online"
  | "x"
  | "undo"
  | "question"
  | "ban"
  | "alert"
  | "calendar"
  | "calendar-x"
  | "eye"
  | "repeat"
  | "plus"
  | "dot";
export type StatusEntry = {
  label: string;
  tone: StatusTone;
  icon: StatusIcon;
  description: string;
};
export type StatusDomain =
  | "device"
  | "connection"
  | "apply"
  | "deployment"
  | "target"
  | "issue"
  | "audit"
  | "gate"
  | "stage"
  | "telemetry";

const entry = (
  label: string,
  tone: StatusTone,
  icon: StatusIcon,
  description: string,
): StatusEntry => ({ label, tone, icon, description });

/** Apply progress reported by agents (heartbeat `apply_state`, attempt state). */
export const applyStates = {
  unmanaged: entry(
    "No pipeline",
    "neutral",
    "minus",
    "No pipeline is assigned. The device keeps running its local configuration.",
  ),
  desired: entry(
    "Waiting for agent",
    "info",
    "clock",
    "Released. The agent picks it up at its next check-in.",
  ),
  downloaded: entry(
    "Downloaded",
    "info",
    "progress",
    "The agent downloaded the version and is checking it.",
  ),
  validated: entry(
    "Validated",
    "info",
    "progress",
    "Vector accepted the configuration. The agent is applying it.",
  ),
  written: entry(
    "Applying",
    "info",
    "progress",
    "The configuration is written. Vector is about to load it.",
  ),
  reload_requested: entry(
    "Restarting Vector",
    "info",
    "progress",
    "Vector is restarting with the new configuration.",
  ),
  verified_applied: entry(
    "Applied",
    "success",
    "check",
    "Vector is running this version. The agent verified it.",
  ),
  verification_unknown: entry(
    "Check required",
    "warning",
    "question",
    "Applied, but the agent couldn't confirm that Vector is running it.",
  ),
  failed: entry(
    "Failed",
    "danger",
    "x",
    "The version was rejected or couldn't be applied.",
  ),
  rolled_back: entry(
    "Rolled back",
    "danger",
    "undo",
    "The new version failed. The agent restored the last working version.",
  ),
  paused: entry(
    "Sync paused",
    "neutral",
    "pause",
    "Configuration changes wait until sync resumes.",
  ),
} satisfies Record<string, StatusEntry>;
export type ApplyState = keyof typeof applyStates;

/**
 * The apply pipeline as completed steps, for the device page's progress and
 * the rollout timeline. The last step reads like the state it reaches.
 */
export const applyStepLabels = {
  released: "Released",
  downloaded: applyStates.downloaded.label,
  validated: applyStates.validated.label,
  written: "Written",
  reloaded: "Vector reloaded",
  applied: applyStates.verified_applied.label,
} as const;

/** The device's single effective state, computed by the server. */
export const deviceStatuses = {
  verified: applyStates.verified_applied,
  degraded: entry(
    "Degraded",
    "warning",
    "alert",
    "Applied, but not delivering. An open delivery issue says why.",
  ),
  applying: entry(
    "Updating",
    "info",
    "progress",
    "A new version is on its way to this device.",
  ),
  failed: applyStates.failed,
  rolled_back: applyStates.rolled_back,
  verification_unknown: applyStates.verification_unknown,
  paused: applyStates.paused,
  pause_requested: entry(
    "Pause requested",
    "info",
    "clock",
    "Sync pauses when the agent acknowledges it at its next check-in.",
  ),
  unmanaged: applyStates.unmanaged,
  offline: entry(
    "Offline",
    "warning",
    "offline",
    "No check-in for three heartbeat intervals.",
  ),
  revoked: entry(
    "Revoked",
    "neutral",
    "ban",
    "This device identity can no longer connect.",
  ),
  awaiting_first_check_in: entry(
    "Waiting for first check-in",
    "neutral",
    "clock",
    "Enrolled, but no check-in has arrived yet.",
  ),
  conflict: entry(
    "Conflict",
    "danger",
    "alert",
    "Assignments with equal priority request different versions.",
  ),
} satisfies Record<string, StatusEntry>;
export type DeviceStatus = keyof typeof deviceStatuses;

export const connectionStates = {
  online: entry("Online", "success", "online", "Checked in recently."),
  offline: deviceStatuses.offline,
  revoked: deviceStatuses.revoked,
  never: entry(
    "Never connected",
    "neutral",
    "clock",
    "Enrolled, but no check-in has arrived yet.",
  ),
} satisfies Record<string, StatusEntry>;
export type ConnectionState = keyof typeof connectionStates;

export const deploymentStatuses = {
  scheduled: entry(
    "Scheduled",
    "info",
    "calendar",
    "Starts at its scheduled time.",
  ),
  active: entry(
    "In progress",
    "info",
    "progress",
    "Releasing to devices and waiting for them to apply.",
  ),
  paused: entry(
    "Paused",
    "warning",
    "pause",
    "No new devices are released until the rollout resumes.",
  ),
  completed: entry(
    "Completed",
    "success",
    "check",
    "Every targeted device received this version.",
  ),
  cancelled: entry(
    "Cancelled",
    "neutral",
    "x",
    "No further devices are released. Released devices keep the version.",
  ),
  failed: entry(
    "Failed",
    "danger",
    "x",
    "Failures reached the rollout's threshold.",
  ),
  missed: entry(
    "Schedule missed",
    "warning",
    "calendar-x",
    "The server was unavailable past the start deadline.",
  ),
  unassigned: entry(
    "Removed",
    "neutral",
    "minus",
    "The assignment was removed. Devices fall back to their next assignment.",
  ),
  // Display states derived from a deployment's lineage, not stored statuses.
  recovered: entry(
    "Recovered",
    "success",
    "check",
    "The rollout stopped after a failure, but every device has verified since.",
  ),
  rolled_back: entry(
    "Rolled back",
    "warning",
    "undo",
    "A rollback returned its devices to an earlier version.",
  ),
  replaced: entry(
    "Replaced",
    "neutral",
    "minus",
    "A newer deployment took over its devices.",
  ),
} satisfies Record<string, StatusEntry>;
export type DeploymentStatus = keyof typeof deploymentStatuses;

/** Per-device progress inside one deployment. */
export const targetStates = {
  pending: entry("Queued", "neutral", "clock", "Waits for its rollout stage."),
  // A pending device in a rollout that stopped before its stage.
  not_released: entry(
    "Not released",
    "neutral",
    "minus",
    "The rollout stopped before this device's stage.",
  ),
  ...applyStates,
  incompatible: entry(
    "Incompatible",
    "danger",
    "ban",
    "The device can't run this version.",
  ),
  blocked: entry(
    "Blocked",
    "warning",
    "alert",
    "An active canary blocked the scheduled start.",
  ),
  // Verified on the version, but an open delivery issue says it isn't delivering.
  degraded: entry(
    "Not delivering",
    "warning",
    "alert",
    "Applied, but the device isn't delivering. An open delivery issue says why.",
  ),
  removed: entry(
    "No longer targeted",
    "neutral",
    "minus",
    "The device left the target set.",
  ),
  replaced: entry(
    "Replaced",
    "neutral",
    "minus",
    "A newer deployment took over this device.",
  ),
  revoked: deviceStatuses.revoked,
} satisfies Record<string, StatusEntry>;
export type TargetState = keyof typeof targetStates;

export const issueDispositions = {
  open: entry("Open", "warning", "alert", "Reported and not yet resolved."),
  acknowledged: entry(
    "Acknowledged",
    "neutral",
    "eye",
    "Someone is aware of it. It stays until the device recovers.",
  ),
  resolved: entry(
    "Resolved",
    "success",
    "check",
    "The device verified a working version.",
  ),
} satisfies Record<string, StatusEntry>;
export type IssueDisposition = keyof typeof issueDispositions;

/** Delivery problems the server finds in telemetry (`DATA_PLANE_*` issues). */
export const dataPlaneCodes = [
  "DATA_PLANE_STALLED",
  "DATA_PLANE_SINK_ERRORS",
  "DATA_PLANE_BUFFER_FULL",
  "DATA_PLANE_ERROR_DROPS",
] as const;
export const isDataPlaneCode = (code: string | null | undefined) =>
  (dataPlaneCodes as readonly string[]).includes(code ?? "");

/** Audit outcomes, including device apply transitions recorded in the audit. */
export const auditOutcomes = {
  success: entry("Succeeded", "success", "check", "The action completed."),
  failure: entry("Failed", "danger", "x", "The request failed."),
  failed: entry("Failed", "danger", "x", "The action failed."),
  denied: entry("Denied", "danger", "ban", "The request was not permitted."),
  throttled: entry(
    "Throttled",
    "warning",
    "clock",
    "Too many attempts. The request was refused for a while.",
  ),
  conflict: entry(
    "Conflict",
    "warning",
    "alert",
    "The request conflicted with the current state.",
  ),
  missed: entry(
    "Missed",
    "warning",
    "calendar-x",
    "The scheduled time passed.",
  ),
  prepared: entry("Prepared", "neutral", "clock", "Prepared for a next step."),
  full: entry(
    "Full capabilities",
    "neutral",
    "dot",
    "The device accepts any Vector configuration.",
  ),
  restricted: entry(
    "Restricted capabilities",
    "neutral",
    "dot",
    "The device accepts only its allowed components and resources.",
  ),
  unmanaged: applyStates.unmanaged,
  desired: applyStates.desired,
  downloaded: applyStates.downloaded,
  validated: applyStates.validated,
  written: applyStates.written,
  reload_requested: applyStates.reload_requested,
  verified_applied: applyStates.verified_applied,
  verification_unknown: applyStates.verification_unknown,
  rolled_back: applyStates.rolled_back,
  incompatible: targetStates.incompatible,
  paused: applyStates.paused,
} satisfies Record<string, StatusEntry>;
export type AuditOutcome = keyof typeof auditOutcomes;

export const gateStates = {
  waiting: entry(
    "Waiting to observe",
    "info",
    "clock",
    "Waiting for canary devices to report a verified version.",
  ),
  observing: entry(
    "Observing",
    "info",
    "eye",
    "Watching canary devices before releasing the next batch.",
  ),
  paused: deploymentStatuses.paused,
} satisfies Record<string, StatusEntry>;

/** One release stage (canary, batch) of a rollout. */
export const stageStates = {
  verified: entry(
    "Applied",
    "success",
    "check",
    "Every device in this stage applied the version.",
  ),
  in_progress: entry(
    "Rolling out",
    "info",
    "progress",
    "Devices in this stage are applying the version.",
  ),
  failed: entry(
    "Failed",
    "danger",
    "x",
    "Devices in this stage failed to apply the version.",
  ),
  queued: targetStates.pending,
  stopped: targetStates.not_released,
} satisfies Record<string, StatusEntry>;

export const telemetryStates = {
  reporting: entry(
    "Reporting",
    "success",
    "online",
    "Sent metrics in the last three minutes.",
  ),
  stale: entry(
    "Stale",
    "warning",
    "clock",
    "The last metrics sample is more than three minutes old.",
  ),
  none: entry(
    "No telemetry",
    "neutral",
    "minus",
    "This device hasn't reported metrics.",
  ),
} satisfies Record<string, StatusEntry>;

export const statusDomains: Record<
  StatusDomain,
  Record<string, StatusEntry>
> = {
  device: deviceStatuses,
  connection: connectionStates,
  apply: applyStates,
  deployment: deploymentStatuses,
  target: targetStates,
  issue: issueDispositions,
  audit: auditOutcomes,
  gate: gateStates,
  stage: stageStates,
  telemetry: telemetryStates,
};

export function humanizeState(value: string) {
  const text = value.replaceAll("_", " ").replaceAll(".", " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Unknown";
}

/** A known entry, or a neutral humanized fallback for a state added later. */
export function statusOf(domain: StatusDomain, value: string): StatusEntry {
  const known = Object.hasOwn(statusDomains[domain], value)
    ? statusDomains[domain][value]
    : undefined;
  return known ?? entry(humanizeState(value), "neutral", "dot", "");
}

export const statusLabel = (domain: StatusDomain, value: string) =>
  statusOf(domain, value).label;

/** One open delivery problem, as the server summarizes it on the device. */
export type DataPlaneIssue = {
  issue_id?: string | null;
  code: string;
  component_id?: string | null;
  component_kind?: string | null;
  title: string;
  message?: string | null;
  hint?: string | null;
  since?: string | null;
};
/** The server's data-plane summary for the version the device runs. */
export type DataPlaneSummary = {
  version_id: string | null;
  evaluations?: number | null;
  evaluated_at?: string | null;
  issues: DataPlaneIssue[];
};

/** Minimal device fields the display state depends on. */
export type DeviceStatusInput = {
  status: string;
  sync_paused?: boolean;
  local_paused?: boolean;
  pause_acknowledged?: boolean;
  last_seen?: string | null;
  desired_version_id?: string | null;
  data_plane?: DataPlaneSummary | null;
};

/**
 * Open delivery problems of a device that verifiably runs the version they
 * were measured on. Apply state stays separate: the device is still applied.
 */
export function dataPlaneIssues(device: DeviceStatusInput): DataPlaneIssue[] {
  const summary = device.data_plane;
  if (
    device.status !== "verified" ||
    !summary?.version_id ||
    summary.version_id !== device.desired_version_id ||
    !Array.isArray(summary.issues)
  )
    return [];
  return summary.issues.filter(
    (issue) => issue && typeof issue.title === "string",
  );
}

/**
 * The state to show for a device. A dashboard pause reads "Pause requested"
 * until the agent acknowledges it; a host-local pause is always in effect. An
 * applied device that isn't delivering reads "Degraded".
 */
export function deviceDisplayStatus(device: DeviceStatusInput): string {
  if (dataPlaneIssues(device).length) return "degraded";
  if (
    device.status === "paused" &&
    !device.local_paused &&
    device.sync_paused &&
    !device.pause_acknowledged
  )
    return "pause_requested";
  return device.status;
}

export function connectionState(device: DeviceStatusInput): ConnectionState {
  if (device.status === "revoked") return "revoked";
  if (!device.last_seen) return "never";
  return device.status === "offline" ? "offline" : "online";
}
