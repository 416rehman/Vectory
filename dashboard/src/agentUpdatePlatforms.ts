import type { HostOS } from "./enrollmentCommands";

/**
 * Whether a host of this system can take agent updates in this release. These are
 * the agent's own switches (agent/internal/agent/update_gate.go): `vectory setup`
 * on a system that is closed refuses `--updates`, so no command here may carry a
 * consent for one. A test keeps the two the same.
 */
export const updatesInRelease: Record<HostOS, boolean> = {
  linux: true,
  darwin: true,
  windows: false,
};

export const systemName: Record<HostOS, string> = {
  linux: "Linux",
  darwin: "macOS",
  windows: "Windows",
};

/** Whether a system takes updates; a system nobody named takes none. */
export function updatesShip(os: string | null | undefined): boolean {
  return os === "linux" || os === "darwin" || os === "windows"
    ? updatesInRelease[os]
    : false;
}

/** What a page says where the choice of how a host takes updates would be. */
export function updatesNotInRelease(os: HostOS): string {
  return `Agent updates aren't in this release for ${systemName[os]} hosts. Upgrade the agent on the host instead; Upgrade agent on the device's page shows how.`;
}
