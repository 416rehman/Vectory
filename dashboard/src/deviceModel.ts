/** Pure device-list logic: quick views, version labels and sort keys. */
import { connectionState, type DeviceStatusInput } from "./status";
import {
  healthBucket,
  healthOrder,
  present,
  TELEMETRY_FRESH_MS,
  type HealthBucket,
} from "./overviewModel";

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
  } | null;
};

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
export function reportsTelemetry(device: ListDevice, now = Date.now()) {
  const sampled = Date.parse(device.telemetry?.sampled_at || "");
  return Number.isFinite(sampled) && now - sampled <= TELEMETRY_FRESH_MS;
}

export function matchesView(
  device: ListDevice,
  view: DeviceView,
  now = Date.now(),
) {
  if (device.status === "revoked") return false;
  switch (view) {
    case "failing":
      return [
        "failed",
        "rolled_back",
        "conflict",
        "verification_unknown",
      ].includes(device.status);
    case "drift":
      return !!device.desired_version_id && !runsDesired(device);
    case "offline":
      return ["offline", "never"].includes(connectionState(device));
    case "paused":
      return (
        device.status === "paused" ||
        !!device.sync_paused ||
        !!device.local_paused
      );
    case "no_telemetry":
      return !reportsTelemetry(device, now);
  }
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

/** Sort key: problems first, healthy last, revoked at the end. */
const statusOrder: (HealthBucket | "revoked")[] = [
  "failed",
  "check",
  "offline",
  "updating",
  "paused",
  "unmanaged",
  "applied",
  "revoked",
];
export function statusRank(device: ListDevice) {
  const bucket = healthBucket(device) ?? "revoked";
  return statusOrder.indexOf(bucket);
}
export const statusFilterValues = [...healthOrder, "revoked"] as const;
export function matchesStatus(device: ListDevice, status: string) {
  if (!status) return true;
  if (status === "revoked") return device.status === "revoked";
  return healthBucket(device) === status;
}

export function searchText(device: ListDevice, groups: string[] = []) {
  return [
    device.name,
    device.os,
    device.arch,
    ...Object.entries(device.labels || {}).flat(),
    versionLabel(device),
    device.vector_version,
    device.agent_version,
    ...groups,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

/** Group names for each device id, in group-name order. */
export function groupsByDevice(
  groups: { id: string; name: string; device_ids: string[] }[],
) {
  const map = new Map<string, { id: string; name: string }[]>();
  for (const group of [...groups].sort((a, b) => a.name.localeCompare(b.name)))
    for (const id of group.device_ids) {
      const list = map.get(id) ?? [];
      list.push({ id: group.id, name: group.name });
      map.set(id, list);
    }
  return map;
}
