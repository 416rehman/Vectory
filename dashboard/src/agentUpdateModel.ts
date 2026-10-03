// Agent updates as the dashboard reads them: the shapes of
// contracts/CONTRACT.md#agent-updates, parsed with Zod, and the plain
// functions that turn them into what the pages say. Every count comes from the
// server; a device that reported nothing is "not reported", never a zero; and a
// staged or downloaded build is never an update.
import { z } from "zod";
import { codeText, rollbackClause, buildName } from "./agentUpdateCodes";
import { shortKeyId } from "./releaseKey";
import { windowsText } from "./updateWindow";
import { statusOf } from "./status";

/* ---------- Shapes ---------- */

const MAX = Number.MAX_SAFE_INTEGER;
const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().max(MAX);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const sha256 = fingerprint;
const text = (limit: number) => z.string().max(limit);
const version = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
const custody = z.enum(["server", "offline"]);

export const targetStateNames = [
  "pending",
  "offered",
  "downloading",
  "staged",
  "waiting_for_host",
  "waiting_for_window",
  "applying",
  "restarted",
  "verified",
  "rolled_back",
  "refused",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type TargetState = (typeof targetStateNames)[number];
const targetState = z.enum(targetStateNames);
const rolloutStatus = z.enum([
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
export type RolloutStatus = z.infer<typeof rolloutStatus>;

export const ReleaseKeySchema = z.object({
  fingerprint,
  public_key: text(200),
  custody,
  state: z.enum(["current", "retired", "revoked"]),
  created_at: instant,
  created_by_name: text(120).nullable(),
  retired_at: instant.nullable(),
  revoked_at: instant.nullable(),
  revoked_reason: text(500).nullable(),
  introduced_by: z
    .object({ statement: z.string(), signature: z.string() })
    .nullable(),
  devices_pinning: count,
  device_names: z.array(text(240)).max(20),
});
export type ReleaseKey = z.infer<typeof ReleaseKeySchema>;
export const ReleaseKeyListSchema = z.array(ReleaseKeySchema).max(64);

const rolloverConflict = z.object({
  from: fingerprint,
  to: z.tuple([fingerprint, fingerprint]),
});
export type RolloverConflict = z.infer<typeof rolloverConflict>;

const FleetSchema = z.object({
  devices_total: count,
  versions: z.array(z.object({ version: text(128), devices: count })).max(50),
  levels: z.object({
    automatic: count,
    ask: count,
    off: count,
    cannot_update: count,
    not_reported: count,
  }),
});
export type Fleet = z.infer<typeof FleetSchema>;

const CatalogEntrySchema = z.object({
  version,
  platforms: z.array(
    z.object({
      os: z.enum(["linux", "darwin", "windows"]),
      arch: z.enum(["amd64", "arm64"]),
    }),
  ),
  devices_behind: count,
  release: z
    .object({
      id: uuid,
      state: z.enum(["awaiting_signature", "ready", "withdrawn"]),
    })
    .nullable(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const AgentUpdatesSchema = z.object({
  enabled: z.boolean(),
  custody: custody.nullable(),
  revision: count,
  current_key: ReleaseKeySchema.nullable(),
  stopped: z
    .object({ reason: text(500), by_name: text(120).nullable(), at: instant })
    .nullable(),
  active_rollouts: count,
  fleet: FleetSchema.nullable(),
  // Hosts frozen on a fork of the rollover chain, listed by newer servers.
  frozen_devices: z
    .object({
      total: count,
      items: z
        .array(
          z.object({
            device_id: uuid,
            device_name: text(240).nullable(),
            rollover_conflict: rolloverConflict,
          }),
        )
        .max(20),
    })
    .nullable()
    .optional(),
  catalog: z.array(CatalogEntrySchema).max(20).nullable(),
});
export type AgentUpdates = z.infer<typeof AgentUpdatesSchema>;

const ReleaseArtifactSchema = z.object({
  os: z.enum(["linux", "darwin", "windows"]),
  arch: z.enum(["amd64", "arm64"]),
  file: text(128),
  size: z.number().int().min(1).max(134217728),
  sha256,
});
export const AgentReleaseSchema = z.object({
  id: uuid,
  version,
  counter: z.number().int().min(1).max(MAX),
  state: z.enum(["awaiting_signature", "ready", "withdrawn"]),
  expired: z.boolean(),
  manifest_sha256: sha256,
  issued_at: instant,
  expires_at: instant,
  signer: z.object({ fingerprint, custody }).nullable(),
  artifacts: z.array(ReleaseArtifactSchema).min(1).max(8),
  prepared_by_name: text(120).nullable(),
  prepared_at: instant,
  withdrawn_at: instant.nullable(),
  withdrawn_reason: text(500).nullable(),
  rollouts: z.array(z.object({ id: uuid, status: rolloutStatus })).max(50),
});
export type AgentRelease = z.infer<typeof AgentReleaseSchema>;
export const AgentReleaseListSchema = z.array(AgentReleaseSchema).max(100);

const SelectorSchema = z.object({
  device_ids: z.array(uuid),
  group_ids: z.array(uuid),
  exclude_ids: z.array(uuid),
});
export const UpdateRolloutSettingsSchema = z.object({
  canary_size: z.number().int().min(1).max(100),
  batch_size: z.number().int().min(1).max(50),
  observation_seconds: z.number().int().min(60).max(86400),
  failure_threshold: z.number().int().min(0).max(100),
  canary_device_ids: z.array(uuid).max(100).optional(),
});
export type UpdateRolloutSettings = z.infer<typeof UpdateRolloutSettingsSchema>;

const releaseRef = z.object({
  id: uuid,
  version,
  counter: z.number().int().min(1).max(MAX),
  manifest_sha256: sha256,
});
const stateCounts = z.object(
  Object.fromEntries(targetStateNames.map((name) => [name, count])) as Record<
    TargetState,
    typeof count
  >,
);
export const UpdateRolloutSchema = z.object({
  id: uuid,
  name: text(120).nullable(),
  release: releaseRef,
  selector: SelectorSchema,
  rollout: UpdateRolloutSettingsSchema,
  status: rolloutStatus,
  failure_reason: z.enum(["threshold", "data_plane"]).nullable(),
  cancel_reason: z
    .enum(["operator", "stop", "key_revoked", "release_withdrawn"])
    .nullable(),
  revision: count,
  created_at: instant,
  created_by_name: text(120).nullable(),
  paused_at: instant.nullable(),
  completed_at: instant.nullable(),
  failed_at: instant.nullable(),
  cancelled_at: instant.nullable(),
  observation_started_at: instant.nullable(),
  target_count: count,
  state_counts: stateCounts,
  degraded: count,
  request_id: uuid.optional(),
});
export type UpdateRollout = z.infer<typeof UpdateRolloutSchema>;
export const UpdateRolloutPageSchema = z.object({
  items: z.array(UpdateRolloutSchema).max(50),
  total: count,
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type UpdateRolloutPage = z.infer<typeof UpdateRolloutPageSchema>;

const StageSchema = z.object({
  kind: z.enum(["canary", "batch"]),
  index: count,
  state: z.enum([
    "queued",
    "in_progress",
    "observing",
    "passed",
    "failed",
    "stopped",
  ]),
  released_at: instant.nullable(),
  size: count,
  counts: z.record(z.string(), count),
  devices: z
    .array(
      z.object({
        device_id: uuid,
        device_name: text(240).nullable(),
        state: targetState,
        code: text(64).nullable(),
      }),
    )
    .max(60),
  more: count,
});
export type UpdateStage = z.infer<typeof StageSchema>;
const FailureSchema = z.object({
  state: z.enum(["rolled_back", "failed", "refused"]),
  code: text(64).nullable(),
  message: text(500).nullable(),
  count,
  device_ids: z.array(uuid).max(1000),
  devices: z
    .array(z.object({ device_id: uuid, device_name: text(240).nullable() }))
    .max(8),
});
export type UpdateFailure = z.infer<typeof FailureSchema>;
export const UpdateRolloutDetailSchema = UpdateRolloutSchema.extend({
  stages: z.array(StageSchema),
  failures: z.array(FailureSchema),
  evaluated_at: instant,
  check_in_seconds: z.number().int().min(10).max(3600).nullable(),
});
export type UpdateRolloutDetail = z.infer<typeof UpdateRolloutDetailSchema>;

export const UpdateTargetSchema = z.object({
  device_id: uuid,
  device_name: text(240).nullable(),
  stage: count.nullable(),
  state: targetState,
  code: text(64).nullable(),
  from_version: text(128).nullable(),
  to_version: version,
  released_at: instant.nullable(),
  updated_at: instant,
  verified_at: instant.nullable(),
});
export type UpdateTarget = z.infer<typeof UpdateTargetSchema>;
export const UpdateTargetPageSchema = z.object({
  items: z.array(UpdateTargetSchema).max(50),
  total: count,
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type UpdateTargetPage = z.infer<typeof UpdateTargetPageSchema>;

const hostWindows = z.array(z.string().min(1).max(40)).max(7);
export const PreviewSchema = z.object({
  release: releaseRef,
  will_update: z
    .array(
      z.object({
        device_id: uuid,
        device_name: text(240).nullable(),
        consent: z.enum(["auto", "ask"]),
        windows: hostWindows,
        next_window_at: instant.nullable(),
      }),
    )
    .max(10000),
  wont_update: z
    .array(
      z.object({
        code: z.string().min(1).max(64),
        reason: text(500),
        fix: text(500).nullable(),
        devices: z
          .array(
            z.object({
              device_id: uuid,
              device_name: text(240).nullable(),
              successors: z.tuple([fingerprint, fingerprint]).nullable(),
            }),
          )
          .max(10000),
      }),
    )
    .max(64),
  warnings: z
    .array(
      z.object({
        code: z.string().min(1).max(64),
        message: text(500),
        devices: z
          .array(
            z.object({ device_id: uuid, device_name: text(240).nullable() }),
          )
          .max(10000),
      }),
    )
    .max(8),
  canary: z.object({
    size: count,
    chosen_by_you: z.boolean(),
    device_ids: z.array(uuid).max(100),
  }),
  review_token: sha256,
});
export type UpdatePreview = z.infer<typeof PreviewSchema>;

const agentCode = z.string().min(1).max(64);
const LastResultSchema = z.object({
  release: sha256,
  outcome: z.enum(["committed", "rolled_back", "failed", "refused"]),
  code: agentCode.nullable(),
  at: z.string(),
  from_version: z.string().min(1).max(128),
  to_version: version.nullable(),
  first_check_in_ms: z.number().int().min(0).max(86400000).optional(),
});
export type LastResult = z.infer<typeof LastResultSchema>;
export const hostStates = [
  "idle",
  "downloading",
  "staged",
  "waiting_for_host",
  "waiting_for_window",
  "applying",
  "trial",
  "refused",
  "failed",
] as const;
export type HostState = (typeof hostStates)[number];
/** The device projection's `agent_update`: the latest report, as the device sent it. */
export const DeviceAgentUpdateSchema = z.object({
  consent: z.enum(["off", "auto", "ask"]),
  paused: z.boolean(),
  track: z.enum(["patch", "minor"]),
  windows: hostWindows,
  window_open: z.boolean(),
  next_window_at: z.string().nullable(),
  keys: z.array(fingerprint).max(4),
  eligibility: z.string().min(1).max(64),
  state: z.enum(hostStates),
  release_version: version.nullable(),
  code: agentCode.nullable(),
  rollover_conflict: rolloverConflict.nullable(),
  last: LastResultSchema.nullable(),
  reported_at: instant,
});
export type DeviceAgentUpdate = z.infer<typeof DeviceAgentUpdateSchema>;

/**
 * The schema every response of an agent update route is parsed with. The reads
 * of one release or one rollout are also bound to the identity in their route
 * (api.ts), so a reply for another record never reaches a page.
 */
export function agentUpdateResponseSchema(
  path: string,
  method: string,
): z.ZodType | undefined {
  if (path === "/agent-updates" && method === "GET") return AgentUpdatesSchema;
  if (
    [
      "/agent-updates/settings",
      "/agent-updates/stop",
      "/agent-updates/stop/clear",
    ].includes(path)
  )
    return AgentUpdatesSchema;
  if (path === "/agent-release-keys" && method === "GET")
    return ReleaseKeyListSchema;
  if (
    path === "/agent-release-keys/rotate" ||
    path === "/agent-release-keys/rollover" ||
    /^\/agent-release-keys\/[a-f0-9]{64}\/revoke$/.test(path)
  )
    return ReleaseKeySchema;
  if (path === "/agent-releases")
    return method === "GET" ? AgentReleaseListSchema : AgentReleaseSchema;
  if (/^\/agent-releases\/[^/]+$/.test(path) && method === "GET")
    return AgentReleaseSchema;
  if (/^\/agent-releases\/[^/]+\/(?:signature|withdraw)$/.test(path))
    return AgentReleaseSchema;
  if (path === "/agent-update-rollouts")
    return method === "GET" ? UpdateRolloutPageSchema : UpdateRolloutSchema;
  if (path === "/agent-update-rollouts/preview") return PreviewSchema;
  if (/^\/agent-update-rollouts\/[^/]+$/.test(path) && method === "GET")
    return UpdateRolloutDetailSchema;
  if (/^\/agent-update-rollouts\/[^/]+\/targets$/.test(path))
    return UpdateTargetPageSchema;
  if (/^\/agent-update-rollouts\/[^/]+\/(?:pause|resume|cancel)$/.test(path))
    return UpdateRolloutSchema;
  return undefined;
}

/* ---------- Counts the fleet reports ---------- */

export type LevelKey = keyof Fleet["levels"];
export const levelLabels: Record<LevelKey, string> = {
  automatic: "Automatic",
  ask: "Ask",
  off: "Off",
  cannot_update: "Can't update",
  not_reported: "Not reported",
};
export const levelHints: Record<LevelKey, string> = {
  automatic: "Installs when an update rollout reaches the device",
  ask: "Stages the build and waits for someone on the host",
  off: "Updates only by hand",
  cannot_update: "Its host can't take agent updates",
  not_reported: "Its agent sent no update report",
};

export type FleetView = {
  total: number;
  versions: { version: string; devices: number; known: boolean }[];
  levels: { key: LevelKey; label: string; devices: number }[];
};
/**
 * The fleet's agent versions and update levels as the server counted them, or
 * null when it didn't (updates are off, or nothing was read): a missing count
 * is never shown as zero. The four ways a host takes updates always show, with
 * the server's own zeros; "Not reported" shows only when some device did.
 */
export function fleetView(fleet: Fleet | null | undefined): FleetView | null {
  if (!fleet) return null;
  const keys: LevelKey[] = ["automatic", "ask", "off", "cannot_update"];
  if (fleet.levels.not_reported > 0) keys.push("not_reported");
  return {
    total: fleet.devices_total,
    versions: fleet.versions.map((entry) => ({
      version: entry.version,
      devices: entry.devices,
      known: entry.version !== "unknown",
    })),
    levels: keys.map((key) => ({
      key,
      label: levelLabels[key],
      devices: fleet.levels[key],
    })),
  };
}

/** The Devices list filtered to a level or an agent version. */
export const levelHref = (key: LevelKey) => `#/devices?agent_update=${key}`;
export const versionHref = (version: string) =>
  `#/devices?agent_version=${encodeURIComponent(version)}`;

export const platformName = (platform: { os: string; arch: string }) =>
  `${platform.os === "darwin" ? "macOS" : platform.os === "windows" ? "Windows" : "Linux"} ${platform.arch}`;

/* ---------- Releases ---------- */

export type ReleaseDisplayState =
  "awaiting_signature" | "ready" | "withdrawn" | "expired";
/** A ready release past its expiry is shown as expired: hosts refuse it. */
export function releaseDisplayState(
  release: Pick<AgentRelease, "state" | "expired">,
): ReleaseDisplayState {
  return release.state === "ready" && release.expired
    ? "expired"
    : release.state;
}
/** Whether an update rollout can start from it now: signed, not expired, not withdrawn. */
export const releaseStartable = (
  release: Pick<AgentRelease, "state" | "expired">,
) => release.state === "ready" && !release.expired;

/**
 * What the catalog row offers: nothing to prepare once a release exists. A
 * release waiting for a signature is the administrator's to sign; a ready one
 * is the operators' to roll out.
 */
export type CatalogAction =
  | { kind: "prepare" }
  | { kind: "sign"; releaseId: string }
  | { kind: "start"; releaseId: string }
  | { kind: "none" };
export function catalogAction(entry: CatalogEntry): CatalogAction {
  const release = entry.release;
  if (!release || release.state === "withdrawn") return { kind: "prepare" };
  return release.state === "awaiting_signature"
    ? { kind: "sign", releaseId: release.id }
    : { kind: "start", releaseId: release.id };
}

/** The exact command that signs a release's manifest on the machine that holds the key. */
export const signCommand =
  "vectory release sign --key team.key --checksums SHA256SUMS release.json";

/* ---------- Rollouts ---------- */

export const isLiveRollout = (status: RolloutStatus) =>
  status === "active" || status === "paused";

/**
 * Segments of the progress bar, in the order of progress with the failures at
 * the far end. Colour never carries a state alone: the legend names each with
 * its count.
 */
export type UpdateSegment = { key: string; label: string; count: number };
const segmentOrder: [string, TargetState | "degraded"][] = [
  ["update-updated", "verified"],
  ["update-trying", "restarted"],
  ["update-applying", "applying"],
  ["update-host", "waiting_for_host"],
  ["update-window", "waiting_for_window"],
  ["update-staged", "staged"],
  ["update-downloading", "downloading"],
  ["update-offered", "offered"],
  ["update-pending", "pending"],
  ["update-refused", "refused"],
  ["update-degraded", "degraded"],
  ["update-rolled-back", "rolled_back"],
  ["update-failed", "failed"],
  ["update-skipped", "skipped"],
  ["update-cancelled", "cancelled"],
];
/**
 * The bar's segments from a rollout's persisted counts. Updated devices on
 * which a delivery issue is open move to "Not delivering", so the bar agrees
 * with the failure threshold that counts them. A rollout that has ended shows
 * what never started as "Not released" rather than "Pending".
 */
export function updateSegments(
  counts: Record<string, number>,
  degraded = 0,
  stopped = false,
): UpdateSegment[] {
  const moved = Math.max(
    0,
    Math.min(Math.trunc(degraded) || 0, counts.verified || 0),
  );
  return segmentOrder.map(([key, state]) => {
    const raw =
      state === "degraded"
        ? moved
        : state === "verified"
          ? (counts.verified || 0) - moved
          : counts[state] || 0;
    const entry = statusOf("updateTarget", state);
    return {
      key,
      label: state === "pending" && stopped ? "Not released" : entry.label,
      count: raw,
    };
  });
}

export type UpdateCounts = {
  /** "12 of 41", set apart in a heading; null when no device is targeted. */
  figure: string | null;
  base: string;
  notes: { key: string; text: string }[];
  sentence: string;
};
/**
 * How many devices updated, in one sentence the list, the rollout page and the
 * Overview share: "12 of 41 devices updated · 1 rolled back". Only devices
 * counted `verified` are updated; devices that haven't started aren't failures.
 */
export function updateCounts(
  rollout: Pick<UpdateRollout, "target_count" | "state_counts" | "degraded">,
): UpdateCounts {
  const counts = rollout.state_counts;
  const total = rollout.target_count;
  if (!total)
    return {
      figure: null,
      base: "No devices",
      notes: [],
      sentence: "No devices",
    };
  const degraded = Math.min(rollout.degraded, counts.verified);
  const updated = counts.verified - degraded;
  const figure = `${updated.toLocaleString()} of ${total.toLocaleString()}`;
  const base = total === 1 ? "device updated" : "devices updated";
  const waiting = counts.waiting_for_host + counts.waiting_for_window;
  const notes = (
    [
      [
        "not_delivering",
        degraded,
        (n: number) => `${n.toLocaleString()} not delivering`,
      ],
      [
        "rolled_back",
        counts.rolled_back,
        (n: number) => `${n.toLocaleString()} rolled back`,
      ],
      ["failed", counts.failed, (n: number) => `${n.toLocaleString()} failed`],
      [
        "refused",
        counts.refused,
        (n: number) => `${n.toLocaleString()} refused`,
      ],
      ["waiting", waiting, (n: number) => `${n.toLocaleString()} waiting`],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([key, n, say]) => ({ key, text: say(n) }));
  return {
    figure,
    base,
    notes,
    sentence: [`${figure} ${base}`, ...notes.map((note) => note.text)].join(
      " · ",
    ),
  };
}

/** The stage's name: the canary, then batches in release order. */
export const stageTitle = (stage: Pick<UpdateStage, "kind" | "index">) =>
  stage.kind === "canary" ? "Canary" : `Batch ${stage.index}`;

/** "Stops on the first failure", "Stops after 3 failures": the threshold in words. */
export function thresholdText(threshold: number) {
  return threshold === 0
    ? "Stops on the first failure"
    : `Stops after ${threshold + 1} failures`;
}

/** The observation period in words: "5 min", "1 h 30 min", "90 s". */
export function observationText(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const left = minutes % 60;
  return left ? `${hours} h ${left} min` : `${hours} h`;
}

/** What a rollout says it will do, for the page's one summary line. */
export function strategyText(
  settings: UpdateRolloutSettings,
  canaryNames: string | null = null,
) {
  const first = !canaryNames
    ? `Canary of ${settings.canary_size}`
    : settings.canary_size === 1
      ? `Canary ${canaryNames}`
      : `Canary of ${settings.canary_size} (${canaryNames})`;
  return `${first}, then batches of ${settings.batch_size}`;
}

/**
 * Why a rollout ended, in a sentence under its status: who ended it, or what
 * stopped it. Nothing for one that is running or finished normally.
 */
export function rolloutEnding(
  rollout: Pick<UpdateRollout, "status" | "failure_reason" | "cancel_reason">,
): string | null {
  if (rollout.status === "failed")
    return rollout.failure_reason === "data_plane"
      ? "Stopped: an updated device isn't delivering"
      : "Stopped after device failures";
  if (rollout.status !== "cancelled") return null;
  switch (rollout.cancel_reason) {
    case "stop":
      return "Cancelled by Stop all updates";
    case "key_revoked":
      return "Cancelled: its key was revoked";
    case "release_withdrawn":
      return "Cancelled: its release was withdrawn";
    default:
      return "Cancelled by a person";
  }
}

/** The rollout's name in lists: its own name, else its release. */
export const rolloutTitle = (
  rollout: Pick<UpdateRollout, "name" | "release">,
) => rollout.name || `Agent ${rollout.release.version}`;

/** One target's progress in words: the reason, never a guess. */
export function targetDetail(
  target: Pick<UpdateTarget, "state" | "code" | "from_version" | "to_version">,
  options: { stopped?: boolean } = {},
): string {
  const { state, code } = target;
  const reason = code ? codeText(code).reason : "";
  switch (state) {
    case "pending":
      return options.stopped
        ? "The rollout ended before this device was offered the build."
        : "Waits for its stage to be released.";
    case "offered":
      return "The offer reaches it at its next check-in.";
    case "downloading":
      return "Downloading the build and checking it.";
    case "staged":
      return "The build is staged. It isn't installed yet.";
    case "waiting_for_host":
      return "Staged. Waiting for someone on the host to run vectory update apply.";
    case "waiting_for_window":
      return "Staged. It installs when its update window opens.";
    case "applying":
      return "The host is swapping in the new build.";
    case "restarted":
      return "The new build checked in. The host is checking its health.";
    case "verified":
      return "The new build checked in after the restart, and the host reported it healthy.";
    case "rolled_back":
      return `${reason || "The host took the new build back."} It won't try ${target.to_version} again; it takes the next release.`;
    case "refused":
    case "failed":
      return (
        reason ||
        (state === "failed" ? "The update failed." : "The host refused it.")
      );
    case "cancelled":
      return "Cancelled before it started applying.";
    case "skipped":
      return "It wasn't ready (offline, or no longer eligible) before the rollout ended.";
  }
}

/* ---------- The review ---------- */

/** The codes whose fix is a host command made from the device's own report. */
export const commandFixCodes = [
  "UPDATES_OFF",
  "AGENT_TOO_OLD",
  "KEY_NOT_PINNED",
  "KEY_ROLLOVER_CONFLICT",
  "SERVICE_DEFINITION_OUTDATED",
  "VERSION_NOT_ON_TRACK",
] as const;
export type CommandFixCode = (typeof commandFixCodes)[number];
export const hasCommandFix = (code: string): code is CommandFixCode =>
  (commandFixCodes as readonly string[]).includes(code);
/** Codes whose command still needs a person to choose how the host takes updates. */
export const needsConsentChoice = (code: string) =>
  code === "UPDATES_OFF" || code === "AGENT_TOO_OLD";

export type ReviewDevice = {
  id: string;
  name: string;
  successors: [string, string] | null;
};
export type ReviewGroup = {
  code: string;
  title: string;
  reason: string;
  fix: string | null;
  devices: ReviewDevice[];
};
export type ReviewView = {
  release: string;
  willUpdate: UpdatePreview["will_update"];
  wontUpdate: ReviewGroup[];
  wontCount: number;
  warnings: { code: string; message: string; devices: ReviewDevice[] }[];
};

const deviceName = (name: string | null) => name || "An unnamed device";

/**
 * "Will update · N" and "Won't update · N" from a preview: every device of the
 * reviewed selection is in exactly one of them, so the two counts add up to the
 * selection. The server's own sentence says why a group won't; the title names
 * the code in the product's words.
 */
export function reviewView(preview: UpdatePreview): ReviewView {
  const group = (entry: UpdatePreview["wont_update"][number]): ReviewGroup => ({
    code: entry.code,
    title: reviewTitle(entry.code),
    reason: entry.reason || codeText(entry.code).reason,
    fix: entry.fix,
    devices: entry.devices.map((device) => ({
      id: device.device_id,
      name: deviceName(device.device_name),
      successors: device.successors,
    })),
  });
  const wontUpdate = preview.wont_update.map(group);
  return {
    release: preview.release.version,
    willUpdate: preview.will_update,
    wontUpdate,
    wontCount: wontUpdate.reduce((sum, entry) => sum + entry.devices.length, 0),
    warnings: preview.warnings.map((entry) => ({
      code: entry.code,
      message: entry.message,
      devices: entry.devices.map((device) => ({
        id: device.device_id,
        name: deviceName(device.device_name),
        successors: null,
      })),
    })),
  };
}

const reviewTitles: Record<string, string> = {
  DEVICE_REVOKED: "Access revoked",
  AGENT_TOO_OLD: "Agent too old, or no update report",
  PACKAGE_MANAGED: "Installed by a package manager",
  NO_SERVICE: "No service keeps the agent running",
  UNTRUSTED_LOCATION: "Install path others can write",
  READ_ONLY: "Install directory is read-only",
  HELPER_NOT_RUNNING: "Update step isn't running",
  SERVICE_DEFINITION_OUTDATED:
    "Service definition is older than this release needs",
  PLATFORM_NOT_IN_RELEASE: "Not in this release",
  UPDATES_OFF: "Updates are off on the host",
  KEY_ROLLOVER_CONFLICT: "Frozen on a key fork",
  KEY_NOT_PINNED: "Doesn't pin this release's key",
  RELEASE_ALREADY_TRIED: "Tried this release and rolled back",
  COUNTER_REPLAYED: "Already tried a newer release",
  ALREADY_RUNNING: "Already on this version",
  DOWNGRADE_REFUSED: "Runs a newer version",
  VERSION_NOT_ON_TRACK: "Outside the host's track",
  IN_ANOTHER_UPDATE: "In another update rollout",
};
export function reviewTitle(code: string) {
  return Object.hasOwn(reviewTitles, code) ? reviewTitles[code] : code;
}

/** Whether the review lets the rollout start: somebody will update. */
export const reviewStartable = (view: Pick<ReviewView, "willUpdate">) =>
  view.willUpdate.length > 0;

/* ---------- One device's report ---------- */

export const consentLabels = {
  off: "Off",
  auto: "Automatic",
  ask: "Ask on the host",
} as const;
export const trackLabels = {
  patch: "patch releases",
  minor: "patch and minor releases",
} as const;

/** "Pins key 3f9a1c0277de9b41 · kept offline": what the command makes a host trust. */
export function pinsText(key: {
  fingerprint: string;
  custody: "server" | "offline";
}) {
  return `Pins key ${shortKeyId(key.fingerprint)} · ${
    key.custody === "offline" ? "kept offline" : "held by this server"
  }`;
}

/**
 * The line a device page shows for its update setting, from its own report:
 * "Automatic · patch releases · Mon–Fri 02:00–04:00 · key 3f9a1c0277de9b41".
 * An off host is one sentence, and the sentence says how to change it.
 */
export function updatesLine(report: DeviceAgentUpdate) {
  if (report.consent === "off")
    return "Off on this host. Run the Upgrade agent command with updates on to let the dashboard update it.";
  return [
    consentLabels[report.consent],
    trackLabels[report.track],
    windowsText(report.windows),
    report.keys.length
      ? report.keys.length === 1
        ? `key ${shortKeyId(report.keys[0])}`
        : `keys ${report.keys.map(shortKeyId).join(", ")}`
      : "no key pinned",
  ].join(" · ");
}

/**
 * What a device says it is doing about an update, as one sentence the page can
 * place beside its state: the build named only when the report names it.
 * `null` while nothing is under way.
 */
export function currentUpdate(
  report: DeviceAgentUpdate,
  deviceName: string,
): { text: string; command?: "apply" } | null {
  const build = buildName(report.release_version);
  switch (report.state) {
    case "idle":
      return null;
    case "downloading":
      return { text: `Downloading ${build}` };
    case "staged":
      return { text: `Staged ${build}` };
    case "waiting_for_host":
      return {
        text: `Staged ${build} · waiting for someone on ${deviceName}`,
        command: "apply",
      };
    case "waiting_for_window":
      return { text: `Staged ${build} · waiting for its update window` };
    case "applying":
      return { text: `Applying ${build}` };
    case "trial":
      return {
        text: `Trying ${build} · the host takes it back by itself if it doesn't check in within 5 minutes`,
      };
    case "refused": {
      if (report.rollover_conflict) return null;
      return {
        text: `Refused ${build}: ${lowerFirst(codeText(report.code || "").reason)}`,
      };
    }
    case "failed":
      return {
        text: `Couldn't update to ${build}: ${lowerFirst(codeText(report.code || "").reason)}`,
      };
  }
}
const lowerFirst = (value: string) =>
  value ? value[0].toLowerCase() + value.slice(1) : value;

/**
 * The fork sentence: what the host saw, and the one thing that fixes it.
 * Null unless the report carries a fork.
 */
export function forkSentence(conflict: RolloverConflict | null) {
  if (!conflict) return null;
  const [first, second] = conflict.to.map(shortKeyId);
  return `Updates stopped on this host: two successors of key ${shortKeyId(conflict.from)} were seen, ${first} and ${second}. Run the Upgrade agent command with the right key.`;
}

/**
 * The last result in words: what changed (or didn't), and what it means for
 * the next release. An update that took carries its time and how soon the new
 * build checked in; the other results leave the time to the caller, which
 * shows it beside the sentence. `time` formats an ISO instant for the reader.
 */
export function lastResultText(
  last: LastResult,
  time: (value: string) => string,
): string {
  const to = last.to_version ?? "the new build";
  switch (last.outcome) {
    case "committed":
      return [
        `Updated ${last.from_version} → ${to}`,
        time(last.at),
        last.first_check_in_ms !== undefined
          ? `first check-in ${(last.first_check_in_ms / 1000).toFixed(1)} s after restart`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "rolled_back":
      return last.code === "ROLLBACK_UNHEALTHY"
        ? `Rolled back from ${to}, and the previous build hasn't checked in either. Run sudo vectory update status on the host. This device won't try ${to} again.`
        : `Rolled back from ${to}: ${rollbackClause(last.code)}. This device won't try ${to} again; it takes the next release.`;
    case "failed":
      return `Couldn't update to ${to}: ${lowerFirst(codeText(last.code || "").reason)} Nothing was installed.`;
    case "refused":
      return `Refused ${to}: ${lowerFirst(codeText(last.code || "").reason)}`;
  }
}
