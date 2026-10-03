// What the codes of agent updates say, in words. An agent reports a code with
// every refusal, failure and rollback; the review gives one to each device
// that won't update. The page shows the sentence and keeps the code for support.
// Nothing here is inferred: a code the page doesn't know reads as the code.

export type CodeText = {
  /** What happened, as a sentence ending in a full stop. */
  reason: string;
  /** What changes it, when someone on the host or in the dashboard can. */
  fix?: string;
};

/** A host's own reason it can't take an update (the heartbeat's `eligibility`). */
export const eligibilityCodes = [
  "PACKAGE_MANAGED",
  "NO_SERVICE",
  "UNTRUSTED_LOCATION",
  "READ_ONLY",
  "HELPER_NOT_RUNNING",
  "SERVICE_DEFINITION_OUTDATED",
  "PLATFORM_NOT_IN_RELEASE",
] as const;

const texts: Record<string, CodeText> = {
  UPDATES_OFF: {
    reason: "Updates are off on this host.",
    fix: "Run the Upgrade agent command with updates on, once.",
  },
  UPDATES_PAUSED: {
    reason: "Updates are paused on this host.",
    fix: "Run vectory update resume on the host.",
  },
  KEY_NOT_PINNED: {
    reason: "This host doesn't pin the key that signed this release.",
    fix: "Run the Upgrade agent command with the current key.",
  },
  SIGNATURE_INVALID: {
    reason: "The release's signature didn't verify on this host.",
  },
  MANIFEST_INVALID: {
    reason: "The release's manifest broke a rule of its format.",
  },
  MANIFEST_EXPIRED: {
    reason: "This release has expired. Prepare a new one.",
  },
  KEY_ROLLOVER_CONFLICT: {
    reason:
      "This host saw two successors of its key, so it stopped accepting updates.",
    fix: "Run the Upgrade agent command with the right key.",
  },
  RELEASE_ALREADY_TRIED: {
    reason:
      "This build was tried here and rolled back; publish a new release to try again.",
  },
  COUNTER_REPLAYED: {
    reason: "This release is older than one this host already tried.",
  },
  DOWNGRADE_REFUSED: {
    reason: "This host already runs a newer agent.",
  },
  VERSION_NOT_ON_TRACK: {
    reason: "This version is outside the releases this host takes.",
    fix: "Run the Upgrade agent command with Minor releases too.",
  },
  AGENT_TOO_OLD: {
    reason: "This agent is too old to take this release.",
    fix: "Run the Upgrade agent command with updates on, once.",
  },
  ALREADY_RUNNING: {
    reason: "This host already runs this version.",
  },
  PLATFORM_NOT_IN_RELEASE: {
    reason: "This release has no build for this host's platform.",
  },
  PACKAGE_MANAGED: {
    reason: "A package manager owns this agent, so it updates it.",
  },
  NO_SERVICE: {
    reason: "No service keeps this agent running, so it can't swap itself.",
  },
  UNTRUSTED_LOCATION: {
    reason: "A directory on the agent's path can be written by others.",
  },
  READ_ONLY: {
    reason: "The host can't write in the agent's install directory.",
  },
  HELPER_NOT_RUNNING: {
    reason: "The update step on this host isn't running.",
    fix: "Run vectory doctor on the host.",
  },
  SERVICE_DEFINITION_OUTDATED: {
    reason: "The host's service definition is older than this release needs.",
    fix: "Run the Upgrade agent command, once.",
  },
  DOWNLOAD_FAILED: {
    reason: "The download failed. The agent tries again at its next check-in.",
  },
  ARTIFACT_MISMATCH: {
    reason: "The downloaded file didn't match the release's size and digest.",
  },
  DISK_FULL: {
    reason: "The host has no room for the new build.",
  },
  PROBE_FAILED: {
    reason:
      "The new build didn't report the version and platform the release names.",
  },
  START_FAILED: {
    reason: "The new build couldn't start.",
  },
  NO_CHECK_IN: {
    reason: "The new build didn't check in within 5 minutes.",
  },
  UNHEALTHY: {
    reason: "The new build started but wasn't healthy.",
  },
  INTERRUPTED: {
    reason: "The update was interrupted.",
  },
  BINARY_CHANGED: {
    reason:
      "The agent file was replaced outside the update, so the request was dropped.",
  },
  ROLLBACK_UNHEALTHY: {
    reason:
      "The host went back to the previous build, and that build isn't healthy either.",
  },
  NO_REPORT: {
    reason: "The device stopped reporting after the update began.",
  },
  DEVICE_REVOKED: {
    reason: "This device's access is revoked.",
  },
  IN_ANOTHER_UPDATE: {
    reason: "This device is in another update rollout.",
  },
};

/** The sentence for a code, or the code itself when the page doesn't know it. */
export function codeText(code: string): CodeText {
  return Object.hasOwn(texts, code) ? texts[code] : { reason: code };
}

/**
 * Why a build was taken back, as a clause after "Rolled back from 0.1.1:".
 * Lower case at the start, no full stop.
 */
const rollbackClauses: Record<string, string> = {
  NO_CHECK_IN: "it didn't check in within 5 minutes",
  START_FAILED: "it couldn't start",
  UNHEALTHY: "it started but wasn't healthy",
  INTERRUPTED: "the update was interrupted",
  ROLLBACK_UNHEALTHY: "the previous build isn't healthy either",
};
export function rollbackClause(code: string | null) {
  return code && Object.hasOwn(rollbackClauses, code)
    ? rollbackClauses[code]
    : "the new build didn't pass its check";
}

/** A version for a sentence: the one the report names, never a guess. */
export const buildName = (version: string | null | undefined) =>
  version ? version : "an agent build";
