import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowUpDown,
  Ban,
  CalendarClock,
  Check,
  Clock,
  Copy,
  ExternalLink,
  GitBranch,
  History,
  Layers,
  Pause,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  Trash2,
  Undo2,
  Users,
} from "lucide-react";
import {
  APIError,
  can,
  boundedPost,
  type Deployment,
  type DeploymentSummary,
  type DeploymentPage,
  type DeploymentTargetPage,
  type DeploymentTarget,
  type RolloutFailure,
  type RolloutLanes,
  type User,
} from "./api";
import {
  Button,
  DateCell,
  ErrorBox,
  Modal,
  EmptyState,
  PageHeader,
  PageToolbar,
  Pagination,
  SearchBox,
  InlineError,
  Skeleton,
  StatusBadge,
  useNow,
  useResource,
} from "./ui";
import { DataTable, TableCard } from "./DataTable";
import AssignmentRemoval from "./AssignmentRemoval";
import ScheduledAssignmentRefresh from "./ScheduledAssignmentRefresh";
import { DeploymentRecoveryDialog } from "./DeploymentRecovery";
import { DeploymentStorageRecoveryDialog } from "./DeploymentStorageRecovery";
import RollbackReviewPanel from "./RollbackReviewPanel";
import { nothingToRollBackTo, type RollbackPreview } from "./rollbackReview";
import { assertDeploymentReceipt } from "./deploymentReceipt";
import RecentDeploymentRequests from "./RecentDeploymentRequests";
import {
  beginRollbackOperation,
  isDeploymentActionRejection,
  finishDeploymentOperation,
  readDeploymentRegistry,
  setDeploymentRequestActive,
  type DeploymentOperation,
  type DeploymentStorageIssue,
} from "./deploymentRequests";
import {
  deploymentRoute,
  isDeploymentId,
  type DeploymentQuery,
  type DeploymentSort,
} from "./deploymentRouting";
import {
  deploymentLifecycle,
  describeDeployment,
  explainError,
  exactTime,
  isLive,
  progressSegments,
  statusFilters,
  targetFilterStates,
  targetLabel,
  targetState,
} from "./deploymentStatus";
import { statusLabel } from "./status";
import { relativeTime } from "./time";
import {
  DeviceTimeline,
  FailureGroups,
  ProgressBar,
  StageLanes,
  laneTitle,
} from "./DeploymentRollout";
import DeploymentRetry from "./DeploymentRetry";
import DeploymentPicker from "./DeploymentPicker";
export type { DeploymentQuery } from "./deploymentRouting";
import "./control.css";
import "./deployments.css";
import "./deployment-rollout.css";
import CanaryGate from "./CanaryGate";
import {
  gateReasonLabels,
  hasCanaryGate,
  readGateReason,
} from "./canaryGateModel";
import type { Notify } from "./toast";

const knownStatuses = new Set<string>(deploymentLifecycle);
function title(d: DeploymentSummary) {
  return (
    d.name ||
    (d.policy
      ? d.policy_name || "Agent settings"
      : d.configuration_name || "Pipeline deployment")
  );
}
function subtitle(d: DeploymentSummary) {
  return d.policy
    ? `${d.policy.heartbeat_seconds}s check-ins, ${d.policy.sync_paused ? "sync paused" : "sync enabled"}${d.policy.telemetry_enabled ? "" : ", metrics off"}`
    : d.version_number !== null
      ? `Version ${d.version_number}`
      : "Published version unavailable";
}
function strategy(d: DeploymentSummary) {
  const kind =
    d.rollout.kind === "canary"
      ? `Canary of ${d.rollout.canary_size}, then batches of ${d.rollout.batch_size}`
      : "All at once";
  return d.scheduled_at ? `Scheduled · ${kind}` : kind;
}
function DeploymentStatusCell({ d }: { d: DeploymentSummary }) {
  const display = describeDeployment(d);
  return (
    <span className="deployment-status-cell">
      <StatusBadge
        domain="deployment"
        value={display.state}
        label={display.label}
      />
      {display.note && <small>{display.note}</small>}
    </span>
  );
}
function DevicesCell({ d }: { d: DeploymentSummary }) {
  const stopped = !isLive(d.status);
  const failed =
    progressSegments(d.state_counts).find((s) => s.key === "failed")?.count ||
    0;
  const removed = d.state_counts.removed || 0;
  const current = d.target_count - removed;
  const replaced = d.replaced_by || [];
  const moved = replaced.reduce((sum, entry) => sum + entry.device_count, 0);
  const latest = replaced[replaced.length - 1];
  if (!current && d.target_count)
    return (
      <div className="deployment-devices-cell">
        <span className="control-muted">
          {moved
            ? `${moved} ${moved === 1 ? "device" : "devices"} moved to ${latest?.version_number ? `v${latest.version_number}` : "a newer version"}`
            : `${removed} ${removed === 1 ? "device" : "devices"} no longer targeted`}
        </span>
      </div>
    );
  if (d.rolled_back_by)
    return (
      <div className="deployment-devices-cell">
        <span className="control-muted">
          {d.verified_count} of {current} verified, then rolled back
        </span>
      </div>
    );
  return (
    <div className="deployment-devices-cell">
      <span>
        {current || d.target_count
          ? `${d.verified_count} of ${current} verified`
          : "No devices"}
        {failed > 0 && (
          <strong className="deployment-failed-count">
            {" "}
            · {failed} failed
          </strong>
        )}
      </span>
      {current > 0 && (
        <ProgressBar
          counts={d.state_counts}
          stopped={stopped}
          variant="mini"
          label="Device progress"
        />
      )}
    </div>
  );
}
export function Deployments({
  scheduled = false,
  user,
  notify,
  navigate,
  initialQuery,
  onQueryChange,
  selectedDeploymentId,
  routeKey,
  routeQuery,
}: {
  scheduled?: boolean;
  user: User;
  notify: Notify;
  navigate(path: string): void;
  initialQuery?: DeploymentQuery;
  onQueryChange?(query: DeploymentQuery): void;
  selectedDeploymentId?: string | null;
  routeKey?: string;
  routeQuery?: DeploymentQuery;
}) {
  const [query, setQuery] = useState<DeploymentQuery>(
    routeQuery || initialQuery || { search: "", status: "all", page: 1 },
  );
  const [search, setSearch] = useState(query.search),
    [localDetailId, setLocalDetailId] = useState<string | null>(null),
    [recentRequestsOpen, setRecentRequestsOpen] = useState(false),
    [pickerOpen, setPickerOpen] = useState(false);

  const controlled = selectedDeploymentId !== undefined;
  const detailId = controlled
    ? selectedDeploymentId?.toLowerCase() || null
    : localDetailId;
  const invalidDetail = controlled && !!detailId && !isDeploymentId(detailId);
  const previousRouteKey = useRef(routeKey);
  useEffect(() => {
    if (previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;
    const next = routeQuery || { search: "", status: "all", page: 1 };
    setQuery(next);
    setSearch(next.search);
  }, [routeKey, routeQuery]);
  const recentRequestsOpener = useRef<HTMLElement | null>(null),
    pickerOpener = useRef<HTMLElement | null>(null),
    container = useRef<HTMLDivElement | null>(null),
    returnTo = useRef<string | null>(null);
  function openDetail(id: string) {
    returnTo.current = id;
    if (controlled) {
      // Make the current list entry restorable by Back before pushing its detail.
      history.replaceState(
        history.state,
        "",
        `#/${deploymentRoute(scheduled, null, query)}`,
      );
      navigate(deploymentRoute(scheduled, id, query));
    } else setLocalDetailId(id);
  }
  function closeDetail() {
    if (controlled) navigate(deploymentRoute(scheduled, null, query));
    else setLocalDetailId(null);
  }
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setQuery((old) =>
          old.search === search.trim()
            ? old
            : { ...old, search: search.trim(), page: 1 },
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    search: query.search,
    status: query.status,
    page: String(query.page),
    page_size: "12",
  });
  if (query.sort) {
    params.set("sort", query.sort);
    params.set("direction", query.direction || "desc");
  }
  if (scheduled) params.set("scheduled", "true");
  const { data, error, loading, reload, refreshing, updatedAt } =
    useResource<DeploymentPage>(
      detailId ? null : `/deployments/history?${params}`,
      { items: [], total: 0, page: query.page, page_size: 12 },
    );
  const filteredList = !!search.trim() || query.status !== "all";
  // Nothing recorded yet: the first-run message replaces the table.
  const firstRun =
    !loading && !error && !filteredList && query.page === 1 && !data.total;
  const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
  // The list is not read while a rollout page is open, so its page is kept.
  const correcting = !detailId && !loading && !error && query.page > lastPage;
  useEffect(() => {
    if (correcting) setQuery((old) => ({ ...old, page: lastPage }));
  }, [correcting, lastPage]);
  // Return focus to the row that opened the rollout page, once it is listed.
  useEffect(() => {
    if (detailId || loading || !returnTo.current) return;
    const frame = requestAnimationFrame(() => {
      const target =
        container.current?.querySelector<HTMLElement>(
          `[data-deployment-link="${returnTo.current}"]`,
        ) ||
        container.current?.querySelector<HTMLInputElement>(
          ".search-field input",
        );
      target?.focus();
      returnTo.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [detailId, loading]);
  const searching = query.search !== search.trim();
  const waiting = loading || searching || correcting;
  function reset() {
    setSearch("");
    setQuery({ search: "", status: "all", page: 1 });
  }
  const originLabel = scheduled ? "Schedules" : "Deployments";
  if (invalidDetail)
    return (
      <div className="control-page deployment-page" ref={container}>
        <button
          type="button"
          className="rollout-back"
          aria-label={`Back to ${originLabel.toLowerCase()}`}
          onClick={closeDetail}
        >
          <ArrowLeft size={15} aria-hidden="true" /> {originLabel}
        </button>
        <div className="rollout-unavailable" role="alert">
          <h1>Invalid deployment link</h1>
          <p>This link doesn't identify a deployment. Open it from history.</p>
          <Button onClick={closeDetail}>
            Return to {originLabel.toLowerCase()}
          </Button>
        </div>
      </div>
    );
  if (detailId)
    return (
      <RolloutPage
        key={`${user.id}:${detailId}`}
        id={detailId}
        user={user}
        notify={notify}
        navigate={navigate}
        onBack={closeDetail}
        backHref={`#/${deploymentRoute(scheduled, null, query)}`}
        originLabel={originLabel}
        permalinkRoute={deploymentRoute(scheduled, detailId, query)}
      />
    );
  return (
    <div className="control-page deployment-page" ref={container}>
      <PageHeader
        title={scheduled ? "Schedules" : "Deployments"}
        help={{
          topic: "deployments",
          section: "find-a-deployment-or-device-result",
        }}
        description={
          scheduled
            ? `Upcoming and past scheduled changes. Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`
            : "Every change from release to verified on each device."
        }
        live={{
          updatedAt,
          error: error || undefined,
          loading,
          refreshing,
          onRefresh: () => void reload(),
        }}
      >
        {can(user, "operate") && data.request_history === true && (
          <Button
            variant="secondary"
            icon={History}
            onClick={(event) => {
              recentRequestsOpener.current = event.currentTarget;
              setRecentRequestsOpen(true);
            }}
          >
            Your recent requests
          </Button>
        )}
        {can(user, "operate") && !firstRun && (
          <Button
            icon={Plus}
            onClick={(event) => {
              pickerOpener.current = event.currentTarget;
              setPickerOpen(true);
            }}
          >
            {scheduled ? "Schedule a deployment" : "Deploy a pipeline"}
          </Button>
        )}
      </PageHeader>
      {recentRequestsOpen && can(user, "operate") && (
        <RecentDeploymentRequests
          key={user.id}
          onClose={() => setRecentRequestsOpen(false)}
          statusLabel={(state) => statusLabel("deployment", state)}
          returnFocusRef={recentRequestsOpener}
        />
      )}
      {pickerOpen && can(user, "operate") && (
        <DeploymentPicker
          user={user}
          scheduled={scheduled}
          returnFocusRef={pickerOpener}
          onClose={() => setPickerOpen(false)}
          onDone={(message) => {
            notify(message, { tone: "success" });
            void reload();
          }}
        />
      )}
      {firstRun ? (
        <TableCard>
          <EmptyState
            icon={scheduled ? CalendarClock : Rocket}
            title={
              scheduled ? "No scheduled deployments" : "No deployments yet"
            }
            action={
              can(user, "operate") ? (
                <Button
                  icon={Plus}
                  onClick={(event) => {
                    pickerOpener.current = event.currentTarget;
                    setPickerOpen(true);
                  }}
                >
                  {scheduled ? "Schedule a deployment" : "Deploy a pipeline"}
                </Button>
              ) : undefined
            }
          >
            {scheduled
              ? "Pick a published pipeline, choose devices, then choose Scheduled."
              : "Publish a pipeline, then choose the devices that should run it."}
          </EmptyState>
        </TableCard>
      ) : (
        <>
          <PageToolbar
            search={
              <SearchBox
                value={search}
                onChange={setSearch}
                maxLength={200}
                placeholder={
                  scheduled ? "Search schedules" : "Search deployments"
                }
              />
            }
            count={
              updatedAt
                ? `${data.total.toLocaleString()} ${data.total === 1 ? (scheduled ? "schedule" : "deployment") : scheduled ? "schedules" : "deployments"}`
                : undefined
            }
          />
          <TableCard className="control-table">
            <DataTable<DeploymentSummary>
              label={scheduled ? "Schedules" : "Deployments"}
              className="deployment-table"
              data={data.items}
              rowKey={(row) => row.id}
              loading={waiting}
              error={
                error
                  ? {
                      title: updatedAt
                        ? `Couldn't refresh ${scheduled ? "schedules" : "deployments"}.`
                        : `Couldn't load ${scheduled ? "schedules" : "deployments"}.`,
                      message: error,
                      updatedAt,
                      retry: () => void reload(),
                      retrying: refreshing,
                    }
                  : null
              }
              mobileCard={(d) => {
                const display = describeDeployment(d);
                const current = d.target_count - (d.state_counts.removed || 0);
                return {
                  title: title(d),
                  href: `#/${deploymentRoute(scheduled, d.id, query)}`,
                  status: (
                    <StatusBadge
                      domain="deployment"
                      value={display.state}
                      label={display.label}
                    />
                  ),
                  meta: [
                    subtitle(d),
                    current > 0
                      ? `${d.verified_count} of ${current} verified`
                      : null,
                    display.note,
                  ],
                };
              }}
              manualSorting
              sort={{
                column: query.sort || "created_at",
                direction: query.direction || "desc",
              }}
              onSortChange={(sort) =>
                setQuery(({ sort: _sort, direction: _direction, ...old }) => ({
                  ...old,
                  page: 1,
                  ...(sort
                    ? {
                        sort: sort.column as DeploymentSort,
                        direction: sort.direction,
                      }
                    : {}),
                }))
              }
              columns={[
                {
                  id: "name",
                  header: "Change",
                  sortable: true,
                  cell: (d) => (
                    <>
                      <a
                        className="control-row-title"
                        data-deployment-link={d.id}
                        href={`#/${deploymentRoute(scheduled, d.id, query)}`}
                        onClick={(event) => {
                          if (
                            event.button !== 0 ||
                            event.ctrlKey ||
                            event.metaKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          event.preventDefault();
                          openDetail(d.id);
                        }}
                      >
                        {title(d)}
                      </a>
                      <small>
                        {subtitle(d)}
                        {d.rollback_of && (
                          <span className="deployment-lineage">
                            {" "}
                            · Rollback of{" "}
                            {d.rollback_of_version
                              ? `v${d.rollback_of_version}`
                              : "an earlier rollout"}
                          </span>
                        )}
                      </small>
                    </>
                  ),
                },
                {
                  id: "status",
                  header: "Status",
                  sortable: true,
                  cell: (d) => <DeploymentStatusCell d={d} />,
                  filter: {
                    value: query.status,
                    emptyValue: "all",
                    allLabel: "All statuses",
                    manual: true,
                    options: statusFilters,
                    onChange: (status) =>
                      setQuery((old) => ({
                        ...old,
                        search: search.trim(),
                        status,
                        page: 1,
                      })),
                  },
                },
                {
                  id: "verified",
                  header: "Devices",
                  sortable: true,
                  cell: (d) => <DevicesCell d={d} />,
                },
                {
                  id: scheduled ? "scheduled_at" : "created_at",
                  header: scheduled ? "Scheduled for" : "Created",
                  sortable: true,
                  cell: (d) => (
                    <DateCell
                      value={scheduled ? d.scheduled_at : d.created_at}
                    />
                  ),
                },
                {
                  id: "actions",
                  header: <span className="sr-only">Actions</span>,
                  label: "Actions",
                  sortable: false,
                  cell: (d) => (
                    <Button
                      variant="secondary compact"
                      onClick={() => openDetail(d.id)}
                      aria-label={`View details for ${title(d)}`}
                    >
                      Open
                    </Button>
                  ),
                },
              ]}
              empty={
                <EmptyState
                  variant="filtered"
                  title="No matching deployments"
                  action={
                    <Button variant="secondary" onClick={reset}>
                      Clear filters
                    </Button>
                  }
                >
                  Try another search or status.
                </EmptyState>
              }
            />
            {!waiting && !error && (
              <Pagination
                count={data.total}
                page={query.page}
                size={data.page_size}
                onPage={(page) => setQuery((old) => ({ ...old, page }))}
              />
            )}
          </TableCard>
        </>
      )}
    </div>
  );
}

type DeviceResultsQuery = {
  search: string;
  state: string;
  page: number;
  sort: string;
  direction: "asc" | "desc";
};
function DeviceResults({
  deployment,
  revision,
  pulse,
  stages,
  navigate,
  search,
  setSearch,
  query,
  setQuery,
}: {
  deployment: DeploymentSummary;
  revision: number;
  pulse: number;
  stages: Map<string, string>;
  navigate(path: string): void;
  search: string;
  setSearch(value: string): void;
  query: DeviceResultsQuery;
  setQuery: React.Dispatch<React.SetStateAction<DeviceResultsQuery>>;
}) {
  const stopped = !isLive(deployment.status);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setQuery((old) =>
          old.search === search.trim()
            ? old
            : { ...old, search: search.trim(), page: 1 },
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    ...query,
    page: String(query.page),
    page_size: "12",
  });
  const { data, error, loading, reload, refreshing, updatedAt } =
    useResource<DeploymentTargetPage>(
      `/deployments/${deployment.id}/targets?${params}`,
      { items: [], total: 0, page: query.page, page_size: 12 },
      revision,
    );
  useEffect(() => {
    if (pulse) void reload();
  }, [pulse, reload]);
  const now = useNow(null, { every: 5000 });
  const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
  const correcting = !loading && !error && query.page > lastPage;
  useEffect(() => {
    if (correcting) setQuery((old) => ({ ...old, page: lastPage }));
  }, [correcting, lastPage]);
  const states = [
    ...new Set([
      ...targetFilterStates,
      ...Object.keys(deployment.state_counts),
    ]),
  ].filter(
    (state) =>
      targetFilterStates.includes(state) || deployment.state_counts[state],
  );
  return (
    <section aria-label="Device results" className="deployment-device-results">
      <div className="rollout-section-head">
        <h2>Devices</h2>
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder="Search deployment devices"
        />
      </div>
      <div className="control-table">
        <DataTable<DeploymentTarget>
          label="Device results"
          className="deployment-targets"
          data={data.items}
          rowKey={(row) => row.device_id}
          error={
            error
              ? {
                  title: updatedAt
                    ? "Couldn't refresh device results."
                    : "Couldn't load device results.",
                  message: error,
                  updatedAt,
                  retry: () => void reload(),
                  retrying: refreshing,
                }
              : null
          }
          mobileCard={(t) => ({
            title: t.device_name || t.device_id,
            href: `#/devices/${encodeURIComponent(t.device_id)}`,
            status: (
              <StatusBadge
                domain="target"
                value={targetState(t.state, {
                  stopped,
                  replaced: !!t.replaced_by,
                })}
              />
            ),
            meta: [
              stages.get(t.device_id) || null,
              t.last_seen
                ? `Checked in ${relativeTime(t.last_seen, now)}`
                : "Never checked in",
            ],
          })}
          loading={loading || correcting || query.search !== search.trim()}
          manualSorting
          sort={{ column: query.sort, direction: query.direction }}
          onSortChange={(sort) =>
            setQuery((old) => ({
              ...old,
              page: 1,
              sort: sort?.column || "device_name",
              direction: sort?.direction || "asc",
            }))
          }
          columns={[
            {
              id: "device_name",
              header: "Device",
              sortable: true,
              cell: (t) => (
                <>
                  <a
                    className="control-row-title"
                    href={`#/devices/${encodeURIComponent(t.device_id)}`}
                    onClick={(event) => {
                      if (
                        event.button === 0 &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        !event.altKey
                      ) {
                        event.preventDefault();
                        navigate(`devices/${encodeURIComponent(t.device_id)}`);
                      }
                    }}
                  >
                    {t.device_name || t.device_id}
                  </a>
                  <small>
                    {stages.get(t.device_id) && (
                      <span className="rollout-stage-tag">
                        {stages.get(t.device_id)}
                      </span>
                    )}
                    {t.last_seen
                      ? `Checked in ${relativeTime(t.last_seen, now)}`
                      : "Never checked in"}
                    {t.check_in_seconds
                      ? ` · every ${t.check_in_seconds} s`
                      : ""}
                  </small>
                </>
              ),
            },
            {
              id: "state",
              header: "Progress",
              sortable: true,
              cell: (t) => (
                <div className="rollout-progress-cell">
                  <StatusBadge
                    domain="target"
                    value={targetState(t.state, {
                      stopped,
                      replaced: !!t.replaced_by,
                    })}
                  />
                  {t.state !== "removed" && t.state !== "pending" && (
                    <DeviceTimeline target={t} />
                  )}
                </div>
              ),
              filter: {
                value: query.state,
                emptyValue: "all",
                allLabel: "All devices",
                manual: true,
                options: states.map((value) => ({
                  value,
                  label: `${targetLabel(value, { stopped })} (${deployment.state_counts[value] || 0})`,
                })),
                onChange: (state) =>
                  setQuery((old) => ({
                    ...old,
                    search: search.trim(),
                    state,
                    page: 1,
                  })),
              },
            },
            {
              id: "message",
              header: "Details",
              sortable: false,
              cell: (t) => (
                <TargetDetails
                  t={t}
                  deployment={deployment}
                  stopped={stopped}
                  navigate={navigate}
                />
              ),
            },
          ]}
          empty={
            query.search || query.state !== "all"
              ? "No devices match these filters."
              : "No devices were targeted."
          }
        />
        {!loading &&
          !correcting &&
          !error &&
          query.search === search.trim() && (
            <Pagination
              count={data.total}
              page={query.page}
              size={data.page_size}
              onPage={(page) => setQuery((old) => ({ ...old, page }))}
            />
          )}
      </div>
    </section>
  );
}
function TargetDetails({
  t,
  deployment,
  stopped,
  navigate,
}: {
  t: DeploymentTarget;
  deployment: DeploymentSummary;
  stopped: boolean;
  navigate(path: string): void;
}) {
  if (t.state === "removed")
    return t.replaced_by ? (
      <span className="control-muted">
        Replaced on this device by{" "}
        <a
          href={`#/${deploymentRoute(false, t.replaced_by, { search: "", status: "all", page: 1 })}`}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            navigate(
              deploymentRoute(false, t.replaced_by!, {
                search: "",
                status: "all",
                page: 1,
              }),
            );
          }}
        >
          a newer deployment
        </a>
        .
      </span>
    ) : (
      <span className="control-muted">
        No longer included in this assignment. Kept in deployment history.
        {t.error && (
          <span className="deployment-target-history">
            Last reported error: {t.error}
          </span>
        )}
      </span>
    );
  const gate =
    hasCanaryGate(deployment) && readGateReason(t.gate_reason)
      ? gateReasonLabels[readGateReason(t.gate_reason)!]
      : null;
  const explained = explainError(t.error);
  if (t.diagnostic)
    return (
      <span className="rollout-diagnostic">
        <code>{t.diagnostic}</code>
        {explained && <small>{explained.summary}</small>}
      </span>
    );
  if (gate)
    return (
      <span>
        <span className="deployment-gate-message">Canary gate: {gate}</span>
        {explained && (
          <span className="deployment-target-error">{explained.summary}</span>
        )}
      </span>
    );
  if (explained)
    return (
      <span className="rollout-diagnostic">
        <span>{explained.summary}</span>
        {explained.code && (
          <small>
            Agent code <code className="rollout-code">{explained.code}</code>
          </small>
        )}
      </span>
    );
  return (
    <span className="control-muted">
      {t.state === "pending"
        ? stopped
          ? "The rollout stopped before this device was released."
          : "Waits for its stage to be released."
        : t.state === "desired"
          ? t.check_in_seconds
            ? `Applies on its next check-in (within ${t.check_in_seconds} s).`
            : "Applies on its next check-in."
          : t.state === "verified_applied"
            ? `Verified ${exactTime(t.verified_at)}`.trim()
            : ["failed", "rolled_back", "incompatible"].includes(t.state)
              ? "No reason reported. Open device for details."
              : "No reported error."}
    </span>
  );
}

function CopyLink({ route }: { route: string }) {
  const [state, setState] = useState<"idle" | "copied" | "fallback">("idle");
  const [copying, setCopying] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const labelId = useId();
  const url = new URL(location.href);
  url.search = "";
  url.hash = "/" + route;
  const link = url.href;
  useEffect(() => {
    setState("idle");
  }, [link]);
  useEffect(() => {
    if (state === "fallback") {
      input.current?.focus();
      input.current?.select();
    }
  }, [state]);
  return (
    <div className="rollout-link">
      <div className="rollout-link-actions">
        <Button
          variant="ghost compact"
          icon={state === "copied" ? Check : Copy}
          busy={copying}
          aria-label="Copy deployment link"
          onClick={async () => {
            setCopying(true);
            try {
              if (!navigator.clipboard?.writeText)
                throw Error("Clipboard unavailable");
              await navigator.clipboard.writeText(link);
              setState("copied");
            } catch {
              setState("fallback");
            } finally {
              setCopying(false);
            }
          }}
        >
          {state === "copied" ? "Copied" : "Copy link"}
        </Button>
        <a href={link} target="_blank" rel="noopener noreferrer">
          Open in new tab
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
      {state === "copied" && (
        <span className="rollout-link-status" role="status">
          Deployment link copied.
        </span>
      )}
      {state === "fallback" && (
        <div className="rollout-link-fallback">
          <label htmlFor={labelId}>Deployment link</label>
          <input
            ref={input}
            id={labelId}
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="control-muted" role="status">
            Clipboard access is unavailable. Select and copy the link above.
          </p>
        </div>
      )}
    </div>
  );
}

/** The rollout page's shape while its first read is in flight. */
function RolloutSkeleton() {
  return (
    <div
      className="rollout-skeleton"
      role="status"
      aria-label="Loading rollout"
    >
      <Skeleton width={96} height={12} />
      <Skeleton width="min(420px, 70%)" height={24} />
      <Skeleton width="min(560px, 90%)" height={14} />
      <div className="rollout-card rollout-skeleton-card">
        <Skeleton width={180} height={14} />
        <Skeleton height={10} radius={999} />
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} height={36} />
        ))}
      </div>
    </div>
  );
}

function RolloutPage({
  id,
  user,
  notify,
  navigate,
  onBack,
  backHref,
  permalinkRoute,
  originLabel,
}: {
  id: string;
  user: User;
  notify: Notify;
  navigate(path: string): void;
  onBack(): void;
  backHref: string;
  permalinkRoute: string;
  originLabel: string;
}) {
  const {
    data: deployment,
    error,
    errorStatus,
    loading,
    refreshing,
    reload,
    reloadResult,
  } = useResource<DeploymentSummary | null>(
    `/deployments/${encodeURIComponent(id)}/summary`,
    null,
  );
  const lanes = useResource<RolloutLanes | null>(
    `/deployments/${encodeURIComponent(id)}/rollout`,
    null,
  );
  const [action, setAction] = useState<string | null>(null),
    [rollbackPreview, setRollbackPreview] = useState<RollbackPreview | null>(
      null,
    ),
    [rollbackRejected, setRollbackRejected] = useState(false),
    [recovery, setRecovery] = useState<DeploymentOperation | null>(null),
    [storageIssue, setStorageIssue] = useState<DeploymentStorageIssue | null>(
      null,
    ),
    [confirmedRollback, setConfirmedRollback] = useState<
      Deployment | undefined
    >(),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [blockedByCanary, setBlockedByCanary] = useState(false),
    [actionUncertain, setActionUncertain] = useState(false),
    [checkingStatus, setCheckingStatus] = useState(false),
    [statusReadError, setStatusReadError] = useState(""),
    [revision, setRevision] = useState(0),
    [pulse, setPulse] = useState(0),
    [assignmentCommitting, setAssignmentCommitting] = useState(false),
    [assignmentRemovalOpen, setAssignmentRemovalOpen] = useState(false),
    [scheduledRefreshOpen, setScheduledRefreshOpen] = useState(false),
    [retryScope, setRetryScope] = useState<RolloutFailure | null | undefined>(
      undefined,
    ),
    [updatedAt, setUpdatedAt] = useState<number | null>(null),
    [clockOffset, setClockOffset] = useState(0);
  const assignmentReturnFocus = useRef<HTMLElement | null>(null);
  // The rollout is a page, not a dialog: a dialog opened from it hands focus
  // back to the control that opened it.
  const actionReturnFocus = useRef<HTMLElement | null>(null);
  function rememberOpener() {
    const active = document.activeElement;
    actionReturnFocus.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }
  function openRetry(scope: RolloutFailure | null) {
    rememberOpener();
    setRetryScope(scope);
  }
  const [deviceSearch, setDeviceSearch] = useState("");
  const [deviceQuery, setDeviceQuery] = useState<DeviceResultsQuery>({
    search: "",
    state: "all",
    page: 1,
    sort: "device_name",
    direction: "asc",
  });
  const committing = busy || assignmentCommitting;
  const busyRef = useRef(false),
    uncertainRef = useRef(false),
    checkingStatusRef = useRef(false),
    mounted = useRef(true),
    assignmentCommittingRef = useRef(false),
    heading = useRef<HTMLHeadingElement | null>(null);
  const assignmentCommitChanged = useCallback((value: boolean) => {
    assignmentCommittingRef.current = value;
    setAssignmentCommitting(value);
  }, []);
  const rollbackReviewChanged = useCallback((value: RollbackPreview | null) => {
    setRollbackPreview(value);
    if (value) {
      setRollbackRejected(false);
      setActionError("");
    }
  }, []);
  useEffect(() => {
    if (deployment) setUpdatedAt(Date.now());
  }, [deployment]);
  useEffect(() => {
    if (lanes.data)
      setClockOffset(Date.parse(lanes.data.evaluated_at) - Date.now());
  }, [lanes.data]);
  useEffect(() => {
    if (!loading && deployment) heading.current?.focus({ preventScroll: true });
    // Focus the page title once, when the rollout first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading && !deployment]);
  const live = !!deployment && isLive(deployment.status);
  // Refresh faster while a rollout can still move, and only while visible.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (busyRef.current || assignmentCommittingRef.current) return;
      void reload();
      void lanes.reload();
      setPulse((value) => value + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, [live, reload, lanes.reload]);
  useEffect(() => {
    mounted.current = true;
    const guard = (event: Event) => {
      if (!busyRef.current && !assignmentCommittingRef.current) return;
      event.preventDefault();
      notify(
        "Wait for the current deployment action to finish before leaving.",
        { tone: "info" },
      );
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!busyRef.current && !assignmentCommittingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, [notify]);
  async function changed(message: string) {
    notify(message, { tone: "success" });
    setRevision((old) => old + 1);
    await Promise.all([reload(), lanes.reload()]);
  }
  function begin(name: string) {
    if (
      busyRef.current ||
      assignmentCommittingRef.current ||
      uncertainRef.current ||
      checkingStatusRef.current
    )
      return;
    rememberOpener();
    if (name === "rollback") {
      const registry = readDeploymentRegistry(user.id);
      if (registry.errors.length) {
        setStorageIssue(registry.errors[0]);
        return;
      }
      const pending = registry.operations[0];
      if (pending) {
        setConfirmedRollback(undefined);
        setRecovery(pending);
        return;
      }
    }
    setActionError("");
    setBlockedByCanary(false);
    setRollbackPreview(null);
    setRollbackRejected(false);
    setAction(name);
  }
  const actionLabel = (name: string) =>
    ({
      pause: "Pause rollout",
      resume: "Resume rollout",
      cancel:
        deployment?.status === "scheduled"
          ? "Cancel schedule"
          : "Cancel rollout",
      rollback: "Roll back",
    })[name] || "Change deployment";
  function closeAction() {
    if (busyRef.current || assignmentCommittingRef.current) return;
    setAction(null);
    if (uncertainRef.current) void checkCurrentStatus();
  }
  async function checkCurrentStatus() {
    if (
      busyRef.current ||
      assignmentCommittingRef.current ||
      checkingStatusRef.current
    )
      return;
    setAction(null);
    checkingStatusRef.current = true;
    setCheckingStatus(true);
    setStatusReadError("");
    try {
      const current = await reloadResult();
      if (!mounted.current) return;
      if (
        typeof current?.id !== "string" ||
        current.id.toLowerCase() !== id.toLowerCase() ||
        !knownStatuses.has(current.status)
      ) {
        setStatusReadError(
          "The current status could not be confirmed for this deployment. Check again before making another change.",
        );
        return;
      }
      uncertainRef.current = false;
      setActionUncertain(false);
    } finally {
      checkingStatusRef.current = false;
      if (mounted.current) setCheckingStatus(false);
    }
  }
  async function perform() {
    if (
      !action ||
      uncertainRef.current ||
      checkingStatusRef.current ||
      busyRef.current ||
      assignmentCommittingRef.current ||
      !can(user, "operate")
    )
      return;
    let operation: DeploymentOperation | null = null;
    busyRef.current = true;
    setBusy(true);
    setActionError("");
    setBlockedByCanary(false);
    try {
      if (action === "rollback") {
        const registry = readDeploymentRegistry(user.id);
        if (registry.errors.length) {
          setAction(null);
          setStorageIssue(registry.errors[0]);
          return;
        }
        const pending = registry.operations[0];
        if (pending) {
          setAction(null);
          setConfirmedRollback(undefined);
          setRecovery(pending);
          return;
        }
        if (!deployment || error)
          throw Error("Refresh the deployment before starting a rollback.");
        if (
          deployment.rollback_review !== true ||
          deployment.rollback_idempotency !== true ||
          deployment.request_correlation !== true ||
          !rollbackPreview?.ready ||
          rollbackRejected ||
          rollbackPreview.source_deployment_id !== id ||
          rollbackPreview.source_version_id !== deployment.version_id
        )
          throw Error("Review the current rollback scope before confirming.");
        operation = beginRollbackOperation(
          user.id,
          id,
          deployment.rollback_idempotency === true,
          `Rollback: ${title(deployment)}`,
          rollbackPreview,
        );
        if (!setDeploymentRequestActive(operation, true)) {
          setAction(null);
          setConfirmedRollback(undefined);
          setRecovery(operation);
          return;
        }
        const result = assertDeploymentReceipt(
          operation,
          await boundedPost<Deployment>(
            `/deployments/${id}/rollback`,
            operation.request,
          ),
        );
        try {
          finishDeploymentOperation(operation);
        } catch {
          notify(
            "Rollback saved. This browser couldn't clear its recovery reminder. The confirmed deployment is still available.",
            { tone: "info" },
          );
        }
        if (!mounted.current) return;
        setAction(null);
        setConfirmedRollback(result);
        setRecovery(operation);
        void changed("Rollback created. Its rollout page tracks each device.");
      } else {
        const result = await boundedPost<Deployment>(
          `/deployments/${id}/${action}`,
        );
        if (result?.id !== id || !knownStatuses.has(result.status))
          throw Error(
            "The response did not identify the requested deployment.",
          );
        if (!mounted.current) return;
        setAction(null);
        await changed(
          action === "pause"
            ? "Rollout paused. Released devices keep what they received."
            : action === "resume"
              ? "Rollout resumed."
              : "Rollout cancelled. Released devices keep what they received.",
        );
      }
    } catch (e) {
      if (!mounted.current) return;
      if (operation) {
        // A lease is only an activity hint: a peer may have sent this key.
        // Preserve the original rollback even after a structured rejection.
        setAction(null);
        setActionError((e as Error).message);
        setRollbackPreview(null);
        setRollbackRejected(true);
        setConfirmedRollback(undefined);
        setRecovery(operation);
      } else {
        if (action === "rollback") {
          const issue = readDeploymentRegistry(user.id).errors[0];
          if (issue) {
            setAction(null);
            setStorageIssue(issue);
            return;
          }
        }
        let message = (e as Error).message;
        if (action !== "rollback" && !isDeploymentActionRejection(e)) {
          uncertainRef.current = true;
          setActionUncertain(true);
          message =
            "The response could not be confirmed. Check the current deployment status before trying this action again.";
        }
        setBlockedByCanary(
          action === "resume" &&
            e instanceof APIError &&
            e.serverRejection &&
            e.status === 409 &&
            e.code === "ACTIVE_CANARY_OVERLAP",
        );
        setActionError(message);
      }
    } finally {
      if (operation) setDeploymentRequestActive(operation, false);
      busyRef.current = false;
      setBusy(false);
    }
  }
  const stageByDevice = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes.data?.stages || [])
      if (lane.kind !== "all")
        for (const device of lane.devices)
          map.set(device.device_id, laneTitle(lane));
    return map;
  }, [lanes.data]);
  const failedCount = deployment
    ? progressSegments(deployment.state_counts).find((s) => s.key === "failed")
        ?.count || 0
    : 0;
  const operate = can(user, "operate") && !error && !!deployment;
  const locked = committing || actionUncertain || checkingStatus;
  const status = deployment?.status || "";
  const candidate = [
    "active",
    "paused",
    "completed",
    "cancelled",
    "failed",
  ].includes(status);
  const canRollBack =
    operate &&
    !!deployment?.version_id &&
    candidate &&
    !deployment?.rolled_back_by;
  const rollbackUnavailable = deployment?.rollback_available === false;
  const unavailableReason =
    (deployment?.target_count || 0) -
      (deployment?.state_counts.removed || 0) ===
    1
      ? "Nothing to roll back to. This device ran its local config before this deployment."
      : "Nothing to roll back to. These devices ran their local config before this deployment.";
  const display = deployment ? describeDeployment(deployment) : null;
  const currentTargets = deployment
    ? deployment.target_count - (deployment.state_counts.removed || 0)
    : 0;
  const movedTargets = (deployment?.replaced_by || []).reduce(
    (sum, entry) => sum + entry.device_count,
    0,
  );
  const multiStage =
    (lanes.data?.stages.length || 0) > 1 ||
    deployment?.rollout.kind === "canary";
  const lastWave =
    !!lanes.data &&
    !lanes.data.stages.some(
      (lane) => lane.state === "queued" || lane.state === "stopped",
    );
  const removeAssignment = (opener?: HTMLElement | null) => {
    assignmentReturnFocus.current = opener || null;
    setAction(null);
    setAssignmentRemovalOpen(true);
  };
  const goToDeployment = (target: string) =>
    navigate(
      deploymentRoute(false, target, { search: "", status: "all", page: 1 }),
    );
  return (
    <div
      className="control-page rollout-page"
      role="region"
      aria-label="Deployment details"
    >
      {loading && !deployment ? (
        <RolloutSkeleton />
      ) : !deployment ? (
        error && (
          <>
            <PageHeader
              title="Deployment"
              breadcrumb={[
                { label: originLabel, href: backHref, onClick: onBack },
              ]}
            />
            <div className="rollout-unavailable" role="alert">
              <p>
                {errorStatus === 404 || errorStatus === 403
                  ? "This deployment could not be opened. It may be missing, or your access may have changed."
                  : "Vectory couldn't load this rollout right now."}
              </p>
              <div className="rollout-unavailable-actions">
                {errorStatus !== 404 && errorStatus !== 403 && (
                  <Button variant="secondary" onClick={() => void reload()}>
                    Retry
                  </Button>
                )}
                <Button variant="ghost" onClick={onBack}>
                  Return to {originLabel.toLowerCase()}
                </Button>
              </div>
            </div>
          </>
        )
      ) : (
        display && (
          <>
            <PageHeader
              title={title(deployment)}
              documentTitle={`${title(deployment)}${!deployment.policy && deployment.version_number !== null ? ` v${deployment.version_number}` : ""}`}
              headingRef={heading}
              breadcrumb={[
                { label: originLabel, href: backHref, onClick: onBack },
              ]}
              titleAside={
                !deployment.policy &&
                deployment.version_number !== null && (
                  <span
                    className="rollout-version"
                    aria-label={`Version ${deployment.version_number}`}
                  >
                    v{deployment.version_number}
                  </span>
                )
              }
              live={{
                updatedAt,
                error: error || lanes.error || undefined,
                refreshing,
                onRefresh: () => {
                  void reload();
                  void lanes.reload();
                },
              }}
              meta={
                <>
                  <ul className="rollout-meta" aria-label="Rollout settings">
                    <li className="rollout-meta-status">
                      <StatusBadge
                        domain="deployment"
                        value={display.state}
                        label={display.label}
                      />
                      {display.note && (
                        <span className="rollout-status-note">
                          {display.note}
                        </span>
                      )}
                    </li>
                    <li>
                      <Layers size={14} aria-hidden="true" />
                      {deployment.policy
                        ? subtitle(deployment)
                        : strategy(deployment)}
                    </li>
                    <li>
                      <ArrowUpDown size={14} aria-hidden="true" />
                      Priority {deployment.priority}
                    </li>
                    <li>
                      <Users size={14} aria-hidden="true" />
                      {deployment.target_mode === "persistent"
                        ? "Follows group membership"
                        : "Fixed devices"}
                    </li>
                    <li>
                      <Clock size={14} aria-hidden="true" />
                      {deployment.scheduled_at &&
                      deployment.status === "scheduled"
                        ? `Starts ${exactTime(deployment.scheduled_at)}`
                        : `Created ${exactTime(deployment.created_at)}`}
                      {deployment.created_by_name
                        ? ` by ${deployment.created_by_name}`
                        : ""}
                    </li>
                    {deployment.configuration_id && (
                      <li>
                        <GitBranch size={14} aria-hidden="true" />
                        <a
                          href={`#/configurations/${encodeURIComponent(deployment.configuration_id)}`}
                        >
                          Open pipeline
                        </a>
                      </li>
                    )}
                  </ul>
                  <Lineage deployment={deployment} go={goToDeployment} />
                </>
              }
            >
              {operate && (
                <div className="rollout-action-row">
                  {failedCount > 0 && deployment.version_id && (
                    <Button
                      icon={RotateCcw}
                      disabled={locked}
                      onClick={() => openRetry(null)}
                    >
                      Retry failed ({failedCount})
                    </Button>
                  )}
                  {status === "active" && (
                    <Button
                      variant="secondary"
                      icon={Pause}
                      disabled={locked}
                      onClick={() => begin("pause")}
                    >
                      Pause
                    </Button>
                  )}
                  {status === "paused" && (
                    <Button
                      icon={Play}
                      disabled={locked}
                      onClick={() => begin("resume")}
                    >
                      Resume
                    </Button>
                  )}
                  {status === "scheduled" && (
                    <Button
                      variant="secondary"
                      icon={CalendarClock}
                      disabled={locked}
                      onClick={(event) => {
                        assignmentReturnFocus.current = event.currentTarget;
                        setScheduledRefreshOpen(true);
                      }}
                    >
                      Review scheduled devices
                    </Button>
                  )}
                  {["active", "paused", "scheduled"].includes(status) && (
                    <Button
                      variant="secondary"
                      icon={Ban}
                      disabled={locked}
                      onClick={() => begin("cancel")}
                    >
                      {status === "scheduled" ? "Cancel schedule" : "Cancel"}
                    </Button>
                  )}
                  {canRollBack &&
                    (rollbackUnavailable ? (
                      // Still focusable and clickable: it explains why and offers removal.
                      <span
                        className="rollout-hint"
                        data-hint={unavailableReason}
                      >
                        <Button
                          variant="secondary"
                          icon={Undo2}
                          disabled={locked}
                          aria-disabled="true"
                          aria-describedby="rollback-unavailable-reason"
                          className="is-unavailable"
                          onClick={() => begin("rollback")}
                        >
                          Roll back
                        </Button>
                        <span
                          id="rollback-unavailable-reason"
                          className="sr-only"
                        >
                          {unavailableReason}
                        </span>
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        icon={Undo2}
                        disabled={locked}
                        onClick={() => begin("rollback")}
                      >
                        Roll back
                      </Button>
                    ))}
                  {candidate && (
                    <Button
                      variant="ghost"
                      icon={Trash2}
                      disabled={locked}
                      onClick={(event) => removeAssignment(event.currentTarget)}
                    >
                      Remove assignment
                    </Button>
                  )}
                </div>
              )}
              <CopyLink route={permalinkRoute} />
            </PageHeader>
            {error && (
              <InlineError
                title="Couldn't refresh this rollout."
                error={error}
                updatedAt={updatedAt}
                retry={() => void reload()}
              />
            )}
            {actionUncertain && (
              <div className="deployment-status-review" role="status">
                <p>
                  {statusReadError ||
                    "The previous action may have completed. Check its current status before making another change."}
                </p>
                <Button
                  variant="secondary"
                  busy={checkingStatus}
                  disabled={checkingStatus}
                  onClick={() => void checkCurrentStatus()}
                >
                  Check current status
                </Button>
              </div>
            )}
            <section
              className="rollout-card rollout-summary"
              aria-label="Rollout progress"
            >
              {currentTargets === 0 && deployment.target_count > 0 ? (
                <div className="rollout-summary-head">
                  <p>
                    <strong>
                      {movedTargets
                        ? `Replaced on ${movedTargets} ${movedTargets === 1 ? "device" : "devices"}`
                        : "No devices follow this now"}
                    </strong>
                  </p>
                  <span className="control-muted">
                    {movedTargets
                      ? "They moved to a newer assignment. Their history stays here."
                      : "Its devices stay in history."}
                  </span>
                </div>
              ) : (
                <>
                  <div className="rollout-summary-head">
                    <p>
                      <strong>
                        {deployment.verified_count} of {currentTargets}
                      </strong>{" "}
                      {currentTargets === 1 ? "device" : "devices"} verified
                      {deployment.rolled_back_by ? " before the rollback" : ""}
                    </p>
                    <span className="control-muted">
                      {deployment.rollout.kind === "canary"
                        ? deployment.rollout.failure_threshold === 0
                          ? "Stops on the first failure"
                          : `Stops after ${deployment.rollout.failure_threshold + 1} failures`
                        : deployment.status === "failed"
                          ? "Stopped"
                          : "Only verified devices count"}
                    </span>
                  </div>
                  <ProgressBar
                    counts={deployment.state_counts}
                    stopped={!live}
                    label="Device progress"
                  />
                  {hasCanaryGate(deployment) && (
                    <p className="control-muted rollout-recorded-note">
                      Recorded progress: historical results; current readiness
                      is shown below.
                    </p>
                  )}
                </>
              )}
              {(deployment.state_counts.removed || 0) > 0 &&
                currentTargets > 0 && (
                  <p className="control-muted deployment-membership-note">
                    {deployment.state_counts.removed} earlier{" "}
                    {deployment.state_counts.removed === 1
                      ? "device is no longer targeted and stays"
                      : "devices are no longer targeted and stay"}{" "}
                    in history.
                  </p>
                )}
            </section>
            {multiStage && lanes.data && lanes.data.stages.length > 0 && (
              <section
                className="rollout-section"
                aria-labelledby="rollout-stages"
              >
                <div className="rollout-section-head">
                  <h2 id="rollout-stages">Stages</h2>
                  {deployment.rollout.kind === "canary" && (
                    <span className="control-muted">
                      Each stage waits for every released device to verify
                      {deployment.rollout.observation_seconds
                        ? `, then observes for ${deployment.rollout.observation_seconds} s`
                        : ""}
                      .
                    </span>
                  )}
                </div>
                <StageLanes
                  lanes={lanes.data.stages}
                  nextAdmissionAt={lanes.data.next_admission_at}
                  observationSeconds={deployment.rollout.observation_seconds}
                  clockOffset={clockOffset}
                  failureThreshold={
                    deployment.rollout.kind === "canary"
                      ? deployment.rollout.failure_threshold
                      : null
                  }
                  navigate={navigate}
                />
              </section>
            )}
            {hasCanaryGate(deployment) && (
              <CanaryGate
                deployment={deployment}
                readError={Boolean(error)}
                onRefresh={reload}
                clockOffset={clockOffset}
                lastWave={lastWave}
              />
            )}
            {lanes.data && lanes.data.failures.length > 0 && (
              <FailureGroups
                failures={lanes.data.failures}
                navigate={navigate}
                onRetry={
                  operate && deployment.version_id
                    ? (failure) => openRetry(failure)
                    : undefined
                }
              />
            )}
            {deployment.status === "failed" &&
              deployment.rollout.kind === "canary" && (
                <p className="control-muted rollout-note">
                  Retrying a device sends the same version again. It doesn't
                  restart the rollout or release waiting devices.
                </p>
              )}
            <DeviceResults
              deployment={deployment}
              revision={revision}
              pulse={pulse}
              stages={stageByDevice}
              navigate={navigate}
              search={deviceSearch}
              setSearch={setDeviceSearch}
              query={deviceQuery}
              setQuery={setDeviceQuery}
            />
            <details className="control-disclosure">
              <summary>Technical details</summary>
              <dl className="control-summary-list">
                <div>
                  <dt>Deployment ID</dt>
                  <dd className="control-wrap-code">{id}</dd>
                </div>
                {deployment.version_id && (
                  <div>
                    <dt>Version ID</dt>
                    <dd className="control-wrap-code">
                      {deployment.version_id}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Priority</dt>
                  <dd>{deployment.priority}</dd>
                </div>
                <div>
                  <dt>Membership</dt>
                  <dd>
                    {deployment.target_mode === "persistent"
                      ? "Follows group membership"
                      : "Fixed device snapshot"}
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <DateCell value={deployment.created_at} />
                  </dd>
                </div>
              </dl>
            </details>
          </>
        )
      )}
      {action && (
        <ActionDialog
          action={action}
          deployment={deployment}
          id={id}
          busy={busy}
          committing={committing}
          error={actionError}
          uncertain={actionUncertain}
          blockedByCanary={blockedByCanary}
          readError={!!error}
          allowed={can(user, "operate")}
          rollbackPreview={rollbackPreview}
          rollbackRejected={rollbackRejected}
          onRollbackChange={rollbackReviewChanged}
          label={actionLabel}
          returnFocusRef={actionReturnFocus}
          onClose={closeAction}
          onConfirm={perform}
          onRemove={() => removeAssignment(null)}
        />
      )}
      {retryScope !== undefined && deployment && (
        <DeploymentRetry
          deployment={deployment}
          scope={retryScope}
          returnFocusRef={actionReturnFocus}
          onClose={() => setRetryScope(undefined)}
          onDone={(message) => void changed(message)}
        />
      )}
      <AssignmentRemoval
        key={`${user.id}:${id}`}
        deploymentId={id}
        actorId={user.id}
        allowed={can(user, "operate")}
        open={assignmentRemovalOpen}
        onClose={() => setAssignmentRemovalOpen(false)}
        onDone={(message) => void changed(message)}
        onCommittingChange={assignmentCommitChanged}
        returnFocusRef={assignmentReturnFocus}
      />
      <ScheduledAssignmentRefresh
        key={`${user.id}:${id}:schedule`}
        deploymentId={id}
        actorId={user.id}
        allowed={can(user, "operate")}
        open={scheduledRefreshOpen}
        onClose={() => setScheduledRefreshOpen(false)}
        onDone={(message) => void changed(message)}
        onCommittingChange={assignmentCommitChanged}
        returnFocusRef={assignmentReturnFocus}
      />
      {recovery && (
        <DeploymentRecoveryDialog
          key={recovery.id}
          operation={recovery}
          userId={user.id}
          allowed={can(user, "operate")}
          confirmed={confirmedRollback}
          initialError={actionError}
          returnFocusRef={actionReturnFocus}
          onClose={() => {
            setRecovery(null);
            setConfirmedRollback(undefined);
            setActionError("");
          }}
          onRecovered={(message) => {
            void changed(message);
          }}
        />
      )}
      {storageIssue && (
        <DeploymentStorageRecoveryDialog
          issue={storageIssue}
          userId={user.id}
          allowed={can(user, "operate")}
          returnFocusRef={actionReturnFocus}
          onClose={() => setStorageIssue(null)}
          onRecovered={(message) => void changed(message)}
        />
      )}
    </div>
  );
}

function Lineage({
  deployment,
  go,
}: {
  deployment: DeploymentSummary;
  go(id: string): void;
}) {
  const links: { key: string; label: string; target: string }[] = [];
  if (deployment.rollback_of)
    links.push({
      key: "of",
      label: `Rollback of ${deployment.rollback_of_version ? `v${deployment.rollback_of_version}` : "an earlier rollout"}`,
      target: deployment.rollback_of,
    });
  if (deployment.rolled_back_by)
    links.push({
      key: "by",
      label: `Rolled back to ${deployment.rolled_back_to_version ? `v${deployment.rolled_back_to_version}` : "an earlier version"}${deployment.rolled_back_at ? ` at ${exactTime(deployment.rolled_back_at)}` : ""}`,
      target: deployment.rolled_back_by,
    });
  for (const entry of deployment.replaces || [])
    links.push({
      key: `replaces-${entry.deployment_id}`,
      label: `Replaces ${entry.version_number ? `v${entry.version_number}` : "an earlier assignment"}`,
      target: entry.deployment_id,
    });
  for (const entry of deployment.replaced_by || [])
    links.push({
      key: `replaced-${entry.deployment_id}`,
      label: `Replaced by ${entry.version_number ? `v${entry.version_number}` : "a newer assignment"} on ${entry.device_count} ${entry.device_count === 1 ? "device" : "devices"}`,
      target: entry.deployment_id,
    });
  if (!links.length) return null;
  return (
    <ul className="rollout-lineage" aria-label="Related rollouts">
      {links.map((link) => (
        <li key={link.key}>
          <a
            href={`#/${deploymentRoute(false, link.target, { search: "", status: "all", page: 1 })}`}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              go(link.target);
            }}
          >
            {link.label}
            <ExternalLink
              size={12}
              aria-hidden="true"
              className="rollout-lineage-icon"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

function ActionDialog({
  action,
  deployment,
  id,
  busy,
  committing,
  error,
  uncertain,
  blockedByCanary,
  readError,
  allowed,
  rollbackPreview,
  rollbackRejected,
  onRollbackChange,
  label,
  returnFocusRef,
  onClose,
  onConfirm,
  onRemove,
}: {
  action: string;
  deployment: DeploymentSummary | null;
  id: string;
  busy: boolean;
  committing: boolean;
  error: string;
  uncertain: boolean;
  blockedByCanary: boolean;
  readError: boolean;
  allowed: boolean;
  rollbackPreview: RollbackPreview | null;
  rollbackRejected: boolean;
  onRollbackChange(value: RollbackPreview | null): void;
  label(name: string): string;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onConfirm(): void;
  onRemove(): void;
}) {
  const rollback = action === "rollback";
  const empty =
    rollback && !!rollbackPreview && nothingToRollBackTo(rollbackPreview);
  const devices =
    (deployment?.target_count || 0) - (deployment?.state_counts.removed || 0);
  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={rollback ? "Review rollback" : label(action)}
      wide={rollback}
      className={rollback ? "rollback-review-modal" : ""}
      description={
        rollback
          ? "Review the version and devices before confirming."
          : action === "resume"
            ? "Release this change to the devices still waiting."
            : action === "pause"
              ? "Stop releasing to more devices. Devices that already received it keep it."
              : "Stop releasing to more devices. Devices that already received it keep it. Rollback is separate."
      }
    >
      <div className="modal-body">
        {error && <ErrorBox message={error} />}
        {blockedByCanary && (
          <div className="deployment-blocked-help">
            <a
              href={`#/${deploymentRoute(false, null, { search: "", status: "active", page: 1 })}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Review active deployments{" "}
              <ExternalLink size={13} aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span>
              Resolve the overlap, then resume. Nothing was paused or cancelled.
            </span>
          </div>
        )}
        {rollback ? (
          <RollbackReviewPanel
            id={id}
            versionId={deployment?.version_id ?? undefined}
            supported={
              deployment?.rollback_review === true &&
              deployment.rollback_idempotency === true &&
              deployment.request_correlation === true
            }
            busy={committing}
            invalidated={rollbackRejected}
            onChange={onRollbackChange}
          />
        ) : (
          <p>
            <strong>{deployment && title(deployment)}</strong>
            {deployment &&
              ` · ${subtitle(deployment)} · ${devices} ${devices === 1 ? "device" : "devices"}`}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <Button variant="secondary" disabled={committing} onClick={onClose}>
          {uncertain ? "Close" : "Keep current state"}
        </Button>
        {empty ? (
          <Button disabled={committing} onClick={onRemove}>
            Remove assignment
          </Button>
        ) : (
          <Button
            busy={busy}
            disabled={
              committing ||
              (!uncertain && !allowed) ||
              (rollback &&
                (!rollbackPreview?.ready || rollbackRejected || readError))
            }
            onClick={uncertain ? onClose : onConfirm}
          >
            {uncertain
              ? "Check current status"
              : rollback && rollbackPreview?.ready
                ? `Roll back ${rollbackPreview.eligible_devices.length} device${rollbackPreview.eligible_devices.length === 1 ? "" : "s"}`
                : label(action)}
          </Button>
        )}
      </div>
    </Modal>
  );
}
export default Deployments;
