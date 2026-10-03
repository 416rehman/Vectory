import type { AgentInstall, Device, Release } from "./api";
import {
  installerRun,
  platformDefaults,
  quote,
  shortDigest,
  unlessUnquotable,
  updateArguments,
  type HostOS,
  type UpdateAmend,
  type UpdateConsent,
} from "./enrollmentCommands";

export function agentUpgradeRelease(
  releases: Release[],
  os: string,
  arch: string,
): { release?: Release; reason?: string } {
  if (os === "darwin" && arch === "amd64")
    return {
      reason:
        "Vector 0.58.0 has no Intel Mac distribution. The agent download is build-only; this setup is not supported.",
    };
  const matches = releases.filter(
    (item) => item.os === os && item.arch === arch,
  );
  if (!matches.length)
    return {
      reason: "No agent download is available for this device's platform.",
    };
  if (matches.length !== 1)
    return {
      reason:
        "Several downloads match this platform. Ask your administrator to identify the intended build before upgrading.",
    };
  const release = matches[0];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(release.name) ||
    release.url !== `/api/v1/releases/${release.name}` ||
    typeof release.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(release.version) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.size) ||
    release.size <= 0
  )
    return {
      reason:
        "This download's metadata is incomplete or invalid. Ask your administrator to verify the release catalog.",
    };
  return { release };
}

/**
 * What the device says it runs, against this server's build for it: the
 * agent reports the SHA-256 of its own executable at each check-in (newer
 * agents), so "already runs this build" compares builds, not version labels.
 */
export function runningBuild(
  device: Pick<Device, "name" | "agent_sha256">,
  release: Release,
): { current: boolean; line: string } {
  if (!device.agent_sha256)
    return {
      current: false,
      line: `Development builds can share a version label, and ${device.name}'s agent doesn't report which build it runs, so this page can't tell whether it already runs this one.`,
    };
  if (device.agent_sha256 === release.sha256)
    return {
      current: true,
      line: `${device.name} already runs this build (SHA-256 ${shortDigest(release.sha256)}).`,
    };
  return {
    current: false,
    line: `${device.name} runs another build (SHA-256 ${shortDigest(device.agent_sha256)}); this server offers ${release.version} (SHA-256 ${shortDigest(release.sha256)}).`,
  };
}

/**
 * The Add device installer, run again on an enrolled Linux or macOS device:
 * it replaces the agent, and setup finds the enrolled state (so no token),
 * keeps the host's mode, account and service, restarts the service on the
 * new build and waits for its check-in. It passes only where the device
 * keeps its state (when it reports a directory other than the default) and
 * `--service none` when nothing keeps the agent running, so setup doesn't
 * register a service the host didn't have. Null where it doesn't apply:
 * Windows, a server without the installer, no verified download, or a state
 * directory the device reports that no command can carry (control characters).
 * With `updates`, the command also carries the host's consent to agent updates
 * (see UpdateConsent); without it, the command is exactly what it was.
 */
export function upgradeCommand(
  install: AgentInstall,
  device: Pick<Device, "os" | "state_dir" | "service_manager">,
  updates?: UpdateConsent | UpdateAmend,
): string | null {
  if (device.os !== "linux" && device.os !== "darwin") return null;
  const os: HostOS = device.os;
  return unlessUnquotable(() => {
    const args: string[] = [];
    if (device.state_dir && device.state_dir !== platformDefaults(os).stateDir)
      args.push("--state-dir", quote(device.state_dir, os));
    if (device.service_manager === "none") args.push("--service", "none");
    args.push(...updateArguments(updates, os));
    return installerRun(install, { os }, [], args);
  });
}

/**
 * What the person should know before running the upgrade command. Code
 * (flags, commands) is in backticks, for the page to set as code.
 */
export function upgradeNotes(
  install: Pick<AgentInstall, "default_install_dir">,
  device: Pick<Device, "name" | "state_dir" | "service_manager">,
): string[] {
  const notes = [
    `The agent goes to ${install.default_install_dir || "/usr/local/bin"}. If ${device.name}'s agent is installed somewhere else, add \`--install-dir\` with that directory.`,
  ];
  if (!device.state_dir)
    notes.push(
      `${device.name}'s agent doesn't report its state directory. If it isn't the default, add \`--state-dir\` with it; otherwise setup treats this as a new installation.`,
    );
  if (device.service_manager === "none")
    notes.push(
      "Nothing restarts `vectory run` for you: setup says when to stop it and start it again on the new build.",
    );
  return notes;
}
