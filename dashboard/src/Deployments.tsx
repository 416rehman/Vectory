import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Copy, ExternalLink, History, Plus } from "lucide-react";
import {
  APIError,
  can,
  boundedPost,
  type Deployment,
  when,
  type DeploymentSummary,
  type DeploymentPage,
  type DeploymentTargetPage,
  type DeploymentTarget,
  type User,
} from "./api";
import {
  Button,
  DateCell,
  ErrorBox,
  Modal,
  PageHeader,
  Pagination,
  RefreshButton,
  SearchBox,
  Spinner,
  useResource,
} from "./ui";
import { DataTable } from "./DataTable";
import { AssignmentActions } from "./RecoveryActions";
import AssignmentRemoval from "./AssignmentRemoval";
import ScheduledAssignmentRefresh from "./ScheduledAssignmentRefresh";
import { DeploymentRecoveryDialog } from "./DeploymentRecovery";
import { DeploymentStorageRecoveryDialog } from "./DeploymentStorageRecovery";
import RollbackReviewPanel from "./RollbackReviewPanel";
import { type RollbackPreview } from "./rollbackReview";
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
export type { DeploymentQuery } from "./deploymentRouting";
import "./control.css";
import "./deployments.css";
import CanaryGate from "./CanaryGate";
import {
  gateReasonLabels,
  hasCanaryGate,
  readGateReason,
} from "./canaryGateModel";

const statuses: Record<string, string> = {
  active: "In progress",
  completed: "Complete",
  scheduled: "Scheduled",
  paused: "Paused",
  failed: "Needs attention",
  cancelled: "Cancelled",
  unassigned: "Removed",
  missed: "Schedule missed",
};
const targetStates: Record<string, string> = {
  verified_applied: "Applied and verified",
  desired: "Waiting for agent",
  pending: "Waiting",
  downloaded: "Downloaded",
  validated: "Validated",
  written: "Applying",
  reload_requested: "Restarting Vector",
  verification_unknown: "Verification needed",
  rolled_back: "Rolled back",
  incompatible: "Incompatible",
  failed: "Failed",
  blocked: "Blocked",
  removed: "No longer targeted",
  revoked: "Revoked",
};
const label = (state: string) =>
  statuses[state] || targetStates[state] || state.replaceAll("_", " ");
function Status({ state }: { state: string }) {
  return (
    <span className="control-status" data-state={state}>
      {label(state)}
    </span>
  );
}
function title(d: DeploymentSummary) {
  return (
    d.name ||
    (d.policy
      ? "Agent settings"
      : d.configuration_name || "Pipeline deployment")
  );
}
function subtitle(d: DeploymentSummary) {
  return d.policy
    ? `${d.policy.heartbeat_seconds}s heartbeat, ${d.policy.sync_paused ? "Sync paused" : "Sync enabled"}`
    : d.version_number !== null
      ? `Version ${d.version_number}`
      : "Published version unavailable";
}
function Loading({ children }: { children: React.ReactNode }) {
  return (
    <div className="loading" role="status">
      <Spinner />
      {children}
    </div>
  );
}
function Empty({
  title: heading,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="control-empty">
      <h2>{heading}</h2>
      <p>{children}</p>
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
  notify(message: string): void;
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
    [refreshing, setRefreshing] = useState(false);
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
  const opener = useRef<HTMLElement | null>(null),
    recentRequestsOpener = useRef<HTMLElement | null>(null),
    container = useRef<HTMLDivElement | null>(null);
  function openDetail(id: string, element: HTMLElement) {
    opener.current = element;
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
  const previousDetailId = useRef(detailId);
  useEffect(() => {
    const wasOpen = !!previousDetailId.current;
    previousDetailId.current = detailId;
    if (!wasOpen || detailId) return;
    const frame = requestAnimationFrame(() => {
      const target = opener.current?.isConnected
        ? opener.current
        : container.current?.querySelector<HTMLInputElement>(
            ".search-field input",
          );
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [detailId]);
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
  const { data, error, loading, reload } = useResource<DeploymentPage>(
    `/deployments/history?${params}`,
    { items: [], total: 0, page: query.page, page_size: 12 },
  );
  const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
  const correcting = !loading && !error && query.page > lastPage;
  useEffect(() => {
    if (correcting) setQuery((old) => ({ ...old, page: lastPage }));
  }, [correcting, lastPage]);
  const searching = query.search !== search.trim();
  const waiting = loading || searching || correcting;
  function reset() {
    setSearch("");
    setQuery({ search: "", status: "all", page: 1 });
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }
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
            ? `Upcoming and previous scheduled changes. Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`
            : "Track changes from assignment to verified application."
        }
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
        {can(user, "operate") && (
          <Button icon={Plus} onClick={() => navigate("configurations")}>
            Deploy a pipeline
          </Button>
        )}
      </PageHeader>
      {recentRequestsOpen && can(user, "operate") && (
        <RecentDeploymentRequests
          key={user.id}
          onClose={() => setRecentRequestsOpen(false)}
          statusLabel={label}
          returnFocusRef={recentRequestsOpener}
        />
      )}
      <div className="control-toolbar deployment-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder={scheduled ? "Search schedules" : "Search deployments"}
        />
        <RefreshButton busy={refreshing} onClick={() => void refresh()}>
          Refresh
        </RefreshButton>
      </div>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="control-table">
        <DataTable<DeploymentSummary>
          label={scheduled ? "Schedules" : "Deployments"}
          className="deployment-table"
          data={error ? [] : data.items}
          rowKey={(row) => row.id}
          loading={waiting}
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
                      openDetail(d.id, event.currentTarget);
                    }}
                  >
                    {title(d)}
                  </a>
                  <small>{subtitle(d)}</small>
                </>
              ),
            },
            {
              id: "status",
              header: "Status",
              sortable: true,
              cell: (d) => <Status state={d.status} />,
              filter: {
                value: query.status,
                emptyValue: "all",
                allLabel: "All statuses",
                manual: true,
                options: Object.entries(statuses).map(([value, label]) => ({
                  value,
                  label,
                })),
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
              cell: (d) => (
                <div className="activity-progress">
                  <span>
                    {d.target_count
                      ? `${d.verified_count} of ${d.target_count} verified`
                      : "No devices"}
                  </span>
                  {!!d.target_count && (
                    <div className="activity-progress-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${Math.min(100, (d.verified_count / d.target_count) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {d.state_counts.removed > 0 && (
                    <span className="deployment-removed-count">
                      {d.state_counts.removed} no longer targeted
                    </span>
                  )}
                </div>
              ),
            },
            {
              id: scheduled ? "scheduled_at" : "created_at",
              header: scheduled ? "Scheduled for" : "Created",
              sortable: true,
              cell: (d) => (
                <DateCell value={scheduled ? d.scheduled_at : d.created_at} />
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
                  onClick={(event) => openDetail(d.id, event.currentTarget)}
                  aria-label={`View details for ${title(d)}`}
                >
                  View details
                </Button>
              ),
            },
          ]}
          empty={
            error ? (
              "Results unavailable."
            ) : (
              <Empty
                title={
                  search.trim() || query.status !== "all"
                    ? "No matching deployments"
                    : scheduled
                      ? "No scheduled deployments"
                      : "No deployments yet"
                }
              >
                {search.trim() || query.status !== "all" ? (
                  <>
                    <span>Try another search or status.</span>{" "}
                    <Button variant="secondary" onClick={reset}>
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <>
                    {scheduled
                      ? "Choose a published pipeline, select devices, and set a time in Advanced options."
                      : "Publish a pipeline, then choose the devices that should run it."}
                    {can(user, "operate") && (
                      <Button onClick={() => navigate("configurations")}>
                        Choose a pipeline
                      </Button>
                    )}
                  </>
                )}
              </Empty>
            )
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
      </div>
      {invalidDetail && (
        <Modal
          open
          title="Invalid deployment link"
          description="This link does not identify a valid deployment."
          onClose={closeDetail}
        >
          <div className="modal-body">
            <p>Open the deployment from history, or ask for a new link.</p>
          </div>
          <div className="modal-footer">
            <Button onClick={closeDetail}>
              Return to {scheduled ? "schedules" : "deployments"}
            </Button>
          </div>
        </Modal>
      )}
      {detailId && !invalidDetail && (
        <DeploymentInspector
          key={`${user.id}:${detailId}`}
          id={detailId}
          user={user}
          notify={notify}
          navigate={navigate}
          onClose={closeDetail}
          onChanged={reload}
          permalinkRoute={deploymentRoute(scheduled, detailId, query)}
          originLabel={scheduled ? "schedules" : "deployments"}
        />
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
  navigate,
  search,
  setSearch,
  query,
  setQuery,
}: {
  deployment: DeploymentSummary;
  revision: number;
  navigate(path: string): void;
  search: string;
  setSearch(value: string): void;
  query: DeviceResultsQuery;
  setQuery: React.Dispatch<React.SetStateAction<DeviceResultsQuery>>;
}) {
  const releaseStopped = [
    "failed",
    "cancelled",
    "missed",
    "unassigned",
  ].includes(deployment.status);
  const progressLabels: Record<string, string> = {
    ...targetStates,
    pending: releaseStopped ? "Not released" : targetStates.pending,
  };
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
  const { data, error, loading, reload } = useResource<DeploymentTargetPage>(
    `/deployments/${deployment.id}/targets?${params}`,
    { items: [], total: 0, page: query.page, page_size: 12 },
    revision,
  );
  const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
  const correcting = !loading && !error && query.page > lastPage;
  useEffect(() => {
    if (correcting) setQuery((old) => ({ ...old, page: lastPage }));
  }, [correcting, lastPage]);
  return (
    <section aria-label="Device results" className="deployment-device-results">
      <h3>Device results</h3>
      <div className="control-toolbar deployment-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder="Search deployment devices"
        />
      </div>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<DeploymentTarget>
        label="Device results"
        className="deployment-targets"
        data={error ? [] : data.items}
        rowKey={(row) => row.device_id}
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
              <a
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
            ),
          },
          {
            id: "state",
            header: "Progress",
            sortable: true,
            cell: (t) => (
              <span className="control-status" data-state={t.state}>
                {progressLabels[t.state] || label(t.state)}
              </span>
            ),
            filter: {
              value: query.state,
              emptyValue: "all",
              allLabel: "All devices",
              manual: true,
              options: Object.entries({
                ...progressLabels,
                ...Object.fromEntries(
                  Object.keys(deployment.state_counts).map((key) => [
                    key,
                    progressLabels[key] || label(key),
                  ]),
                ),
              }).map(([value, label]) => ({
                value,
                label: `${label} (${deployment.state_counts[value] || 0})`,
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
            header: "Message",
            sortable: false,
            cell: (t) =>
              t.state === "removed" ? (
                <span className="control-muted">
                  No longer included in this assignment. Kept in deployment
                  history.
                  {t.error && (
                    <span className="deployment-target-history">
                      Last reported error: {t.error}
                    </span>
                  )}
                </span>
              ) : hasCanaryGate(deployment) && readGateReason(t.gate_reason) ? (
                <span>
                  <span className="deployment-gate-message">
                    Canary gate:{" "}
                    {gateReasonLabels[readGateReason(t.gate_reason)!]}
                  </span>
                  {t.error && (
                    <span className="deployment-target-error">{t.error}</span>
                  )}
                </span>
              ) : (
                t.error || (
                  <span className="control-muted">
                    {releaseStopped && t.state === "pending"
                      ? "This deployment stopped before this device was released."
                      : t.state === "failed" || t.state === "rolled_back"
                        ? "Open device for details"
                        : "No reported error"}
                  </span>
                )
              ),
          },
        ]}
        empty={
          error
            ? "Results unavailable."
            : query.search || query.state !== "all"
              ? "No devices match these filters."
              : "No devices were targeted."
        }
      />
      {!loading && !correcting && !error && query.search === search.trim() && (
        <Pagination
          count={data.total}
          page={query.page}
          size={data.page_size}
          onPage={(page) => setQuery((old) => ({ ...old, page }))}
        />
      )}
    </section>
  );
}

function DeploymentLink({ route }: { route: string }) {
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
    <div className="deployment-permalink">
      <div className="deployment-permalink-actions">
        <Button
          variant="secondary compact"
          icon={Copy}
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
          Open in new tab{" "}
          <ExternalLink
            className="doc-link-indicator"
            size={12}
            aria-hidden="true"
          />
        </a>
        {state === "copied" && (
          <span className="control-muted" role="status">
            Deployment link copied.
          </span>
        )}
      </div>
      {state === "fallback" && (
        <div className="deployment-link-fallback">
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

function DeploymentInspector({
  id,
  user,
  notify,
  navigate,
  onClose,
  onChanged,
  permalinkRoute,
  originLabel,
}: {
  id: string;
  user: User;
  notify(message: string): void;
  navigate(path: string): void;
  onClose(): void;
  onChanged(): Promise<void>;
  permalinkRoute: string;
  originLabel: string;
}) {
  const {
    data: deployment,
    error,
    loading,
    reload,
    reloadResult,
  } = useResource<DeploymentSummary | null>(
    `/deployments/${encodeURIComponent(id)}/summary`,
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
    [assignmentCommitting, setAssignmentCommitting] = useState(false),
    [assignmentRemovalOpen, setAssignmentRemovalOpen] = useState(false),
    [scheduledRefreshOpen, setScheduledRefreshOpen] = useState(false);
  // The details dialog remounts after review. Let that dialog take focus,
  // instead of restoring to the old, detached removal opener.
  const assignmentReturnFocus = useRef<HTMLElement | null>(null);
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
    assignmentCommittingRef = useRef(false);
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
    mounted.current = true;
    const guard = (event: Event) => {
      if (!busyRef.current && !assignmentCommittingRef.current) return;
      event.preventDefault();
      notify(
        "Wait for the current deployment action to finish before leaving.",
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
    notify(message);
    setRevision((old) => old + 1);
    await Promise.all([reload(), onChanged()]);
  }
  function begin(name: string) {
    if (
      busyRef.current ||
      assignmentCommittingRef.current ||
      uncertainRef.current ||
      checkingStatusRef.current
    )
      return;
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
      cancel: "Cancel rollout",
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
        !Object.hasOwn(statuses, current.status)
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
            "Rollback saved. This browser could not clear its recovery reminder; the confirmed deployment is still available.",
          );
        }
        if (!mounted.current) return;
        setAction(null);
        setConfirmedRollback(result);
        setRecovery(operation);
        void changed(
          "Rollback created. Open its deployment to see device results.",
        );
      } else {
        const result = await boundedPost<Deployment>(
          `/deployments/${id}/${action}`,
        );
        if (result?.id !== id || !Object.hasOwn(statuses, result.status))
          throw Error(
            "The response did not identify the requested deployment.",
          );
        if (!mounted.current) return;
        setAction(null);
        await changed(`${actionLabel(action)} requested.`);
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
  return (
    <>
      <Modal
        open={
          !recovery &&
          !storageIssue &&
          !action &&
          !assignmentRemovalOpen &&
          !scheduledRefreshOpen
        }
        onClose={() => {
          if (!busyRef.current && !assignmentCommittingRef.current) onClose();
        }}
        title="Deployment details"
        description="Review rollout status and verified device results."
        wide
      >
        <div className="modal-body deployment-inspector">
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
          {error && <ErrorBox message={error} retry={reload} />}
          {!loading && error && !deployment && (
            <div className="deployment-unavailable">
              <p>
                This deployment could not be opened. It may be missing, or your
                access may have changed.
              </p>
              <Button variant="secondary" onClick={onClose}>
                Return to {originLabel}
              </Button>
            </div>
          )}
          {loading ? (
            <Loading>Loading deployment</Loading>
          ) : (
            deployment && (
              <>
                <div className="activity-detail-head">
                  <h3>{title(deployment)}</h3>
                  <p>
                    {subtitle(deployment)} <Status state={deployment.status} />
                  </p>
                </div>
                <DeploymentLink route={permalinkRoute} />
                <dl className="control-summary-list">
                  {deployment.configuration_id && (
                    <div>
                      <dt>Pipeline</dt>
                      <dd>
                        <a
                          href={`#/configurations/${encodeURIComponent(deployment.configuration_id)}`}
                        >
                          {deployment.configuration_name || "Open pipeline"}
                        </a>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      {hasCanaryGate(deployment)
                        ? "Recorded progress"
                        : "Progress"}
                    </dt>
                    <dd>
                      {deployment.verified_count} of {deployment.target_count}{" "}
                      devices verified
                      {hasCanaryGate(deployment) && (
                        <span className="deployment-removed-count">
                          Historical results; current readiness is shown below.
                        </span>
                      )}
                      {deployment.state_counts.removed > 0 && (
                        <span className="deployment-removed-count">
                          {deployment.state_counts.removed} no longer targeted
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Release</dt>
                    <dd>
                      {deployment.rollout.kind === "canary"
                        ? "Canary followed by batches"
                        : "All selected devices"}
                    </dd>
                  </div>
                  {deployment.scheduled_at && (
                    <div>
                      <dt>Scheduled for</dt>
                      <dd>{when(deployment.scheduled_at)}</dd>
                    </div>
                  )}
                </dl>
                <CanaryGate
                  deployment={deployment}
                  readError={Boolean(error)}
                  onRefresh={reload}
                />
                {deployment.state_counts.removed > 0 && (
                  <p className="control-muted deployment-membership-note">
                    {deployment.status === "completed" &&
                      "The rollout has finished for its current members. "}
                    Devices no longer targeted stay in this history and are
                    excluded from the current verified count.
                  </p>
                )}
                {deployment.status === "failed" &&
                  deployment.rollout.kind === "canary" && (
                    <p className="control-muted">
                      Retrying a device does not restart this rollout or release
                      its unreleased devices. Review the results before creating
                      a replacement deployment.
                    </p>
                  )}
                {can(user, "operate") && !error && (
                  <div className="activity-detail-actions">
                    <div className="control-inline-actions">
                      {["active", "paused"].includes(deployment.status) && (
                        <Button
                          variant="secondary"
                          disabled={
                            committing || actionUncertain || checkingStatus
                          }
                          onClick={() =>
                            begin(
                              deployment.status === "paused"
                                ? "resume"
                                : "pause",
                            )
                          }
                        >
                          {deployment.status === "paused"
                            ? "Resume rollout"
                            : "Pause rollout"}
                        </Button>
                      )}
                      {["active", "paused", "scheduled"].includes(
                        deployment.status,
                      ) && (
                        <Button
                          variant="secondary"
                          disabled={
                            committing || actionUncertain || checkingStatus
                          }
                          onClick={() => begin("cancel")}
                        >
                          Cancel rollout
                        </Button>
                      )}
                      {!["unassigned", "missed", "scheduled"].includes(
                        deployment.status,
                      ) &&
                        deployment.version_id && (
                          <Button
                            variant="secondary"
                            disabled={
                              committing || actionUncertain || checkingStatus
                            }
                            onClick={() => begin("rollback")}
                          >
                            Roll back
                          </Button>
                        )}
                    </div>
                    {!actionUncertain && !checkingStatus && (
                      <AssignmentActions
                        deployment={deployment}
                        user={user}
                        onCommittingChange={assignmentCommitChanged}
                        onReviewRemoval={() => setAssignmentRemovalOpen(true)}
                        onReviewScheduled={() => setScheduledRefreshOpen(true)}
                        onDone={(message) => void changed(message)}
                      />
                    )}
                  </div>
                )}
                <DeviceResults
                  deployment={deployment}
                  revision={revision}
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
                  </dl>
                </details>
              </>
            )
          )}
        </div>
      </Modal>
      <Modal
        open={!!action}
        onClose={closeAction}
        title={
          action === "rollback" ? "Review rollback" : actionLabel(action || "")
        }
        wide={action === "rollback"}
        className={action === "rollback" ? "rollback-review-modal" : ""}
        description={
          action === "rollback"
            ? "Review the prior version and exact device scope before confirming."
            : action === "resume"
              ? "Continue releasing this change to waiting devices."
              : "Devices may still apply changes they have already received."
        }
      >
        <div className="modal-body">
          {actionError && <ErrorBox message={actionError} />}
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
                Resolve the overlap, then return here to resume. This action has
                not paused or cancelled any rollout.
              </span>
            </div>
          )}
          {action === "rollback" ? (
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
              onChange={rollbackReviewChanged}
            />
          ) : (
            <p>
              {deployment && title(deployment)}
              {`, ${deployment?.target_count || 0} devices`}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={committing}
            onClick={closeAction}
          >
            {actionUncertain ? "Close" : "Keep current state"}
          </Button>
          <Button
            busy={busy}
            disabled={
              committing ||
              (!actionUncertain && !can(user, "operate")) ||
              (action === "rollback" &&
                (!rollbackPreview?.ready || rollbackRejected || !!error))
            }
            onClick={actionUncertain ? closeAction : perform}
          >
            {actionUncertain
              ? "Check current status"
              : action === "rollback" && rollbackPreview?.ready
                ? `Roll back ${rollbackPreview.eligible_devices.length} device${rollbackPreview.eligible_devices.length === 1 ? "" : "s"}`
                : actionLabel(action || "")}
          </Button>
        </div>
      </Modal>
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
        key={`${user.id}:${id}`}
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
          onClose={() => setStorageIssue(null)}
          onRecovered={(message) => void changed(message)}
        />
      )}
    </>
  );
}
export default Deployments;
