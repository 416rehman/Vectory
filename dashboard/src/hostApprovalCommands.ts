// The host commands the deploy dialog hands over: allow what a version uses on
// a restricted host, and bind the device secrets it names. They are made for
// each device from what its agent reports: where it keeps its state and what
// keeps it running. `vectory allow` adds to the host's allowances and keeps
// everything the host already allows: the dashboard never learns or replaces a
// host's local policy, and only a host operator can change it.
import type { Device } from "./api";
import {
  CommandValueError,
  continued,
  platformDefaults,
  quote,
  type HostOS,
} from "./enrollmentCommands";
import type { HostApprovals } from "./hostRequirements";

type HostDevice = Pick<Device, "name" | "os" | "state_dir" | "service_manager">;

/** `vectory allow` flags for these approvals, one per item, quoted for the host. */
export function allowArguments(approvals: HostApprovals, os: HostOS) {
  return [
    ...approvals.destinations.flatMap((item) => ["--network", quote(item, os)]),
    ...approvals.listeners.flatMap((item) => ["--listener", quote(item, os)]),
    ...approvals.fileRoots.flatMap((item) => ["--file-root", quote(item, os)]),
  ];
}

export function hostOS(os: string): HostOS {
  return os === "windows" || os === "darwin" ? os : "linux";
}

/** `--state-dir` and its value when the agent keeps its state anywhere but the default. */
export function stateDirArguments(
  device: Pick<Device, "os" | "state_dir">,
): string[] {
  const os = hostOS(device.os);
  return device.state_dir && device.state_dir !== platformDefaults(os).stateDir
    ? ["--state-dir", quote(device.state_dir, os)]
    : [];
}

/**
 * The commands for one device: stop its agent, run `vectory <subcommand>`,
 * start it again, the way this host keeps its agent running. `options` follow
 * the subcommand; the host's state directory is added when it isn't the
 * default. `oneLine` keeps a command with a single option on one line.
 */
function whileStopped(
  device: HostDevice,
  subcommand: string,
  options: string[],
  oneLine = false,
): string {
  const os = hostOS(device.os);
  const stateDir = stateDirArguments(device);
  const args = [...stateDir, ...options];
  if (os === "windows") {
    const agent = `& ${quote(platformDefaults("windows").binary, "windows")}`;
    const run = `${agent} ${subcommand} ${args.join(" ")}`;
    return device.service_manager === "none"
      ? [
          "# In an elevated PowerShell. First stop the agent: Ctrl-C where `vectory run` runs.",
          run,
          "# Then start the agent again the way you started it.",
        ].join("\n")
      : [
          "# In an elevated PowerShell:",
          `${agent} service-stop`,
          run,
          `${agent} service-start`,
        ].join("\n");
  }
  const run =
    oneLine && !stateDir.length
      ? ["sudo vectory", subcommand, ...args].join(" ")
      : continued(`sudo vectory ${subcommand}`, args);
  switch (device.service_manager) {
    case "none":
      return [
        "# First stop the agent: Ctrl-C where `vectory run` runs (`vectory status` shows its pid).",
        run,
        "# Then start the agent again the way you started it.",
      ].join("\n");
    case "systemd":
    case "launchd":
      return [
        "sudo vectory service-stop",
        run,
        "sudo vectory service-start",
      ].join("\n");
    default:
      // An older agent doesn't say what keeps it running.
      return [
        "# Without a service (`vectory run`), stop it with Ctrl-C instead, and start it again yourself.",
        "sudo vectory service-stop",
        run,
        "sudo vectory service-start",
      ].join("\n");
  }
}

/**
 * A value no command can carry safely, such as a path with a control
 * character, gets a note in place of the commands.
 */
function carried(build: () => string, what: string, then: string): string {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof CommandValueError)) throw error;
    return [
      `# No command can be shown for this host: ${what} contains ${error.reason === "control" ? "a control character" : "a double quote"}.`,
      then,
    ].join("\n");
  }
}

/** The commands that allow what a version uses, for one device. */
export function hostCommands(
  approvals: HostApprovals,
  device: HostDevice,
): string {
  return carried(
    () =>
      whileStopped(
        device,
        "allow",
        allowArguments(approvals, hostOS(device.os)),
      ),
    "a destination, listener, path or state directory",
    "# Check what this version uses and where the agent keeps its state, then write the vectory allow command by hand.",
  );
}

/**
 * The commands that bind device secrets from a bindings file, for one device.
 * The file lists every name the host needs; the commands only register it.
 */
export function bindingCommands(
  bindingsFile: string,
  device: HostDevice,
): string {
  return carried(
    () =>
      whileStopped(
        device,
        "configure-secrets",
        ["--secret-files", quote(bindingsFile, hostOS(device.os))],
        true,
      ),
    "the state directory",
    "# Check where the agent keeps its state, then write the vectory configure-secrets command by hand.",
  );
}

/**
 * One block of commands per distinct host setup, naming its devices, so a
 * fleet with one layout gets one block and a mixed one gets one per layout.
 */
export function hostApprovalCommands(
  approvals: HostApprovals,
  devices: HostDevice[],
): { devices: string[]; commands: string }[] {
  const blocks = new Map<string, string[]>();
  for (const device of devices) {
    const commands = hostCommands(approvals, device);
    if (!blocks.has(commands)) blocks.set(commands, []);
    blocks.get(commands)!.push(device.name);
  }
  return [...blocks].map(([commands, names]) => ({ devices: names, commands }));
}

/** Group the commands rendered for each host's own variable values and setup. */
export function hostApprovalCommandsByDevice(
  approvals: ReadonlyMap<string, HostApprovals>,
  devices: (HostDevice & Pick<Device, "id">)[],
): { devices: string[]; commands: string }[] {
  const blocks = new Map<string, string[]>();
  for (const device of devices) {
    const needed = approvals.get(device.id);
    if (!needed) continue;
    const commands = hostCommands(needed, device);
    if (!blocks.has(commands)) blocks.set(commands, []);
    blocks.get(commands)!.push(device.name);
  }
  return [...blocks].map(([commands, names]) => ({ devices: names, commands }));
}

/** "web-01", "web-01 and edge-2", "web-01, edge-2 and 3 more". */
export function namedDevices(names: string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
