import { useMemo, useState } from "react";
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
import { type Device, type Group, type Policy, type User } from "./api";
import { roleAllows } from "./roleAccess";
import { DataTable, TableCard, type TableColumn } from "./DataTable";
import { sortTableRows } from "./dataTableModel";
import {
  Button,
  EmptyState,
  FilterChips,
  InlineError,
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
import TargetDialog from "./TargetDialog";
import { dataPlaneIssues, deviceDisplayStatus } from "./status";
import { formatRate, healthLabels, type HealthBucket } from "./overviewModel";
import {
  deviceViews,
  freshFlow,
  freshRate,
  groupsByDevice,
  isDeviceView,
  matchesStatus,
  matchesView,
  searchText,
  statusFilterValues,
  statusRank,
  versionLabel,
  versionMarker,
  type DeviceView,
  type VersionMarker,
} from "./deviceModel";
import "./devices.css";

type Navigate = (path: string) => void;
const PAGE_SIZES = [25, 50, 100];
const listDefaults = {
  q: "",
  view: "",
  status: "",
  version: "",
  group: "",
  page: 1,
  size: 25,
  sort: "name",
  dir: "asc",
};
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

export default function DeviceList({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: (message: string) => void;
  navigate: Navigate;
}) {
  const devices = useResource<Device[]>("/devices", []);
  const groups = useResource<Group[]>("/groups", []);
  const [query, update, reset] = useHashQuery(listDefaults);
  const [selected, setSelected] = useState<string[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const operate = roleAllows(user, "operate");
  const now = Date.now();
  const view = isDeviceView(query.view) ? (query.view as DeviceView) : "";
  const memberships = useMemo(() => groupsByDevice(groups.data), [groups.data]);
  const all = devices.data;
  const stale = !!devices.error;
  const term = query.q.trim().toLocaleLowerCase();
  const base = all.filter(
    (device) =>
      (!term ||
        searchText(
          device,
          (memberships.get(device.id) || []).map((group) => group.name),
        ).includes(term)) &&
      matchesStatus(device, query.status) &&
      (!query.version || device.desired_version_id === query.version) &&
      (!query.group ||
        (memberships.get(device.id) || []).some(
          (group) => group.id === query.group,
        )),
  );
  const filtered = sortTableRows(
    view ? base.filter((device) => matchesView(device, view, now)) : base,
    [
      { id: "name", value: (device) => device.name },
      { id: "status", value: statusRank },
      { id: "pipeline", value: (device) => versionLabel(device) },
      { id: "vector", value: (device) => device.vector_version || null },
      {
        id: "last_seen",
        value: (device) =>
          device.last_seen ? Date.parse(device.last_seen) : null,
      },
      { id: "events", value: (device) => freshRate(device, now) },
    ],
    {
      column: query.sort || "name",
      direction: query.dir === "desc" ? "desc" : "asc",
    },
  );
  const viewCounts = Object.fromEntries(
    deviceViews.map((item) => [
      item.value,
      base.filter((device) => matchesView(device, item.value, now)).length,
    ]),
  );
  const statusCounts = Object.fromEntries(
    statusFilterValues.map((value) => [
      value,
      all.filter((device) => matchesStatus(device, value)).length,
    ]),
  );
  const pageSize = PAGE_SIZES.includes(query.size) ? query.size : 25;
  const visibleStart = (query.page - 1) * pageSize;
  const visible = filtered.slice(visibleStart, visibleStart + pageSize);
  const operable = visible.filter((device) => device.status !== "revoked");
  const selectedIds = selected.filter((id) =>
    all.some((device) => device.id === id && device.status !== "revoked"),
  );
  const selectedDevices = all.filter((device) =>
    selectedIds.includes(device.id),
  );
  const sharedPolicy = selectedDevices[0]?.effective_policy;
  const preserveSettings =
    !!sharedPolicy &&
    selectedDevices.every(
      (device) =>
        device.effective_policy?.heartbeat_seconds ===
          sharedPolicy.heartbeat_seconds &&
        device.effective_policy?.telemetry_enabled ===
          sharedPolicy.telemetry_enabled,
    );
  const versionName = (id: string) => {
    const match = all.find((device) => device.desired_version_id === id);
    return match ? versionLabel(match) : `${id.slice(0, 8)}…`;
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
    query.group && {
      id: "group",
      label: `Group: ${groupName(query.group)}`,
      text: `Group ${groupName(query.group)}`,
      onRemove: () => update({ group: "", page: 1 }),
    },
  ].filter(Boolean) as FilterChip[];
  const filteredView =
    !!term || !!view || !!query.status || !!query.version || !!query.group;
  const firstRun = !devices.loading && !devices.error && all.length === 0;
  function toggle(id: string) {
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }
  const checkbox = (device: Device) => (
    <input
      aria-label={`Select ${device.name}`}
      type="checkbox"
      disabled={device.status === "revoked" || stale}
      checked={selectedIds.includes(device.id)}
      onChange={() => toggle(device.id)}
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
                  operable.every((device) => selectedIds.includes(device.id))
                }
                disabled={devices.loading || stale || !operable.length}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [
                          ...new Set([
                            ...selectedIds,
                            ...operable.map((device) => device.id),
                          ]),
                        ]
                      : selectedIds.filter(
                          (id) => !operable.some((device) => device.id === id),
                        ),
                  )
                }
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
      sortValue: (device) => device.name,
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
      sortValue: statusRank,
      filter: {
        value: query.status,
        onChange: (value) => update({ status: value, page: 1 }),
        manual: true,
        allLabel: "All states",
        options: statusFilterValues.map((value) => ({
          value,
          label: statusFilterLabel(value),
          count: statusCounts[value],
        })),
      },
      cell: (device) => (
        <StatusBadge domain="device" value={deviceDisplayStatus(device)} />
      ),
    },
    {
      id: "pipeline",
      header: "Pipeline",
      sortValue: (device) => versionLabel(device),
      cell: (device) => <VersionCell device={device} />,
    },
    {
      id: "vector",
      header: "Vector",
      width: 148,
      className: "device-col-optional",
      sortValue: (device) => device.vector_version || null,
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
        const list = memberships.get(device.id) || [];
        if (!list.length) return <span className="device-muted">None</span>;
        return (
          <span className="device-groups">
            {list.slice(0, 2).map((group) => (
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
            {list.length > 2 && (
              <span
                className="device-muted"
                title={list
                  .slice(2)
                  .map((group) => group.name)
                  .join(", ")}
              >
                +{list.length - 2}
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
      sortValue: (device) => freshRate(device, now),
      cell: (device) => <FlowCell device={device} now={now} />,
    },
    {
      id: "last_seen",
      header: "Last seen",
      width: 112,
      defaultDirection: "desc",
      sortValue: (device) =>
        device.last_seen ? Date.parse(device.last_seen) : null,
      cell: (device) => <TimeAgo value={device.last_seen} fallback="Never" />,
    },
  ];
  return (
    <div className="devices-page">
      <PageHeader
        title="Devices"
        description="Enrolled hosts, what they run and how they're doing."
        help={{ topic: "telemetry", label: "Help for Devices" }}
        live={{
          updatedAt: devices.updatedAt,
          error: devices.error,
          loading: devices.loading,
          refreshing: devices.refreshing,
          onRefresh: () => {
            void devices.reload();
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
      {devices.error && (
        <InlineError
          title={
            all.length ? "Couldn't refresh devices." : "Couldn't load devices."
          }
          error={devices.error}
          updatedAt={devices.updatedAt}
          retry={() => void devices.reload()}
          retrying={devices.refreshing}
        />
      )}
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
                value={query.q}
                onChange={(value) => update({ q: value, page: 1 })}
                placeholder="Search devices, labels, versions"
                label="Search devices"
                shortcut
              />
            }
            count={
              devices.loading && !devices.updatedAt
                ? undefined
                : filteredView
                  ? `${filtered.length.toLocaleString()} of ${all.length.toLocaleString()}`
                  : `${all.length.toLocaleString()} ${all.length === 1 ? "device" : "devices"}`
            }
            filters={
              <>
                <div className="devices-filter-row">
                  <QuickFilters
                    label="Quick filters"
                    options={deviceViews.map((item) => ({
                      value: item.value,
                      label: item.label,
                      count: viewCounts[item.value],
                    }))}
                    value={view}
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
          {selectedIds.length > 0 && operate && (
            <div
              className="devices-selection-bar"
              role="region"
              aria-label="Selected devices"
            >
              <strong>{selectedIds.length} selected</strong>
              <div className="devices-selection-bar-actions">
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
                <Button variant="ghost compact" onClick={() => setSelected([])}>
                  Clear selection
                </Button>
              </div>
              {!preserveSettings && (
                <p>
                  Select devices with the same check-in and metrics settings, or
                  pause them one at a time. Existing settings are preserved.
                </p>
              )}
            </div>
          )}
          <TableCard>
            <DataTable
              data={filtered}
              columns={columns}
              rowKey={(device) => device.id}
              label="Devices"
              className="devices-table"
              loading={devices.loading && !devices.updatedAt}
              sort={{
                column: query.sort || "name",
                direction: query.dir === "desc" ? "desc" : "asc",
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
              pagination={{
                page: query.page,
                size: pageSize,
                onPage: (page) => update({ page }),
                sizeOptions: PAGE_SIZES,
                onSize: (size) => update({ size, page: 1 }),
                noun: "devices",
              }}
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
                devices.error && !all.length ? (
                  <EmptyState
                    variant="error"
                    title="Devices couldn't be loaded"
                  >
                    {devices.error}
                  </EmptyState>
                ) : (
                  <EmptyState
                    variant="filtered"
                    title="No matching devices"
                    action={
                      <Button variant="secondary" onClick={() => reset()}>
                        Clear filters
                      </Button>
                    }
                  >
                    {view
                      ? `No device matches "${deviceViews.find((item) => item.value === view)?.label}" with the other filters.`
                      : "Try another name, label, version or state."}
                  </EmptyState>
                )
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
          initialDeviceIds={selectedIds}
          onDone={(message) => {
            notify(message);
            setSelected([]);
            void devices.reload();
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
