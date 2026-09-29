import { useEffect, useMemo, useState } from "react";
import { Layers, Plus } from "lucide-react";
import GroupEditor from "./GroupEditor";
import { GroupRecovery } from "./GroupRecovery";
import { useGroupOperations } from "./groupRequests";
import { DataTable, TableCard, type TableColumn } from "./DataTable";
import { sortTableRows } from "./dataTableModel";
import { type Device, type Group, type User } from "./api";
import { roleAllows } from "./roleAccess";
import {
  Button,
  EmptyState,
  PageHeader,
  PageToolbar,
  SearchBox,
  Tooltip,
  useResource,
} from "./ui";
import { useHashQuery } from "./urlState";
import { useCommand } from "./commands";
import {
  countLabel,
  healthCounts,
  healthLabels,
  healthOrder,
} from "./overviewModel";
import DeviceList from "./DeviceList";
import DeviceDetail from "./DeviceDetail";
import "./fleet.css";
import "./devices.css";
import type { Notify } from "./toast";

type Navigate = (path: string) => void;

export { Overview } from "./Overview";

export function Devices({
  user,
  notify,
  navigate,
  deviceId,
}: {
  user: User;
  notify: Notify;
  navigate: Navigate;
  deviceId?: string;
}) {
  if (deviceId)
    return (
      <DeviceDetail
        key={deviceId}
        user={user}
        notify={notify}
        navigate={navigate}
        id={deviceId}
      />
    );
  return <DeviceList user={user} notify={notify} navigate={navigate} />;
}

/** A compact health bar for a group's members, with a text summary. */
function MemberHealth({ devices }: { devices: Device[] }) {
  const { counts, total } = healthCounts(devices);
  if (!total) return <span className="device-muted">No members</span>;
  const shown = healthOrder.filter((bucket) => counts[bucket] > 0);
  const summary = shown
    .map((bucket) => `${counts[bucket]} ${healthLabels[bucket].toLowerCase()}`)
    .join(", ");
  return (
    <span className="member-health">
      <span className="member-health-bar" role="img" aria-label={summary}>
        {shown.map((bucket) => (
          <Tooltip
            key={bucket}
            content={`${healthLabels[bucket]} · ${countLabel(counts[bucket], "device")}`}
          >
            <span
              className="health-bar-segment"
              data-bucket={bucket}
              style={{ flexGrow: counts[bucket] }}
            />
          </Tooltip>
        ))}
      </span>
      <small>
        {counts.applied === total
          ? "All applied"
          : shown
              .filter((bucket) => bucket !== "applied")
              .slice(0, 2)
              .map(
                (bucket) =>
                  `${counts[bucket]} ${healthLabels[bucket].toLowerCase()}`,
              )
              .join(" · ")}
      </small>
    </span>
  );
}

const groupDefaults = {
  q: "",
  members: "",
  page: 1,
  size: 25,
  sort: "group",
  dir: "asc",
};
const GROUP_PAGE_SIZES = [25, 50, 100];

export function Groups({ user, notify }: { user: User; notify: Notify }) {
  const groups = useResource<Group[]>("/groups", []),
    devices = useResource<Device[]>("/devices", []);
  const groupRequests = useGroupOperations(user.id);
  const createBlocked =
    groupRequests.operations.length > 0 || groupRequests.errors.length > 0;
  const [query, update, reset] = useHashQuery(groupDefaults);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Group | null>(null),
    [savedGroup, setSavedGroup] = useState<Group | null>(null);
  const allowed = roleAllows(user, "operate");
  const pageSize = GROUP_PAGE_SIZES.includes(query.size) ? query.size : 25;
  const sort = {
    column: query.sort || "group",
    direction: (query.dir === "desc" ? "desc" : "asc") as "asc" | "desc",
  };
  const byId = useMemo(
    () => new Map(devices.data.map((device) => [device.id, device])),
    [devices.data],
  );
  const sortGroups = (rows: Group[]) =>
    sortTableRows(
      rows,
      [
        { id: "group", value: (group) => group.name },
        { id: "members", value: (group) => group.device_ids.length },
      ],
      sort,
    );
  const matches = (group: Group, text: string) =>
    `${group.name} ${group.description}`
      .toLowerCase()
      .includes(text.trim().toLowerCase());
  const filtered = sortGroups(
    groups.data.filter(
      (group) =>
        matches(group, query.q) &&
        (!query.members ||
          (query.members === "empty"
            ? group.device_ids.length === 0
            : group.device_ids.length > 0)),
    ),
  );
  useEffect(() => {
    if (!savedGroup) return;
    // Wait for the server's saved record before locating its sorted page.
    // An old row may still exist while a rename or membership refresh is pending.
    const refreshed = groups.data.find(
      (group) =>
        group.id === savedGroup.id &&
        group.name === savedGroup.name &&
        group.description === savedGroup.description &&
        JSON.stringify(group.device_ids) ===
          JSON.stringify(savedGroup.device_ids),
    );
    if (!refreshed) return;
    const q = matches(refreshed, query.q) ? query.q : "";
    const visible = sortGroups(
      groups.data.filter((group) => matches(group, q)),
    );
    update({
      q,
      members: "",
      page:
        Math.floor(
          visible.findIndex((group) => group.id === savedGroup.id) / pageSize,
        ) + 1,
    });
    setSavedGroup(null);
  }, [groups.data, savedGroup]);
  function edit(group?: Group) {
    if (!group && createBlocked) return;
    setEditing(group || null);
    setOpen(true);
  }
  useCommand("group.create", () => edit(), allowed && !createBlocked);
  const firstRun = !groups.loading && !groups.error && groups.data.length === 0;
  const memberHealth = (group: Group) => (
    <MemberHealth
      devices={
        group.device_ids.map((id) => byId.get(id)).filter(Boolean) as Device[]
      }
    />
  );
  const columns: TableColumn<Group>[] = [
    {
      id: "group",
      header: "Group",
      sortValue: (group) => group.name,
      cell: (group) => (
        <span className="device-name-cell">
          <button
            type="button"
            className="groups-name"
            onClick={() => edit(group)}
          >
            {group.name}
          </button>
          {group.description && <small>{group.description}</small>}
        </span>
      ),
    },
    {
      id: "members",
      header: "Members",
      width: 260,
      sortValue: (group) => group.device_ids.length,
      filter: {
        value: query.members,
        onChange: (value) => update({ members: value, page: 1 }),
        manual: true,
        options: [
          {
            value: "empty",
            label: "No members",
            count: groups.data.filter((group) => !group.device_ids.length)
              .length,
          },
          {
            value: "populated",
            label: "Has members",
            count: groups.data.filter((group) => group.device_ids.length)
              .length,
          },
        ],
      },
      cell: (group) => {
        const names = group.device_ids
          .map((id) => byId.get(id)?.name)
          .filter(Boolean) as string[];
        return (
          <span className="device-stack">
            <span className="groups-member-count">
              {countLabel(group.device_ids.length, "device")}
            </span>
            {names.length > 0 && (
              <small>
                {names.slice(0, 3).join(", ")}
                {group.device_ids.length > 3
                  ? ` +${group.device_ids.length - 3} more`
                  : ""}
              </small>
            )}
          </span>
        );
      },
    },
    {
      id: "health",
      header: "Member health",
      width: 220,
      cell: memberHealth,
    },
    {
      id: "manage",
      header: <span className="sr-only">Manage group</span>,
      label: "Manage group",
      width: 128,
      className: "groups-manage",
      cell: (group) => (
        <a
          className="groups-devices-link"
          href={`#/devices?group=${encodeURIComponent(group.id)}`}
        >
          View devices
        </a>
      ),
    },
  ];
  return (
    <div className="groups-page">
      <PageHeader
        title="Groups"
        help={{
          topic: "deployments",
          section: "review-changes-to-a-group",
          label: "Help for Groups",
        }}
        description="Group devices to deploy a pipeline or agent settings together."
        live={{
          updatedAt: groups.updatedAt,
          error: groups.error,
          loading: groups.loading,
          refreshing: groups.refreshing,
          onRefresh: () => {
            void groups.reload();
            void devices.reload();
          },
        }}
      >
        {allowed && !firstRun && (
          <Button icon={Plus} onClick={() => edit()} disabled={createBlocked}>
            Create group
          </Button>
        )}
      </PageHeader>
      <GroupRecovery
        user={user}
        onRecovered={() => {
          void groups.reload();
          notify("Group creation confirmed.", { tone: "success" });
        }}
        onReview={(group) => edit(group)}
      />
      {firstRun ? (
        <TableCard>
          <EmptyState
            icon={Layers}
            title="No groups yet"
            action={
              allowed ? (
                <Button
                  icon={Plus}
                  onClick={() => edit()}
                  disabled={createBlocked}
                >
                  Create group
                </Button>
              ) : undefined
            }
            learnMore={{
              topic: "deployments",
              section: "review-changes-to-a-group",
              label: "How groups change deployments",
            }}
          >
            Group devices that share an environment, region or purpose, then
            deploy to the whole group at once.
          </EmptyState>
        </TableCard>
      ) : (
        <>
          <PageToolbar
            search={
              <SearchBox
                value={query.q}
                onChange={(value) => update({ q: value, page: 1 })}
                placeholder="Search groups"
                shortcut
              />
            }
            count={
              !groups.updatedAt
                ? undefined
                : query.q || query.members
                  ? `${filtered.length} of ${groups.data.length}`
                  : countLabel(groups.data.length, "group")
            }
          />
          <TableCard>
            <DataTable
              data={filtered}
              columns={columns}
              rowKey={(group) => group.id}
              label="Groups"
              error={
                groups.error
                  ? {
                      title: groups.updatedAt
                        ? "Couldn't refresh groups."
                        : "Couldn't load groups.",
                      message: groups.error,
                      updatedAt: groups.updatedAt,
                      retry: () => void groups.reload(),
                      retrying: groups.refreshing,
                    }
                  : null
              }
              className="groups-table"
              loading={groups.loading && !groups.updatedAt}
              sort={sort}
              onSortChange={(next) =>
                update({
                  sort: next?.column || "group",
                  dir: next?.direction || "asc",
                  page: 1,
                })
              }
              manualSorting
              onRowClick={(group) => edit(group)}
              pagination={{
                page: query.page,
                size: pageSize,
                onPage: (page) => update({ page }),
                sizeOptions: GROUP_PAGE_SIZES,
                onSize: (size) => update({ size, page: 1 }),
                noun: "groups",
              }}
              mobileCard={(group) => ({
                title: (
                  <button
                    type="button"
                    className="groups-name"
                    onClick={() => edit(group)}
                  >
                    {group.name}
                  </button>
                ),
                meta: [
                  countLabel(group.device_ids.length, "device"),
                  group.description || null,
                ],
                status: memberHealth(group),
              })}
              empty={
                <EmptyState
                  variant="filtered"
                  title="No matching groups"
                  action={
                    <Button variant="secondary" onClick={() => reset()}>
                      Clear filters
                    </Button>
                  }
                >
                  Try another group name or member filter.
                </EmptyState>
              }
            />
          </TableCard>
        </>
      )}
      {open && (
        <GroupEditor
          key={user.id + ":" + user.role + ":" + (editing?.id || "new")}
          group={editing}
          user={user}
          devices={devices.data}
          deviceLoading={devices.loading}
          deviceError={devices.error}
          onClose={() => setOpen(false)}
          onRefresh={() => {
            void groups.reload();
          }}
          onSaved={(saved) => {
            setSavedGroup(saved);
            setOpen(false);
            notify("Group saved.", {
              tone: "success",
              // An empty group has no devices to show.
              action: saved.device_ids.length
                ? {
                    label: "View devices",
                    href: `#/devices?group=${encodeURIComponent(saved.id)}`,
                  }
                : undefined,
            });
            void groups.reload();
          }}
        />
      )}
    </div>
  );
}
