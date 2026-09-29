// The host commands the deploy dialog hands over when restricted devices must
// approve what a version uses. They are made for each device from what its
// agent reports: where it keeps its state and what keeps it running. They add
// to the host's allowances with `vectory allow`, which keeps everything the
// host already allows: the dashboard never learns or replaces a host's local
// policy, and only a host operator can change it.
import type { Device } from "./api";
import {
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

function hostOS(os: string): HostOS {
  return os === "windows" || os === "darwin" ? os : "linux";
}

/** The commands for one device: stop its agent, allow, start it again. */
export function hostCommands(
  approvals: HostApprovals,
  device: HostDevice,
): string {
  const os = hostOS(device.os);
  const stateDir =
    device.state_dir && device.state_dir !== platformDefaults(os).stateDir
      ? ["--state-dir", quote(device.state_dir, os)]
      : [];
  const args = [...stateDir, ...allowArguments(approvals, os)];
  if (os === "windows") {
    const agent = `& ${quote(platformDefaults("windows").binary, "windows")}`;
    const allow = `${agent} allow ${args.join(" ")}`;
    return device.service_manager === "none"
      ? [
          "# In an elevated PowerShell. First stop the agent: Ctrl-C where `vectory run` runs.",
          allow,
          "# Then start the agent again the way you started it.",
        ].join("\n")
      : [
          "# In an elevated PowerShell:",
          `${agent} service-stop`,
          allow,
          `${agent} service-start`,
        ].join("\n");
  }
  const allow = continued("sudo vectory allow", args);
  switch (device.service_manager) {
    case "none":
      return [
        "# First stop the agent: Ctrl-C where `vectory run` runs (`vectory status` shows its pid).",
        allow,
        "# Then start the agent again the way you started it.",
      ].join("\n");
    case "systemd":
    case "launchd":
      return [
        "sudo vectory service-stop",
        allow,
        "sudo vectory service-start",
      ].join("\n");
    default:
      // An older agent doesn't say what keeps it running.
      return [
        "# Without a service (`vectory run`), stop it with Ctrl-C instead, and start it again yourself.",
        "sudo vectory service-stop",
        allow,
        "sudo vectory service-start",
      ].join("\n");
  }
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
    blocks.set(commands, [...(blocks.get(commands) || []), device.name]);
  }
  return [...blocks].map(([commands, names]) => ({ devices: names, commands }));
}

/** "r16-host", "r16-host and edge-2", "r16-host, edge-2 and 3 more". */
export function namedDevices(names: string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
