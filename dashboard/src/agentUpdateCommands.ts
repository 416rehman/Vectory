// The choices and host commands of agent updates. A host agrees to updates in
// the command a person runs on it: the level, the releases it takes, a window,
// and the fingerprint of the release key it will trust. The dashboard never
// decides that for a host, so every command here follows a choice a person made
// (or the host's own report) and nothing is preselected.
import type { Device } from "./api";
import {
  continued,
  platformDefaults,
  quote,
  unlessUnquotable,
  type UpdateConsent,
  type UpdateTrack,
} from "./enrollmentCommands";
import { hostOS, stateDirArguments } from "./hostApprovalCommands";
import type { DeviceAgentUpdate } from "./agentUpdateModel";

export type UpdateLevel = "auto" | "ask" | "off";

/** The three levels, as the Add device step offers them. */
export const consentChoices: {
  value: UpdateLevel;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Automatic (recommended)",
    description:
      "Installs new agent builds when an update rollout reaches this device, inside the window you set",
  },
  {
    value: "ask",
    label: "Ask on the host",
    description:
      "Downloads and checks the build, then waits for someone to run sudo vectory update apply",
  },
  {
    value: "off",
    label: "Off",
    description: "This host updates only by hand",
  },
];

export const trackChoices: {
  value: UpdateTrack;
  label: string;
  description: string;
}[] = [
  {
    value: "patch",
    label: "Patch releases",
    description: "New patch versions of the agent version it runs now",
  },
  {
    value: "minor",
    label: "Minor releases too",
    description: "New minor and patch versions, never a new major version",
  },
];

type HostDevice = Pick<Device, "os" | "state_dir" | "service_manager">;

/**
 * `vectory update <verb>` for one host: with sudo on Linux and macOS, in an
 * elevated PowerShell on Windows, and with `--state-dir` when the agent keeps
 * its state anywhere but the default. Null when a value can't be quoted.
 */
export function updateVerbCommand(
  verb: "status" | "apply" | "pause" | "resume" | "off",
  device: HostDevice,
): string | null {
  return unlessUnquotable(() => {
    const os = hostOS(device.os);
    const stateDir = stateDirArguments(device);
    if (os === "windows")
      return [
        "# In an elevated PowerShell:",
        `& ${quote(platformDefaults("windows").binary, "windows")} update ${verb}${stateDir.length ? ` ${stateDir.join(" ")}` : ""}`,
      ].join("\n");
    return stateDir.length
      ? continued(`sudo vectory update ${verb}`, stateDir)
      : `sudo vectory update ${verb}`;
  });
}

export type ConsentChoice = { level: "auto" | "ask"; track?: UpdateTrack };

/**
 * The consent a command should carry for one host. A host that already takes
 * updates keeps its level, windows and (unless the fix changes it) its track;
 * only the key it pins is the server's current one. A host that is off, or
 * reported nothing, has no consent to keep, so it needs the choice a person
 * made; without one there is no command.
 */
export function consentFor(
  report: DeviceAgentUpdate | null | undefined,
  key: string,
  options: { choice?: ConsentChoice; track?: UpdateTrack } = {},
): UpdateConsent | null {
  if (report && report.consent !== "off")
    return {
      level: report.consent,
      track: options.track ?? report.track,
      windows: report.windows,
      key,
    };
  if (!options.choice) return null;
  return {
    level: options.choice.level,
    track: options.track ?? options.choice.track ?? "patch",
    windows: [],
    key,
  };
}
