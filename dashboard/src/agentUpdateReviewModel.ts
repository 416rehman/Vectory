// The review before an update rollout starts: what the person chose, the
// settings it sends, the words about who will and won't update, and the host
// commands that fix a device that won't. Nothing here decides who updates: the
// server's review does, and the rollout starts only on the review the person
// saw (its token), never on a guess.
import type { AgentInstall, Device } from "./api";
import type {
  AgentRelease,
  ReviewGroup,
  UpdatePreview,
  UpdateRolloutSettings,
} from "./agentUpdateModel";
import {
  consentLabels,
  hasCommandFix,
  needsConsentChoice,
} from "./agentUpdateModel";
import {
  consentFor,
  windowsConsentCommand,
  type ConsentChange,
  type ConsentChoice,
} from "./agentUpdateCommands";
import { upgradeCommand } from "./agentUpgradeModel";
import { shortKeyId } from "./releaseKey";
import { windowsText } from "./updateWindow";
import type { PreviewRequest, StartRequest } from "./agentUpdateApi";

/* ---------- What the person chooses ---------- */

export type ReviewForm = {
  releaseId: string;
  groupIds: string[];
  deviceIds: string[];
  canary: number;
  batch: number;
  /** Seconds each stage is watched after its devices are done. */
  observe: number;
  /** Devices that may fail before the rollout stops; 0 stops at the first. */
  threshold: number;
  /** Devices named for the canary; empty leaves the choice to the server. */
  canaryDeviceIds: string[];
  name: string;
};

/** The defaults of the contract: a canary of one, batches of ten, five minutes, stop at the first failure. */
export const defaultSettings = {
  canary: 1,
  batch: 10,
  observe: 300,
  threshold: 0,
};

export type SettingsErrors = Partial<
  Record<"canary" | "batch" | "observe" | "threshold", string>
>;
const whole = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;
/** What is wrong with the numbers, by field; empty when they are fine. */
export function settingsErrors(
  form: Pick<ReviewForm, "canary" | "batch" | "observe" | "threshold">,
): SettingsErrors {
  const errors: SettingsErrors = {};
  if (!whole(form.canary, 1, 100))
    errors.canary = "Use a whole number from 1 to 100.";
  if (!whole(form.batch, 1, 50))
    errors.batch = "Use a whole number from 1 to 50.";
  if (!whole(form.observe, 60, 86400))
    errors.observe = "Use 60 to 86,400 seconds, a minute to a day.";
  if (!whole(form.threshold, 0, 100))
    errors.threshold = "Use a whole number from 0 to 100.";
  return errors;
}

/** The name a rollout may carry: one line, at most 120 characters, or none. */
export function nameProblem(name: string) {
  const trimmed = name.trim();
  if ([...trimmed].length > 120) return "A name is at most 120 characters.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed))
    return "A name is one line, without control characters.";
  return "";
}

export function rolloutSettings(form: ReviewForm): UpdateRolloutSettings {
  const named = form.canaryDeviceIds.slice(0, form.canary);
  return {
    canary_size: form.canary,
    batch_size: form.batch,
    observation_seconds: form.observe,
    failure_threshold: form.threshold,
    ...(named.length ? { canary_device_ids: named } : {}),
  };
}

/** The request that reviews the choices; nothing is written by it. */
export function previewRequest(form: ReviewForm): PreviewRequest {
  return {
    release_id: form.releaseId,
    selector: {
      device_ids: [...form.deviceIds].sort(),
      group_ids: [...form.groupIds].sort(),
      exclude_ids: [],
    },
    rollout: rolloutSettings(form),
  };
}

/**
 * The request that starts the rollout the review described: the same choices,
 * the token of that review and the identity that makes a second send harmless.
 */
export function startRequest(
  form: ReviewForm,
  review: Pick<UpdatePreview, "review_token">,
  requestId: string,
): StartRequest {
  const name = form.name.trim();
  return {
    ...previewRequest(form),
    ...(name ? { name } : {}),
    review_token: review.review_token,
    request_id: requestId,
  };
}

/* ---------- Words about the review ---------- */

/** "Chosen for you: devices that take updates by themselves, with a window open or none, the most ready first." */
export function canaryWhy(preview: UpdatePreview) {
  const names = preview.will_update
    .filter((device) => preview.canary.device_ids.includes(device.device_id))
    .map((device) => device.device_name || "an unnamed device");
  if (!preview.canary.device_ids.length)
    return "Nobody will update, so no device is released first.";
  return preview.canary.chosen_by_you
    ? `You chose ${list(names)} as the first to update.`
    : `Chosen for you: devices that take updates by themselves with a window open or none, the most ready first.`;
}
const list = (names: string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;

/** One device's line in "Will update": how it takes the update, and when it can start. */
export function levelLine(
  device: Pick<UpdatePreview["will_update"][number], "consent">,
) {
  return consentLabels[device.consent];
}
export function windowLine(
  device: Pick<
    UpdatePreview["will_update"][number],
    "windows" | "next_window_at"
  >,
  format: (instant: string) => string,
) {
  return device.windows.length === 0
    ? "Any time"
    : device.next_window_at
      ? `${windowsText(device.windows)} · next ${format(device.next_window_at)}`
      : `${windowsText(device.windows)} · open now`;
}

/** The sentence over the review: what starts, and how. */
export function reviewSentence(
  preview: UpdatePreview,
  settings: UpdateRolloutSettings,
) {
  const updating = preview.will_update.length;
  const total = updating + countWont(preview);
  return `Agent ${preview.release.version} goes to ${updating.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "device" : "devices"} you chose, a canary of ${settings.canary_size} first, then batches of ${settings.batch_size}.`;
}
export const countWont = (
  preview: Pick<UpdatePreview, "wont_update">,
): number =>
  preview.wont_update.reduce((sum, group) => sum + group.devices.length, 0);

/** The release a review is for, in one line for a heading. */
export const releaseLine = (release: AgentRelease) =>
  `Agent ${release.version} · counter ${release.counter}`;

/* ---------- Host commands for devices that won't update ---------- */

export type HostFixInput = {
  group: Pick<ReviewGroup, "code">;
  device: Device;
  install: AgentInstall;
  /** The fingerprint of the key this server signs with now. */
  key: string;
  /** How the host should take updates, for a host that has no consent to keep. */
  choice?: ConsentChoice;
  /** The track a host on the wrong one should take. */
  track?: "patch" | "minor";
};

/**
 * What the command for a group changes on a host that already takes updates.
 * The key to pin is this server's current one; a host on the wrong track takes
 * the minor track; a service definition is rewritten by the upgrade itself.
 */
function fixChange(code: string, track?: "patch" | "minor"): ConsentChange {
  switch (code) {
    case "KEY_NOT_PINNED":
    case "KEY_ROLLOVER_CONFLICT":
      return { pinKey: true };
    case "VERSION_NOT_ON_TRACK":
      return { track: "minor" };
    case "SERVICE_DEFINITION_OUTDATED":
      return {};
    default:
      return { pinKey: true, track };
  }
}

/** The codes whose fix on a Windows host is one run of `setup` with update flags. */
const windowsFixCodes = [
  "UPDATES_OFF",
  "KEY_NOT_PINNED",
  "KEY_ROLLOVER_CONFLICT",
  "VERSION_NOT_ON_TRACK",
];

/**
 * The command that fixes one device, made from where it keeps its state, or
 * null when no command does (a Windows host that needs a new agent, a state
 * directory no command can carry, a choice still to make). A host that already
 * takes updates keeps its level,
 * windows and track: the command carries only what the fix changes, never a
 * value the device reported about its own consent. A host that has none gets
 * the choice a person made.
 */
export function hostFixCommand(input: HostFixInput): string | null {
  const { group, device, install, key } = input;
  if (!hasCommandFix(group.code)) return null;
  const consent = consentFor(device.agent_update ?? null, key, {
    choice: input.choice,
    change: fixChange(group.code, input.track),
  });
  if (!consent) return null;
  const command = upgradeCommand(install, device, consent);
  if (command || device.os !== "windows") return command;
  // A Windows host has no installer to run. What it needs is its consent, which
  // setup gives from the agent that is installed there: not for an agent that
  // predates updates, nor for a service definition, which a new agent writes.
  return windowsFixCodes.includes(group.code)
    ? windowsConsentCommand(device, consent)
    : null;
}

export type HostFixBlock = { devices: string[]; command: string };
/**
 * Devices that share one command (the same state directory and service) share
 * one block, so a group of fifty hosts with default installs reads as one
 * command "On these hosts" rather than fifty.
 */
export function hostFixBlocks(
  inputs: { name: string; command: string | null }[],
): { blocks: HostFixBlock[]; without: string[] } {
  const blocks = new Map<string, string[]>();
  const without: string[] = [];
  for (const { name, command } of inputs) {
    if (!command) without.push(name);
    else blocks.set(command, [...(blocks.get(command) ?? []), name]);
  }
  return {
    blocks: [...blocks].map(([command, devices]) => ({ command, devices })),
    without,
  };
}

/** What a group needs from the person before any command can be made. */
export const groupNeedsChoice = (group: Pick<ReviewGroup, "code">) =>
  needsConsentChoice(group.code);

/**
 * Whether the server's fix for a group is a command to run on the hosts. A host
 * follows keys forward only, so for hosts an older key's release can't reach
 * the fix is another release (the current key signs it), and no command on the
 * host changes that. The server says which it is, per group, in the fix
 * itself; the page offers commands only when that sentence sends the person to
 * the Upgrade agent command, so it never offers one that would change nothing.
 */
export const fixIsHostCommand = (group: Pick<ReviewGroup, "code" | "fix">) =>
  hasCommandFix(group.code) &&
  !!group.fix &&
  /\bUpgrade agent\b/.test(group.fix);

/**
 * The fork a host is frozen on, for the review: the two successors it saw, as
 * short IDs, and which of them is the key this server signs with, when one is.
 */
export function forkText(
  successors: [string, string],
  currentKey: string | null,
) {
  const [first, second] = successors.map(shortKeyId);
  const mine =
    currentKey === successors[0]
      ? first
      : currentKey === successors[1]
        ? second
        : null;
  return mine
    ? `Two successors of its key: ${first} and ${second}. This server signs with ${mine}.`
    : `Two successors of its key: ${first} and ${second}. This server signs with neither.`;
}
