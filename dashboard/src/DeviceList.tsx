import { useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  Pause,
  Plus,
  Server,
  type LucideIcon,
} from "lucide-react";
import {
  inventoryStatuses,
  type Device,
  type GroupSummary,
  type Policy,
  type User,
} from "./api";
import { roleAllows } from "./roleAccess";
import { DataTable, TableCard, type TableColumn } from "./DataTable";
import {
  Button,
  EmptyState,
  FilterChips,
  PageHeader,
  PageToolbar,
  QuickFilters,
  SearchBox,
  Select,
  StatusBadge,
  TimeAgo,
  useResource,
  type FilterChip,
} from "./ui";
import { useHashQuery } from "./urlState";
import TargetDialog from "./LazyTargetDialog";
import { dataPlaneIssues, deviceDisplayStatus } from "./status";
import { formatRate, healthLabels, type HealthBucket } from "./overviewModel";
import {
  deviceViews,
  freshFlow,
  isDeviceView,
  versionLabel,
  versionMarker,
  type DeviceView,
  type VersionMarker,
} from "./deviceModel";
import {
  inventoryPath,
  readMatchingIds,
  searchText,
  selectionNote,
  type InventoryQuery,
} from "./deviceInventory";
import { useInventory } from "./useInventory";
import "./devices.css";
import type { Notify } from "./toast";

type Navigate = (path: string) => void;
const PAGE_SIZES = [25, 50, 100];
const SORTS = ["name", "status", "pipeline", "vector", "events", "last_seen"];
const listDefaults = {
  q: "",
  view: "",
  status: "",
  version: "",
  running: "",
  group: "",
  page: 1,
  size: 25,
  sort: "name",
  dir: "asc",
};
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const markerIcons: Record<VersionMarker["icon"], LucideIcon> = {
  check: CircleCheck,
  clock: Clock3,
  x: CircleX,
  question: CircleHelp,
  pause: Pause,
};
const statusFilterLabel = (value: string) =>
  value === "revoked"
    ? "Revoked"
    : healthLabels[value as HealthBucket] || value;
const platform = (device: Device) =>
  [device.os, device.arch].filter(Boolean).join(" / ") ||
  "Platform not reported";
/** The server's name for a quick view. */
const viewKey = (view: DeviceView) =>
  view === "drift" ? "not_on_desired" : view;

export function VersionCell({ device }: { device: Device }) {
  const label = versionLabel(device);
  const marker = versionMarker(device);
  if (!label) return <span className="device-muted">No pipeline</span>;
  const pipeline = device.desired_version?.configuration_id;
  const name = device.desired_version?.configuration_name || label;
  const number = device.desired_version?.number;
  const Icon = marker ? markerIcons[marker.icon] : null;
  return (
    <span className="device-version">
      {pipeline ? (
        <a
          className="device-version-name"
          href={`#/configurations/${encodeURIComponent(pipeline)}`}
          title={label}
        >
          {name}
        </a>
      ) : (
        <span className="device-version-name" title={label}>
          {name}
        </span>
      )}
      <span className="device-version-line">
        {typeof number === "number" && (
          <span className="device-version-number">v{number}</span>
        )}
        {marker && Icon && (
          <span className="device-version-marker" data-tone={marker.tone}>
            <Icon size={12} aria-hidden="true" />
            {marker.text}
          </span>
        )}
      </span>
    </span>
  );
}

/** Devices picked across pages: their ids, and the rows seen for them. */
type Selection = {
  ids: ReadonlySet<string>;
  rows: ReadonlyMap<string, Device>;
  /** What the last "select all matching" did, in words. */
  note: string;
};
const noSelection: Selection = { ids: new Set(), rows: new Map(), note: "" };

export default function DeviceList({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: Notify;
  navigate: Navigate;
}) {
  const groups = useResource<GroupSummary[]>("/groups?slim=1", [], 0, {
    interval: 60000,
  });
  const [url, update, reset] = useHashQuery(listDefaults);
  const [selection, setSelection] = useState<Selection>(noSelection);
  const [matching, setMatching] = useState<{
    busy: boolean;
    error: string;
    /** The filters whose matches were all selected. */
    done: string;
  }>({ busy: false, error: "", done: "" });
  const [policy, setPolicy] = useState<Policy | null>(null);
  const operate = roleAllows(user, "operate");
  // Anything a hand-edited link gets wrong falls back to the default.
  const query = {
    q: url.q,
    view: isDeviceView(url.view) ? (url.view as DeviceView) : "",
    status: (inventoryStatuses as readonly string[]).includes(url.status)
      ? url.status
      : "",
    version: isUuid(url.version) ? url.version : "",
    running: isUuid(url.running) ? url.running : "",
    group: isUuid(url.group) ? url.group : "",
    sort: SORTS.includes(url.sort) ? url.sort : "name",
    dir: url.dir === "desc" ? "desc" : "asc",
  };
  const pageSize = PAGE_SIZES.includes(url.size) ? url.size : 25;
  const filters: InventoryQuery = query;
  const request: InventoryQuery = {
    ...filters,
    page: url.page,
    size: pageSize,
  };
  const { resource: inventory, data, loaded, settling } = useInventory(request);
  const stale = !!inventory.error;
  // Typing settles for a moment before it becomes the address's search; a new
  // search from the address (Back, a shared link) replaces what the box shows.
  const [search, setSearch] = useState(url.q);
  const [urlSearch, setUrlSearch] = useState(url.q);
  if (urlSearch !== url.q) {
    setUrlSearch(url.q);
    if (search.trim() !== url.q) setSearch(url.q);
  }
  useEffect(() => {
    if (search.trim() === url.q) return;
    const timer = window.setTimeout(
      () => update({ q: searchText(search), page: 1 }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search, url.q, update]);
  // A page past the end (devices removed meanwhile, an old link) moves back.
  const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
  useEffect(() => {
    if (!inventory.loading && !inventory.error && url.page > lastPage)
      update({ page: lastPage });
  }, [inventory.loading, inventory.error, url.page, lastPage, update]);
  const rows = data.items;
  const operable = rows.filter((device) => device.status !== "revoked");
  const counts = data.counts;
  const filtered =
    !!query.q ||
    !!query.view ||
    !!query.status ||
    !!query.version ||
    !!query.running ||
    !!query.group;
  const firstRun =
    loaded &&
    !inventory.error &&
    data.total === 0 &&
    !filtered &&
    counts.status.revoked === 0;
  const selectedRows = [...selection.rows.values()];
  const sharedPolicy = selectedRows[0]?.effective_policy;
  const preserveSettings =
    !!sharedPolicy &&
    selectedRows.every(
      (device) =>
        device.effective_policy?.heartbeat_seconds ===
          sharedPolicy.heartbeat_seconds &&
        device.effective_policy?.telemetry_enabled ===
          sharedPolicy.telemetry_enabled,
    );
  // The rows on this page name a version; a link to a version not on it
  // shows a short id until one is.
  const versionName = (id: string, running = false) => {
    const match = rows.find((device) =>
      running
        ? device.running_version?.id === id
        : device.desired_version_id === id,
    );
    if (match && running && match.running_version) {
      const { configuration_name: name, number } = match.running_version;
      return [name, number ? `v${number}` : ""].filter(Boolean).join(" ");
    }
    return match && !running ? versionLabel(match) : `${id.slice(0, 8)}…`;
  };
  const groupName = (id: string) =>
    groups.data.find((group) => group.id === id)?.name ||
    (groups.loading ? "Loading…" : "Unknown group");
  const chips: FilterChip[] = [
    query.status && {
      id: "status",
      label: `Status: ${statusFilterLabel(query.status)}`,
      text: `Status ${statusFilterLabel(query.status)}`,
      onRemove: () => update({ status: "", page: 1 }),
    },
    query.version && {
      id: "version",
      label: `Version: ${versionName(query.version)}`,
      text: `Version ${versionName(query.version)}`,
      onRemove: () => update({ version: "", page: 1 }),
    },
    query.running && {
      id: "running",
      label: `Running: ${versionName(query.running, true)}`,
      text: `Running ${versionName(query.running, true)}`,
      onRemove: () => update({ running: "", page: 1 }),
    },
    query.group && {
      id: "group",
      label: `Group: ${groupName(query.group)}`,
      text: `Group ${groupName(query.group)}`,
      onRemove: () => update({ group: "", page: 1 }),
    },
  ].filter(Boolean) as FilterChip[];

  function toggle(device: Device) {
    setSelection((previous) => {
      const ids = new Set(previous.ids);
      const known = new Map(previous.rows);
      if (ids.delete(device.id)) known.delete(device.id);
      else {
        ids.add(device.id);
        known.set(device.id, device);
      }
      return { ids, rows: known, note: "" };
    });
    setMatching((previous) => ({ ...previous, done: "" }));
  }
  function togglePage(on: boolean) {
    setSelection((previous) => {
      const ids = new Set(previous.ids);
      const known = new Map(previous.rows);
      for (const device of operable) {
        if (on) {
          ids.add(device.id);
          known.set(device.id, device);
        } else {
          ids.delete(device.id);
          known.delete(device.id);
        }
      }
      return { ids, rows: known, note: "" };
    });
    setMatching((previous) => ({ ...previous, done: "" }));
  }
  const matchKey = inventoryPath({ ...filters, page: 1, size: 1 });
  const matchRequest = useRef<AbortController | null>(null);
  useEffect(() => () => matchRequest.current?.abort(), []);
  /** Every device the current filters match, not only this page. */
  async function selectMatching() {
    matchRequest.current?.abort();
    const controller = new AbortController();
    matchRequest.current = controller;
    setMatching({ busy: true, error: "", done: "" });
    try {
      const found = await readMatchingIds(filters, controller.signal);
      if (controller.signal.aborted) return;
      const onPage = new Map(operable.map((device) => [device.id, device]));
      setSelection((previous) => {
        const ids = new Set(previous.ids);
        const known = new Map(previous.rows);
        for (const id of found.ids) {
          ids.add(id);
          const row = onPage.get(id);
          if (row) known.set(id, row);
        }
        return { ids, rows: known, note: selectionNote(found) };
      });
      setMatching({ busy: false, error: "", done: matchKey });
    } catch (failure) {
      if (controller.signal.aborted) return;
      setMatching({
        busy: false,
        error: `Couldn't select the matching devices. ${(failure as Error).message}`,
        done: "",
      });
    }
  }
  const now = Date.now();
  const checkbox = (device: Device) => (
    <input
      aria-label={`Select ${device.name}`}
      type="checkbox"
      disabled={device.status === "revoked" || stale || settling}
      checked={selection.ids.has(device.id)}
      onChange={() => toggle(device)}
    />
  );
  const columns: TableColumn<Device>[] = [
    ...(operate
      ? [
          {
            id: "select",
            label: "Select devices",
            className: "device-check",
            headerClassName: "device-check",
            width: 44,
            header: (
              <input
                aria-label="Select visible devices"
                type="checkbox"
                checked={
                  operable.length > 0 &&
                  operable.every((device) => selection.ids.has(device.id))
                }
                disabled={!loaded || stale || settling || operable.length === 0}
                onChange={(event) => togglePage(event.target.checked)}
              />
            ),
            cell: checkbox,
          },
        ]
      : []),
    {
      id: "name",
      header: "Device",
      width: "22%",
      sortable: true,
      cell: (device) => (
        <span className="device-name-cell">
          <a
            className="device-name"
            href={`#/devices/${encodeURIComponent(device.id)}`}
          >
            {device.name}
          </a>
          <small>{platform(device)}</small>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: 164,
      sortable: true,
      filter: {
        value: query.status,
        onChange: (value) => update({ status: value, page: 1 }),
        manual: true,
        allLabel: "All states",
        options: inventoryStatuses.map((value) => ({
          value,
          label: statusFilterLabel(value),
          // No counts until a read succeeds: never a fake zero.
          count: loaded ? counts.status[value] : undefined,
        })),
      },
      cell: (device) => (
        <StatusBadge domain="device" value={deviceDisplayStatus(device)} />
      ),
    },
    {
      id: "pipeline",
      header: "Pipeline",
      sortable: true,
      cell: (device) => <VersionCell device={device} />,
    },
    {
      id: "vector",
      header: "Vector",
      width: 148,
      className: "device-col-optional",
      sortable: true,
      cell: (device) => (
        <span className="device-stack">
          <span>{device.vector_version || "Not reported"}</span>
          <small>
            {device.agent_version
              ? `Agent ${device.agent_version}`
              : "Agent not reported"}
          </small>
        </span>
      ),
    },
    {
      id: "groups",
      header: "Groups",
      width: 168,
      className: "device-col-optional",
      cell: (device) => {
        const held = data.device_groups[device.id];
        if (!held?.total) return <span className="device-muted">None</span>;
        return (
          <span className="device-groups">
            {held.items.slice(0, 2).map((group) => (
              <button
                key={group.id}
                type="button"
                className="device-group-chip"
                title={`Show devices in ${group.name}`}
                onClick={() => update({ group: group.id, page: 1 })}
              >
                {group.name}
              </button>
            ))}
            {held.total > 2 && (
              <span
                className="device-muted"
                title={
                  held.items
                    .slice(2)
                    .map((group) => group.name)
                    .join(", ") +
                  (held.total > held.items.length
                    ? ` and ${held.total - held.items.length} more`
                    : "")
                }
              >
                +{held.total - 2}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "events",
      header: "In → Out /s",
      width: 128,
      className: "device-number",
      defaultDirection: "desc",
      sortable: true,
      cell: (device) => <FlowCell device={device} now={now} />,
    },
    {
      id: "last_seen",
      header: "Last seen",
      width: 112,
      defaultDirection: "desc",
      sortable: true,
      cell: (device) => <TimeAgo value={device.last_seen} fallback="Never" />,
    },
  ];
  const totalText = filtered
    ? `${data.total.toLocaleString()} matching`
    : `${data.total.toLocaleString()} ${data.total === 1 ? "device" : "devices"}`;
  // "Select all" is for devices beyond this page; revoked ones can't be picked.
  const offerMatching =
    data.total > rows.length &&
    query.status !== "revoked" &&
    matching.done !== matchKey;
  return (
    <div className="devices-page">
      <PageHeader
        title="Devices"
        description="Enrolled hosts, what they run and how they're doing."
        help={{ topic: "telemetry", label: "Help for Devices" }}
        live={{
          updatedAt: inventory.updatedAt,
          error: inventory.error,
          loading: inventory.loading,
          refreshing: inventory.refreshing,
          onRefresh: () => {
            void inventory.reload();
            void groups.reload();
          },
        }}
      >
        {operate && !firstRun && (
          <Button icon={Plus} onClick={() => navigate("enrollment")}>
            Add device
          </Button>
        )}
      </PageHeader>
      {firstRun ? (
        <TableCard>
          <EmptyState
            icon={Server}
            title="No devices yet"
            action={
              operate ? (
                <Button icon={Plus} onClick={() => navigate("enrollment")}>
                  Add device
                </Button>
              ) : undefined
            }
            learnMore={{
              topic: "installation",
              label: "How to install the agent",
            }}
          >
            {operate
              ? "Install the agent on a host running Vector and enroll it with a one-time token. Devices appear here with their pipeline and health."
              : "An operator enrolls devices. They appear here with their pipeline and health."}
          </EmptyState>
        </TableCard>
      ) : (
        <>
          <PageToolbar
            search={
              <SearchBox
                value={search}
                onChange={setSearch}
                maxLength={100}
                placeholder="Search devices, pipelines, versions"
                label="Search devices"
                shortcut
              />
            }
            count={loaded && !inventory.error ? totalText : undefined}
            filters={
              <>
                <div className="devices-filter-row">
                  <QuickFilters
                    label="Quick filters"
                    options={deviceViews.map((item) => ({
                      value: item.value,
                      label: item.label,
                      hint: item.hint,
                      // No counts until a read succeeds: never a fake zero.
                      count: loaded
                        ? counts.views[
                            viewKey(item.value) as keyof typeof counts.views
                          ]
                        : undefined,
                    }))}
                    value={query.view}
                    onChange={(value) => update({ view: value, page: 1 })}
                  />
                  {groups.data.length > 0 && (
                    <Select
                      aria-label="Filter by group"
                      value={query.group}
                      onChange={(event) =>
                        update({ group: event.target.value, page: 1 })
                      }
                    >
                      <option value="">All groups</option>
                      {groups.data.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
                <FilterChips chips={chips} onClearAll={() => reset()} />
              </>
            }
          />
          {selection.ids.size > 0 && operate && (
            <div
              className="devices-selection-bar"
              role="region"
              aria-label="Selected devices"
            >
              <strong>{selection.ids.size.toLocaleString()} selected</strong>
              <div className="devices-selection-bar-actions">
                {offerMatching && (
                  <Button
                    variant="secondary compact"
                    busy={matching.busy}
                    disabled={stale || settling}
                    onClick={() => void selectMatching()}
                  >
                    Select all {data.total.toLocaleString()} matching
                  </Button>
                )}
                <Button
                  variant="secondary compact"
                  disabled={!preserveSettings || stale}
                  onClick={() =>
                    sharedPolicy &&
                    setPolicy({ ...sharedPolicy, sync_paused: true })
                  }
                >
                  Pause sync…
                </Button>
                <Button
                  variant="secondary compact"
                  disabled={!preserveSettings || stale}
                  onClick={() =>
                    sharedPolicy &&
                    setPolicy({ ...sharedPolicy, sync_paused: false })
                  }
                >
                  Resume sync…
                </Button>
                <Button
                  variant="ghost compact"
                  onClick={() => {
                    setSelection(noSelection);
                    setMatching({ busy: false, error: "", done: "" });
                  }}
                >
                  Clear selection
                </Button>
              </div>
              {matching.error ? (
                <p role="alert">{matching.error}</p>
              ) : selection.note ? (
                <p role="status">{selection.note}</p>
              ) : null}
              {!preserveSettings && selectedRows.length > 0 && (
                <p>
                  Select devices with the same check-in and metrics settings, or
                  pause them one at a time. Existing settings are preserved.
                </p>
              )}
            </div>
          )}
          <TableCard className={settling ? "table-card-settling" : ""}>
            <DataTable
              data={rows}
              columns={columns}
              rowKey={(device) => device.id}
              label="Devices"
              error={
                inventory.error
                  ? {
                      title: inventory.updatedAt
                        ? "Couldn't refresh devices."
                        : "Couldn't load devices.",
                      message: inventory.error,
                      updatedAt: inventory.updatedAt,
                      retry: () => void inventory.reload(),
                      retrying: inventory.refreshing,
                    }
                  : null
              }
              className="devices-table"
              loading={inventory.loading}
              sort={{
                column: query.sort,
                direction: query.dir as "asc" | "desc",
              }}
              onSortChange={(next) =>
                update({
                  sort: next?.column || "name",
                  dir: next?.direction || "asc",
                  page: 1,
                })
              }
              manualSorting
              rowHref={(device) => `#/devices/${encodeURIComponent(device.id)}`}
              rowAttributes={(device) =>
                device.status === "revoked" ? { "data-revoked": "" } : {}
              }
              pagination={
                inventory.error && !loaded
                  ? undefined
                  : {
                      page: url.page,
                      size: pageSize,
                      total: data.total,
                      onPage: (page) => update({ page }),
                      sizeOptions: PAGE_SIZES,
                      onSize: (size) => update({ size, page: 1 }),
                      noun: "devices",
                    }
              }
              mobileCard={(device) => ({
                title: device.name,
                href: `#/devices/${encodeURIComponent(device.id)}`,
                leading: operate ? checkbox(device) : undefined,
                status: (
                  <StatusBadge
                    domain="device"
                    value={deviceDisplayStatus(device)}
                  />
                ),
                meta: [
                  versionLabel(device) || "No pipeline",
                  device.last_seen ? (
                    <>
                      Seen <TimeAgo value={device.last_seen} />
                    </>
                  ) : (
                    "Never connected"
                  ),
                  flowText(device, now),
                ],
              })}
              empty={
                <EmptyState
                  variant="filtered"
                  title="No matching devices"
                  action={
                    <Button variant="secondary" onClick={() => reset()}>
                      Clear filters
                    </Button>
                  }
                >
                  {query.view
                    ? `No device matches "${deviceViews.find((item) => item.value === query.view)?.label}" with the other filters.`
                    : "Try another name, pipeline, version or state."}
                </EmptyState>
              }
            />
          </TableCard>
        </>
      )}
      {policy && operate && (
        <TargetDialog
          key={user.id}
          open
          userId={user.id}
          onClose={() => setPolicy(null)}
          policy={policy}
          preserveExistingSettings
          initialDeviceIds={[...selection.ids]}
          initialDevices={selectedRows}
          onDone={(message) => {
            notify(message, { tone: "success" });
            setSelection(noSelection);
            void inventory.reload();
          }}
        />
      )}
    </div>
  );
}

/** "5.0 → 4.9 events/s", or null without a fresh sample. */
function flowText(device: Device, now: number) {
  const flow = freshFlow(device, now);
  if (!flow) return null;
  return flow.out === null
    ? `${formatRate(flow.in)} events/s in`
    : `${formatRate(flow.in)} → ${formatRate(flow.out)} events/s`;
}

/** Events in and delivered per second. Delivery reads red while degraded. */
function FlowCell({ device, now }: { device: Device; now: number }) {
  const flow = freshFlow(device, now);
  if (!flow)
    return (
      <span className="device-muted" title="No metrics in the last 3 minutes">
        —
      </span>
    );
  const degraded = dataPlaneIssues(device).length > 0;
  return (
    <span
      className="device-flow"
      title={
        flow.out === null
          ? `${formatRate(flow.in)} events/s in. This agent doesn't report delivery.`
          : `${formatRate(flow.in)} events/s in, ${formatRate(flow.out)} events/s delivered`
      }
    >
      <span>{formatRate(flow.in)}</span>
      <span className="device-flow-arrow" aria-hidden="true">
        →
      </span>
      <span
        className="device-flow-out"
        data-tone={degraded ? "danger" : undefined}
      >
        {flow.out === null ? "—" : formatRate(flow.out)}
      </span>
    </span>
  );
}
