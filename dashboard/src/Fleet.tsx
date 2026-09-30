import { useEffect, useState } from "react";
import { Layers, Plus } from "lucide-react";
import GroupEditor from "./GroupEditor";
import { GroupRecovery } from "./GroupRecovery";
import { useGroupOperations } from "./groupRequests";
import { DataTable, TableCard, type TableColumn } from "./DataTable";
import { sortTableRows } from "./dataTableModel";
import { type Group, type GroupSummary, type User } from "./api";
import { roleAllows } from "./roleAccess";
import {
  Button,
  EmptyState,
  PageHeader,
  PageToolbar,
  SearchBox,
  useResource,
} from "./ui";
import { useHashQuery } from "./urlState";
import { useCommand } from "./commands";
import { countLabel } from "./overviewModel";
import DeviceList from "./DeviceList";
import DeviceDetail from "./DeviceDetail";
import "./fleet.css";
import "./devices.css";
import type { Notify } from "./toast";

type Navigate = (path: string) => void;

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

const groupDefaults = {
  q: "",
  members: "",
  /** The open group, so a group view has a link: #/groups?group=<id>. */
  group: "",
  page: 1,
  size: 25,
  sort: "group",
  dir: "asc",
};
const GROUP_PAGE_SIZES = [25, 50, 100];

export function Groups({ user, notify }: { user: User; notify: Notify }) {
  // Rows carry a member count, never the members: a group's members are read
  // when its editor opens.
  const groups = useResource<GroupSummary[]>("/groups?slim=1", []);
  const groupRequests = useGroupOperations(user.id);
  const createBlocked =
    groupRequests.operations.length > 0 || groupRequests.errors.length > 0;
  const [query, update, reset] = useHashQuery(groupDefaults);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Group | GroupSummary | null>(null),
    [savedGroup, setSavedGroup] = useState<Group | null>(null);
  const allowed = roleAllows(user, "operate");
  const pageSize = GROUP_PAGE_SIZES.includes(query.size) ? query.size : 25;
  const sort = {
    column: query.sort || "group",
    direction: (query.dir === "desc" ? "desc" : "asc") as "asc" | "desc",
  };
  const sortGroups = (rows: GroupSummary[]) =>
    sortTableRows(
      rows,
      [
        { id: "group", value: (group) => group.name },
        { id: "members", value: (group) => group.member_count },
      ],
      sort,
    );
  const matches = (group: GroupSummary, text: string) =>
    `${group.name} ${group.description}`
      .toLowerCase()
      .includes(text.trim().toLowerCase());
  const filtered = sortGroups(
    groups.data.filter(
      (group) =>
        matches(group, query.q) &&
        (!query.members ||
          (query.members === "empty"
            ? group.member_count === 0
            : group.member_count > 0)),
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
        group.member_count === savedGroup.device_ids.length,
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
  function edit(group?: Group | GroupSummary) {
    if (!group && createBlocked) return;
    setEditing(group || null);
    setOpen(true);
    if (group) update({ group: group.id });
  }
  function closeEditor() {
    setOpen(false);
    if (query.group) update({ group: "" });
  }
  // A shared link opens its group once the list has loaded.
  useEffect(() => {
    if (!query.group || open || groups.loading) return;
    const linked = groups.data.find((group) => group.id === query.group);
    if (linked) {
      setEditing(linked);
      setOpen(true);
    } else if (!groups.error) update({ group: "" });
    // Only a changed link or a fresh list reopens a group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.group, groups.loading, groups.data]);
  useCommand("group.create", () => edit(), allowed && !createBlocked);
  const firstRun = !groups.loading && !groups.error && groups.data.length === 0;
  const columns: TableColumn<GroupSummary>[] = [
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
      width: 200,
      sortValue: (group) => group.member_count,
      filter: {
        value: query.members,
        onChange: (value) => update({ members: value, page: 1 }),
        manual: true,
        options: [
          {
            value: "empty",
            label: "No members",
            count: groups.data.filter((group) => group.member_count === 0)
              .length,
          },
          {
            value: "populated",
            label: "Has members",
            count: groups.data.filter((group) => group.member_count > 0)
              .length,
          },
        ],
      },
      cell: (group) => (
        <span className="groups-member-count">
          {countLabel(group.member_count, "device")}
        </span>
      ),
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
          onRefresh: () => void groups.reload(),
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
                  countLabel(group.member_count, "device"),
                  group.description || null,
                ],
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
          onClose={closeEditor}
          onRefresh={() => {
            void groups.reload();
          }}
          onSaved={(saved) => {
            setSavedGroup(saved);
            closeEditor();
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
