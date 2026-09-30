/** Pure device-list logic: quick view names, version labels and fresh rates. */
import { type DeviceStatusInput } from "./status";
import { present, TELEMETRY_FRESH_MS } from "./overviewModel";

export type ListDevice = DeviceStatusInput & {
  id: string;
  name: string;
  os?: string;
  arch?: string;
  labels?: Record<string, string>;
  agent_version?: string;
  vector_version?: string;
  apply_state?: string;
  desired_version_id?: string | null;
  desired_generation?: number;
  reported_generation?: number;
  desired_version?: {
    number?: number | null;
    configuration_id?: string | null;
    configuration_name?: string | null;
  } | null;
  telemetry?: {
    sampled_at?: string;
    events_per_second?: number | null;
    events_out_per_second?: number | null;
  } | null;
};

/** The quick views; the server applies them (`drift` is its `not_on_desired`). */
export type DeviceView =
  "failing" | "drift" | "offline" | "paused" | "no_telemetry";
export const deviceViews: { value: DeviceView; label: string }[] = [
  { value: "failing", label: "Failing" },
  { value: "drift", label: "Not on desired version" },
  { value: "offline", label: "Offline" },
  { value: "paused", label: "Paused" },
  { value: "no_telemetry", label: "No telemetry" },
];
export const isDeviceView = (value: string): value is DeviceView =>
  deviceViews.some((view) => view.value === value);

/** The agent verified the desired version (or last reported it before going offline). */
export function runsDesired(device: ListDevice) {
  if (!device.desired_version_id || device.status === "revoked") return false;
  if (device.status === "verified") return true;
  return (
    device.apply_state === "verified_applied" &&
    device.reported_generation === device.desired_generation &&
    ["offline", "paused"].includes(device.status)
  );
}

/** Events in per second from a sample no older than three minutes. */
export function freshRate(device: ListDevice, now = Date.now()) {
  const sampled = Date.parse(device.telemetry?.sampled_at || "");
  if (!Number.isFinite(sampled) || now - sampled > TELEMETRY_FRESH_MS)
    return null;
  const rate = device.telemetry?.events_per_second;
  return present(rate) ? rate : null;
}
/** Events in and delivered per second from a fresh sample. */
export function freshFlow(device: ListDevice, now = Date.now()) {
  const input = freshRate(device, now);
  if (input === null) return null;
  const out = device.telemetry?.events_out_per_second;
  return { in: input, out: present(out) ? out : null };
}

/** "Orders v3", "v3", or null when no version is assigned. */
export function versionLabel(device: ListDevice) {
  if (!device.desired_version_id) return null;
  const version = device.desired_version;
  const number = present(version?.number) ? `v${version!.number}` : "";
  const name = version?.configuration_name || "";
  return [name, number].filter(Boolean).join(" ") || "Assigned version";
}

export type VersionMarker = {
  tone: "success" | "info" | "warning" | "danger" | "neutral";
  icon: "check" | "clock" | "x" | "question" | "pause";
  text: string;
};
/** Whether the device runs what it should: the running-vs-desired marker. */
export function versionMarker(device: ListDevice): VersionMarker | null {
  if (!device.desired_version_id || device.status === "revoked") return null;
  if (runsDesired(device))
    return device.status === "verified"
      ? { tone: "success", icon: "check", text: "Running" }
      : { tone: "neutral", icon: "check", text: "Running at last report" };
  if (["failed", "rolled_back"].includes(device.status))
    return {
      tone: "danger",
      icon: "x",
      text:
        device.status === "rolled_back"
          ? "Rolled back · previous version kept"
          : "Failed · previous version kept",
    };
  if (device.status === "verification_unknown")
    return { tone: "warning", icon: "question", text: "Not confirmed running" };
  if (device.status === "paused" || device.sync_paused || device.local_paused)
    return { tone: "neutral", icon: "pause", text: "Waiting for sync" };
  if (device.status === "conflict")
    return { tone: "danger", icon: "x", text: "Assignment conflict" };
  return { tone: "info", icon: "clock", text: "Not running yet" };
}
