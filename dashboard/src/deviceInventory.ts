/**
 * The device inventory as lists, pickers and search read it: one page of
 * devices, counts for the filter chips, and every matching id for "select all
 * matching". A fleet is never downloaded to be read.
 */
import {
  api,
  withRequestDeadline,
  type Device,
  type DeviceInventoryIds,
  type DeviceInventoryPage,
} from "./api";

/** The most ids "select all matching" returns; the server sets this limit. */
export const SELECT_ALL_LIMIT = 10000;

/** The Devices page's address filters, and the paging and order that go with them. */
export type InventoryQuery = {
  q?: string;
  status?: string;
  view?: string;
  group?: string;
  /** The pipeline version a device is assigned. */
  version?: string;
  /** The pipeline version a device verifiably runs. */
  running?: string;
  sort?: string;
  dir?: string;
  page?: number;
  size?: number;
};

/** A page of the inventory, its rows typed as devices. */
export type InventoryPage = Omit<DeviceInventoryPage, "items"> & {
  items: Device[];
};

const emptyCounts: DeviceInventoryPage["counts"] = {
  status: {
    applied: 0,
    degraded: 0,
    updating: 0,
    check: 0,
    failed: 0,
    offline: 0,
    paused: 0,
    unmanaged: 0,
    revoked: 0,
  },
  views: {
    failing: 0,
    not_on_desired: 0,
    offline: 0,
    paused: 0,
    no_telemetry: 0,
  },
};
/** What a page reads as before its first answer. */
export function emptyInventory(page = 1, size = 50): InventoryPage {
  return {
    items: [],
    total: 0,
    page,
    page_size: size,
    counts: emptyCounts,
    device_groups: {},
  };
}

/** Address values the server names differently. */
const viewNames: Record<string, string> = { drift: "not_on_desired" };
const sortNames: Record<string, string> = {
  vector: "version",
  events: "events_in",
};

/** The filters and order alone: what "select all matching" repeats. */
export function inventoryFilters(query: InventoryQuery) {
  const params = new URLSearchParams();
  const set = (name: string, value?: string) => {
    if (value) params.set(name, value);
  };
  // The server matches on 100 characters at most.
  set("q", query.q?.trim().slice(0, 100));
  set("status", query.status);
  set("view", query.view && (viewNames[query.view] ?? query.view));
  set("group", query.group);
  set("desired_version", query.version);
  set("running_version", query.running);
  set("sort", query.sort && (sortNames[query.sort] ?? query.sort));
  if (query.sort) set("dir", query.dir);
  return params;
}
export function inventoryPath(query: InventoryQuery) {
  const params = inventoryFilters(query);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  params.set("page_size", String(query.size ?? 50));
  return `/devices/inventory?${params}`;
}
export function inventoryIdsPath(query: InventoryQuery) {
  return `/devices/inventory/ids?${inventoryFilters(query)}`;
}

/** Every device the filters match, up to the server's limit. */
export function readMatchingIds(
  query: InventoryQuery,
  signal?: AbortSignal,
): Promise<DeviceInventoryIds> {
  return withRequestDeadline(
    (inner) => api<DeviceInventoryIds>(inventoryIdsPath(query), { signal: inner }),
    30000,
    signal,
  );
}

/** What selecting the matches did, in words; the cap is never silent. */
export function selectionNote(found: DeviceInventoryIds) {
  if (found.truncated)
    return `Selected the first ${found.ids.length.toLocaleString()} of ${found.total.toLocaleString()} matching devices. Narrow the search to select the rest.`;
  if (found.total === 0) return "No devices match.";
  return found.total === 1
    ? "Selected the 1 matching device."
    : `Selected all ${found.total.toLocaleString()} matching devices.`;
}

/** A copy of `selected` with `ids` added. */
export function withIds(selected: ReadonlySet<string>, ids: Iterable<string>) {
  const next = new Set(selected);
  for (const id of ids) next.add(id);
  return next;
}
/** A copy of `selected` with one id switched on or off. */
export function toggled(selected: ReadonlySet<string>, id: string) {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}
/** How a set differs from the saved one: what was added and what was removed. */
export function setDifference(
  now: ReadonlySet<string>,
  saved: ReadonlySet<string>,
) {
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of now) if (!saved.has(id)) added.push(id);
  for (const id of saved) if (!now.has(id)) removed.push(id);
  return { added, removed };
}
