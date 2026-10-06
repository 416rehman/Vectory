/**
 * The devices that run a pipeline now, for a deployment to start from: they
 * are the ones a new version updates. The server counts them per version
 * (the pipeline's telemetry) and lists them per version (the device inventory,
 * a page of rows or every id), so a fleet is never downloaded to find them.
 */
import { api, withRequestDeadline, type Device } from "./api";
import {
  inventoryPath,
  readMatchingIds,
  SELECT_ALL_LIMIT,
  type InventoryPage,
} from "./deviceInventory";
import type { PipelineTelemetry } from "./liveGraph";

/** Devices read with their rows: what one page of the inventory holds. */
export const NAMED_LIMIT = 100;
/** Versions of one pipeline looked at, newest first. */
export const VERSIONS_LIMIT = 10;
/** Versions and groups named in a sentence before "and N more". */
const NAMED_IN_SENTENCE = 3;

/** A version of the pipeline and the devices that run it. */
export type RunningVersion = {
  id: string;
  number: number | null;
  devices: number;
};

export type RunningDevices = {
  ids: string[];
  /** Devices that run the pipeline, which can exceed `ids` at the limit. */
  total: number;
  /** `ids` stops short: the server's limit, or versions beyond the first ten. */
  truncated: boolean;
  /** The devices' rows, when they all fit on one page. */
  rows: Device[];
  /** The versions they run, oldest first. */
  versions: RunningVersion[];
  /** Groups that hold every one of these devices, by name. */
  groups: string[];
};

export const noRunningDevices: RunningDevices = {
  ids: [],
  total: 0,
  truncated: false,
  rows: [],
  versions: [],
  groups: [],
};

/** The versions a device runs now, newest first, from the pipeline's telemetry. */
export function runningVersions(
  telemetry: Pick<PipelineTelemetry, "versions">,
): RunningVersion[] {
  return (telemetry.versions ?? [])
    .filter((entry) => entry.devices_running > 0)
    .map((entry) => ({
      id: entry.version_id,
      number: entry.version_number,
      devices: entry.devices_running,
    }))
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
}

/** Names of the groups that hold every one of the devices. */
export function commonGroups(
  rows: readonly Pick<Device, "id">[],
  groups: Readonly<Record<string, { items: { name: string }[] }>>,
): string[] {
  if (!rows.length) return [];
  let shared: string[] | null = null;
  for (const row of rows) {
    const names = (groups[row.id]?.items ?? []).map((group) => group.name);
    shared = shared
      ? shared.filter((name) => names.includes(name))
      : [...new Set(names)];
    if (!shared.length) return [];
  }
  return (shared ?? []).sort((a, b) => a.localeCompare(b));
}

const listed = (names: string[], noun: string) =>
  names.length <= NAMED_IN_SENTENCE
    ? names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names.join("")
    : `${names.slice(0, NAMED_IN_SENTENCE).join(", ")} and ${(
        names.length - NAMED_IN_SENTENCE
      ).toLocaleString()} more ${noun}`;

/** "v1", "v1 and v2", "v1, v2 and v3": the versions the devices run. */
export function versionsLabel(versions: readonly RunningVersion[]): string {
  const numbered = versions
    .filter((version) => version.number !== null)
    .map((version) => `v${version.number}`);
  const unnamed = versions.length - numbered.length;
  if (!numbered.length) return unnamed ? "an earlier version" : "";
  return unnamed
    ? `${listed(numbered, "versions")} and ${unnamed} more`
    : listed(numbered, "versions");
}

/**
 * "Update the 3 devices running v1 (Edge collectors)": what a deployment
 * that starts from the running devices does, and where those devices are.
 */
export function runningSummary({
  total,
  versions,
  groups,
}: Pick<RunningDevices, "total" | "versions" | "groups">): string {
  const devices =
    total === 1 ? "the device" : `the ${total.toLocaleString()} devices`;
  const running = versionsLabel(versions);
  return `Update ${devices} ${running ? `running ${running}` : "that run this pipeline"}${
    groups.length ? ` (${listed(groups, "groups")})` : ""
  }`;
}

const deadline = <T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) => withRequestDeadline(request, 20000, signal);

/**
 * Every device that runs a version of this pipeline. A few devices come with
 * their rows, to be named; more come as ids alone, as "select all matching"
 * reads them, up to the server's limit.
 */
export async function readRunningDevices(
  configurationId: string,
  signal?: AbortSignal,
): Promise<RunningDevices> {
  const telemetry = await deadline(
    (inner) =>
      api<PipelineTelemetry>(
        `/configurations/${encodeURIComponent(configurationId)}/telemetry`,
        { signal: inner },
      ),
    signal,
  );
  if (
    telemetry.configuration_id &&
    telemetry.configuration_id !== configurationId
  )
    return noRunningDevices;
  const all = runningVersions(telemetry);
  const read = all.slice(0, VERSIONS_LIMIT);
  const counted = read.reduce((sum, version) => sum + version.devices, 0);
  if (!counted) return noRunningDevices;
  const versions = [...read].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const skipped = all.length > read.length;
  if (counted <= NAMED_LIMIT) {
    const pages = await Promise.all(
      read.map((version) =>
        deadline(
          (inner) =>
            api<InventoryPage>(
              inventoryPath({
                running: version.id,
                sort: "name",
                dir: "asc",
                size: NAMED_LIMIT,
              }),
              { signal: inner },
            ),
          signal,
        ),
      ),
    );
    // A page that held fewer rows than the server counted means devices
    // arrived since the count; the ids below read them all.
    if (pages.every((page) => page.total <= page.items.length)) {
      const rows = [
        ...new Map(
          pages.flatMap((page) => page.items).map((row) => [row.id, row]),
        ).values(),
      ];
      const groups = Object.assign(
        {},
        ...pages.map((page) => page.device_groups),
      );
      return {
        ids: rows.map((row) => row.id),
        total: rows.length,
        truncated: skipped,
        rows,
        versions,
        groups: commonGroups(rows, groups),
      };
    }
  }
  const found = await Promise.all(
    read.map((version) => readMatchingIds({ running: version.id }, signal)),
  );
  const ids = [...new Set(found.flatMap((entry) => entry.ids))];
  const total = found.reduce((sum, entry) => sum + entry.total, 0);
  return {
    ids: ids.slice(0, SELECT_ALL_LIMIT),
    total,
    truncated:
      skipped ||
      found.some((entry) => entry.truncated) ||
      ids.length > SELECT_ALL_LIMIT,
    rows: [],
    versions,
    groups: [],
  };
}
