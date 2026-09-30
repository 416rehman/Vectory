import type {
  AssignmentDescription,
  DeploymentPreview,
  Device,
  Policy,
  PreviewReplacement,
} from "./api";
import { countLabel } from "./countLabel";
import { interval } from "./deploymentStatus";
import { relativeTime } from "./time";

/** What the dialog asks for, in the words the review uses. */
export type RequestedChange =
  | {
      kind: "configuration";
      configurationId: string | null;
      pipeline: string | null;
      number: number | null;
    }
  | { kind: "policy"; policy: Policy; name: string | null };

export function devicesText(count: number) {
  return countLabel(count, "device");
}

/** "Web access logs v3", or "version 3" when the pipeline name is unknown. */
export function requestedName(change: RequestedChange) {
  if (change.kind === "policy")
    return change.name ? `“${change.name}” settings` : "these settings";
  if (change.pipeline)
    return change.number
      ? `${change.pipeline} v${change.number}`
      : change.pipeline;
  return change.number ? `version ${change.number}` : "this version";
}

/** A short, human name for an existing assignment. */
export function assignmentName(
  assignment: AssignmentDescription | null | undefined,
) {
  if (!assignment) return "another assignment";
  if (assignment.resource === "policy") {
    if (assignment.policy_name) return `“${assignment.policy_name}” settings`;
    if (assignment.name) return assignment.name;
    return assignment.policy
      ? `Agent settings (${assignment.policy.sync_paused ? "sync paused" : "sync on"}, ${interval(assignment.policy.heartbeat_seconds)} check-ins)`
      : "Agent settings";
  }
  const pipeline =
    assignment.configuration_name || assignment.name || "Another pipeline";
  return assignment.version_number
    ? `${pipeline} v${assignment.version_number}`
    : pipeline;
}

/**
 * What a device runs now: its last verified managed version, its own local
 * config, or nothing at all. Within the pipeline being deployed, the version
 * number alone is clearest.
 */
export function runningName(
  device: Pick<Device, "running_version"> & { actual_sha256?: string | null },
  configurationId?: string | null,
) {
  const running = device.running_version;
  if (!running)
    return device.actual_sha256 ? "Its local config" : "Nothing running yet";
  if (
    configurationId &&
    running.configuration_id === configurationId &&
    running.number
  )
    return `v${running.number}`;
  const pipeline = running.configuration_name || "Unknown pipeline";
  return running.number ? `${pipeline} v${running.number}` : pipeline;
}
/** An assignment's name, shortened to its version inside the same pipeline. */
export function shortAssignmentName(
  assignment: AssignmentDescription,
  configurationId?: string | null,
) {
  if (
    configurationId &&
    assignment.resource === "configuration" &&
    assignment.configuration_id === configurationId &&
    assignment.version_number
  )
    return `v${assignment.version_number}`;
  return assignmentName(assignment);
}

export function policySummary(policy: Policy | null | undefined) {
  if (!policy) return "Settings not reported";
  return [
    policy.sync_paused ? "Sync paused" : "Sync on",
    `check-ins every ${interval(policy.heartbeat_seconds)}`,
    policy.telemetry_enabled ? null : "metrics off",
  ]
    .filter(Boolean)
    .join(" · ");
}

function samePipeline(
  replacement: PreviewReplacement,
  change: RequestedChange,
) {
  return (
    change.kind === "configuration" &&
    !!change.configurationId &&
    replacement.assignment.configuration_id === change.configurationId
  );
}

/** "Web access logs v2 → v3 on 3 devices" for one replaced assignment. */
export function replacementLine(
  replacement: PreviewReplacement,
  change: RequestedChange,
) {
  const devices = devicesText(replacement.device_ids.length);
  if (samePipeline(replacement, change) && change.kind === "configuration") {
    const pipeline =
      replacement.assignment.configuration_name ||
      change.pipeline ||
      "This pipeline";
    const from = replacement.assignment.version_number
      ? `v${replacement.assignment.version_number}`
      : "the current version";
    const to = change.number ? `v${change.number}` : "this version";
    return `${pipeline} ${from} → ${to} on ${devices}`;
  }
  return `${assignmentName(replacement.assignment)} with ${requestedName(change)} on ${devices}`;
}

/** The pipeline name when the caller didn't pass one: a replaced version of it knows. */
export function inferPipelineName(
  preview: Pick<
    DeploymentPreview,
    "replacements" | "suggested_replaces"
  > | null,
  configurationId: string | null,
) {
  if (!preview || !configurationId) return null;
  for (const entry of [
    ...(preview.replacements || []),
    ...(preview.suggested_replaces || []),
  ])
    if (
      entry.assignment.configuration_id === configurationId &&
      entry.assignment.configuration_name
    )
      return entry.assignment.configuration_name;
  return null;
}

/** One sentence for the top of the review. */
export function reviewHeadline(
  preview: Pick<DeploymentPreview, "replacements">,
  change: RequestedChange,
  deviceCount: number,
) {
  const replacements = preview.replacements || [];
  const covered = new Set(replacements.flatMap((r) => r.device_ids));
  const devices = devicesText(deviceCount);
  if (change.kind === "policy") {
    if (change.name) return `Apply “${change.name}” settings to ${devices}`;
    if (change.policy.sync_paused) return `Pause sync on ${devices}`;
    if (replacements.some((r) => r.assignment.policy?.sync_paused))
      return `Resume sync on ${devices}`;
    return `Apply these settings to ${devices}`;
  }
  if (replacements.length === 1 && covered.size === deviceCount)
    return `Replace ${replacementLine(replacements[0], change)}`;
  return `Deploy ${requestedName(change)} to ${devices}`;
}

/** "Applied by Ada, 2 h ago · priority 100" for an existing assignment. */
export function assignmentMeta(
  assignment: Pick<
    AssignmentDescription,
    "priority" | "created_at" | "created_by_name"
  >,
  now = Date.now(),
) {
  const ago = assignment.created_at
    ? relativeTime(assignment.created_at, now)
    : null;
  const who = assignment.created_by_name
    ? `Applied by ${assignment.created_by_name}${ago ? `, ${ago}` : ""}`
    : ago
      ? `Applied ${ago}`
      : null;
  return [who, `priority ${assignment.priority}`].filter(Boolean).join(" · ");
}

/** Where an assignment came from, in plain words: what, who, when and priority. */
export function assignmentSource(
  assignment: Pick<
    AssignmentDescription,
    "priority" | "created_at" | "created_by_name"
  > & { label: string },
  now = Date.now(),
) {
  const ago = assignment.created_at
    ? relativeTime(assignment.created_at, now)
    : null;
  return [
    assignment.label,
    assignment.created_by_name
      ? `applied by ${assignment.created_by_name}`
      : null,
    ago,
  ]
    .filter(Boolean)
    .join(", ")
    .concat(` · priority ${assignment.priority}`);
}

/** Why a device is paused and who paused it, for the pause and deploy reviews. */
export function pauseSource(
  device: Pick<Device, "local_paused" | "sync_paused" | "policy_assignment">,
  now = Date.now(),
) {
  if (device.local_paused)
    return "Paused on the device itself. Only someone on that host can resume it.";
  if (!device.sync_paused) return null;
  const assignment = device.policy_assignment;
  if (!assignment) return "Paused by agent settings.";
  return `Paused by ${assignmentSource(
    {
      label: assignment.policy_name
        ? `“${assignment.policy_name}” settings`
        : assignment.name || "an agent settings assignment",
      priority: assignment.priority,
      created_at: assignment.created_at ?? null,
      created_by_name: assignment.created_by_name ?? null,
    },
    now,
  )}.`;
}

export type ConflictRow = {
  device_id: string;
  device_name: string;
  kind: "conflict" | "higher_priority";
  /** The assignments that keep this device from taking the request. */
  assignments: AssignmentDescription[];
  priority: number | null;
  /** What the device follows today, which may outrank the conflict. */
  winner: AssignmentDescription | null;
  /** Other assignments still bound to it at the request's priority. */
  alsoBound: AssignmentDescription[];
  /** Every assignment, at any tier, one replace must cover for this device. */
  replace: string[];
};

/**
 * Devices where the request would not win, with the assignment in the way.
 * Equal priority with a different payload is a conflict; a higher priority
 * wins. The current winner is the one the device follows today (a rollback
 * one priority up, say), not the equal-priority assignment it conflicts with.
 */
export function conflictRows(
  preview: Pick<DeploymentPreview, "outcomes" | "conflicts" | "devices"> &
    Partial<Pick<DeploymentPreview, "replacements_needed">>,
  resource: "configuration" | "policy",
): ConflictRow[] {
  const needed = (deviceId: string, fallback: AssignmentDescription[]) => {
    const ids = (preview.replacements_needed || [])
      .filter((entry) => entry.device_ids.includes(deviceId))
      .map((entry) => entry.assignment.id);
    return [...new Set(ids.length ? ids : fallback.map((a) => a.id))];
  };
  const names = new Map(
    preview.devices.map((device) => [device.id, device.name]),
  );
  const rows: ConflictRow[] = [];
  for (const outcome of preview.outcomes || []) {
    if (outcome.resource !== resource) continue;
    if (outcome.outcome === "conflict") {
      const issues = preview.conflicts.filter(
        (issue) =>
          issue.device_id === outcome.device_id && issue.resource === resource,
      );
      const assignments = new Map<string, AssignmentDescription>();
      for (const issue of issues)
        for (const described of issue.assignments || [])
          assignments.set(described.id, described);
      const bound = [...assignments.values()];
      const winner = outcome.winner || bound[0] || null;
      rows.push({
        device_id: outcome.device_id,
        device_name: names.get(outcome.device_id) || outcome.device_id,
        kind: "conflict",
        assignments: bound,
        priority: issues[0]?.priority ?? null,
        winner,
        alsoBound: bound.filter((a) => a.id !== winner?.id),
        replace: needed(outcome.device_id, winner ? [winner, ...bound] : bound),
      });
    } else if (outcome.outcome === "higher_priority" && outcome.assignment) {
      const described: AssignmentDescription =
        outcome.winner && outcome.winner.id === outcome.assignment.id
          ? outcome.winner
          : {
              id: outcome.assignment.id,
              name: outcome.assignment.name ?? null,
              resource,
              priority: outcome.assignment.priority,
              target_mode: outcome.assignment.target_mode || "snapshot",
              status: outcome.assignment.status || "active",
              created_at: null,
              version_id: null,
              version_number: null,
              configuration_id: null,
              configuration_name: null,
              policy: null,
              policy_id: null,
              policy_name: null,
            };
      rows.push({
        device_id: outcome.device_id,
        device_name: names.get(outcome.device_id) || outcome.device_id,
        kind: "higher_priority",
        assignments: [described],
        priority: outcome.assignment.priority,
        winner: outcome.winner || described,
        alsoBound: [],
        replace: needed(outcome.device_id, [described]),
      });
    }
  }
  return rows;
}

/** "r15-demo v1 (cancelled)": an assignment with a status worth saying. */
export function boundName(assignment: AssignmentDescription) {
  const status = ["cancelled", "failed", "paused"].includes(assignment.status)
    ? assignment.status
    : null;
  return `${assignment.rollback_of ? "Rollback to " : ""}${assignmentName(assignment)}${status ? ` (${status})` : ""}`;
}

/**
 * What stays behind when some reviewed devices keep their current
 * assignment: "edge-nyc-02 keeps Edge syslog processing v1 (priority 101
 * rollback)". The name is what the device runs today.
 */
export function keptLine(
  device: Pick<Device, "name" | "running_version"> & {
    actual_sha256?: string | null;
  },
  outranking: Pick<AssignmentDescription, "priority" | "rollback_of"> | null,
  resource: "configuration" | "policy" = "configuration",
) {
  const detail = outranking
    ? ` (priority ${outranking.priority}${outranking.rollback_of ? " rollback" : ""})`
    : "";
  const running =
    resource === "policy"
      ? "its current agent settings"
      : device.running_version
        ? runningName(device)
        : device.actual_sha256
          ? "its local config"
          : "what it runs now";
  return `${device.name} keeps ${running}${detail}`;
}

/** Local datetime-input value for a timestamp. */
export function localInputValue(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
/** "in 2 h 5 min", "in 45 min", "in less than a minute", or null if past. */
export function startsIn(value: string, now = Date.now()) {
  const at = new Date(value).valueOf();
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - now) / 60000);
  if (at <= now) return null;
  if (minutes < 1) return "in less than a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `in ${Math.round(hours / 24)} days`;
}

/** Technical details a support request needs, never secrets or variable values. */
export function technicalDetails(
  request: Record<string, unknown>,
  preview: Pick<
    DeploymentPreview,
    "conflicts" | "outcomes" | "replacements" | "warnings"
  >,
) {
  const { variable_bindings: _values, ...rest } = request;
  return JSON.stringify(
    {
      request: rest,
      conflicts: preview.conflicts,
      replacements: preview.replacements,
      outcomes: preview.outcomes?.filter((o) => o.outcome !== "requested"),
      warnings: preview.warnings,
    },
    null,
    2,
  );
}

/** How a deployment is released, as chosen on the first step. */
export type ReleaseSettings = {
  strategy: "all" | "canary" | "scheduled";
  /** The release style once a schedule starts. */
  scheduledKind: "all" | "canary";
  canary: number;
  batch: number;
  observe: number;
  /** The rollout stops once more than this many released devices fail. */
  threshold: number;
  /** Local date and time from a datetime-local input. */
  schedule: string;
};
export const defaultRelease: ReleaseSettings = {
  strategy: "all",
  scheduledKind: "all",
  canary: 1,
  batch: 10,
  observe: 60,
  threshold: 0,
  schedule: "",
};
export function usesCanary(release: ReleaseSettings) {
  return (
    release.strategy === "canary" ||
    (release.strategy === "scheduled" && release.scheduledKind === "canary")
  );
}
const whole = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;
export type ReleaseErrors = Partial<
  Record<"canary" | "batch" | "observe" | "threshold" | "schedule", string>
>;
/** Field errors that keep the request from being reviewed. */
export function releaseErrors(release: ReleaseSettings, now = Date.now()) {
  const errors: ReleaseErrors = {};
  if (usesCanary(release)) {
    if (!whole(release.canary, 1, 10000))
      errors.canary = "Enter 1 to 10,000 devices.";
    if (!whole(release.batch, 1, 10000))
      errors.batch = "Enter 1 to 10,000 devices.";
    if (!whole(release.observe, 0, 86400))
      errors.observe = "Enter 0 to 86,400 seconds.";
    if (!whole(release.threshold, 0, 10000))
      errors.threshold = "Enter 0 to 10,000 devices.";
  }
  if (release.strategy === "scheduled") {
    const at = new Date(release.schedule).valueOf();
    if (!release.schedule || Number.isNaN(at))
      errors.schedule = "Choose a start date and time.";
    else if (at < now + 60000)
      errors.schedule = "Choose a time at least a minute from now.";
  }
  return errors;
}
/**
 * The rollout object the server expects. `canaryDevices` names the devices to
 * release first; none leaves the choice to the server.
 */
export function rolloutFor(
  release: ReleaseSettings,
  canaryDevices: string[] = [],
) {
  const canary = usesCanary(release);
  return {
    kind: canary ? "canary" : "all",
    canary_size: canary ? release.canary : 1,
    batch_size: canary ? release.batch : 10,
    observation_seconds: canary ? release.observe : 60,
    failure_threshold: canary ? release.threshold : 0,
    ...(canary && canaryDevices.length
      ? { canary_device_ids: canaryDevices }
      : {}),
  };
}
/** ISO time for a scheduled release, or null. */
export function scheduledAt(release: ReleaseSettings) {
  if (release.strategy !== "scheduled" || !release.schedule) return null;
  const at = new Date(release.schedule);
  return Number.isNaN(at.valueOf()) ? null : at.toISOString();
}
