import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  APIError,
  api,
  can,
  post,
  when,
  type Device,
  type Issue,
  type IssueGroup,
  type IssueGroupPage,
  type IssueHistoryPage,
  type User,
} from "./api";
import {
  StatusBadge,
  Button,
  ErrorBox,
  Field,
  Modal,
  Pagination,
  PageHeader,
  InlineError,
  SegmentedControl,
  SearchBox,
  Spinner,
  useResource,
} from "./ui";
import DocLink from "./DocLink";
import { DataTable, type TableColumn, type TableSort } from "./DataTable";
import DiagnosticList from "./DiagnosticList";
import { DeviceApplicationRetry, eligibleState } from "./RecoveryActions";
import { leadingDiagnostic } from "./runtimeModel";
import { isDataPlaneCode, issueDispositions } from "./status";
import "./control.css";
import "./issues.css";
import NotificationsHint from "./NotificationsHint";
import type { Notify } from "./toast";

const issueTime = (value: string | null) =>
  value ? when(value) : "Unavailable";
type Disposition = Issue["disposition"] | "all";
type View = "groups" | "list";
const labels = {
  open: issueDispositions.open.label,
  acknowledged: issueDispositions.acknowledged.label,
  resolved: issueDispositions.resolved.label,
  all: "All",
};
const PAGE_SIZE = 12;
const emptyPage: IssueHistoryPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: PAGE_SIZE,
};
const emptyGroups: IssueGroupPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: PAGE_SIZE,
};
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

type VersionContext = {
  configuration_id?: string | null;
  configuration_name?: string | null;
  version_number?: number | null;
};
function versionLabel(context: VersionContext, versionId?: string | null) {
  if (!versionId) return "No pipeline version";
  const name = context.configuration_name || "Pipeline";
  return context.version_number
    ? `${name} · version ${context.version_number}`
    : name;
}
function attemptsLabel(attempts: number, reports?: number, code?: string) {
  // Delivery issues count openings, and the checks that found the problem.
  if (isDataPlaneCode(code)) {
    const text = plural(attempts, "occurrence");
    return reports ? `${text} · seen in ${plural(reports, "check")}` : text;
  }
  const text = plural(attempts, "failed attempt");
  return reports && reports > attempts
    ? `${text} · reported ${plural(reports, "time")}`
    : text;
}
function resolution(issue: Issue) {
  switch (issue.resolved_reason) {
    case "unassigned":
      return "Resolved when its pipeline assignment was removed.";
    case "healthy":
      return "Resolved when the pipeline delivered normally for three checks in a row.";
    case "superseded":
      return "Resolved when the device stopped running the version this was measured on.";
    case "unmonitored":
      return "Resolved when metrics were turned off, so delivery can't be checked any more.";
    case "revoked":
      return "Resolved when the device was revoked. It can't check in any more.";
    default:
      return "Resolved when the device verified a configuration after this failure.";
  }
}
function canAct(user: User, issue: Issue) {
  // The original device identity must still exist; revoked identities can
  // still be acknowledged as a record of the operator's decision.
  return (
    can(user, "operate") && !issue.resolved && issue.device_revoked !== null
  );
}

type Dialog =
  { kind: "disposition"; issue: Issue } | { kind: "retry"; issue: Issue };

export default function Issues({
  user,
  notify,
  navigate,
  deviceId,
}: {
  user: User;
  notify: Notify;
  navigate: (path: string) => void;
  deviceId?: string;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [state, setState] = useState<Disposition>("open"),
    [view, setView] = useState<View>(deviceId ? "list" : "groups"),
    [sort, setSort] = useState<TableSort | null>({
      column: "last_seen",
      direction: "desc",
    }),
    [page, setPage] = useState(1),
    [groupPage, setGroupPage] = useState(1),
    [dialog, setDialog] = useState<Dialog | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null),
    container = useRef<HTMLDivElement | null>(null);
  function closeDialog(saved = false) {
    setDialog(null);
    requestAnimationFrame(() => {
      const target =
        !saved && opener.current?.isConnected
          ? opener.current
          : container.current?.querySelector<HTMLInputElement>(
              ".search-field input",
            );
      target?.focus();
    });
  }
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
      setGroupPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    setPage(1);
    if (deviceId) setView("list");
  }, [deviceId]);
  const listParams = new URLSearchParams({
    search: query,
    state,
    page: String(page),
    page_size: String(PAGE_SIZE),
    sort: sort?.column || "last_seen",
    direction: sort?.direction || "desc",
  });
  if (deviceId) listParams.set("device_id", deviceId);
  const groupParams = new URLSearchParams({
    search: query,
    state,
    page: String(groupPage),
    page_size: String(PAGE_SIZE),
  });
  const list = useResource<IssueHistoryPage>(
    view === "list" ? `/issues/history?${listParams}` : null,
    emptyPage,
  );
  const groups = useResource<IssueGroupPage>(
    view === "groups" ? `/issues/groups?${groupParams}` : null,
    emptyGroups,
  );
  const active = view === "list" ? list : groups;
  useEffect(() => {
    if (!list.loading && !list.error)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(list.data.total / PAGE_SIZE))),
      );
  }, [list.loading, list.error, list.data.total]);
  useEffect(() => {
    if (!groups.loading && !groups.error)
      setGroupPage((current) =>
        Math.min(
          current,
          Math.max(1, Math.ceil(groups.data.total / PAGE_SIZE)),
        ),
      );
  }, [groups.loading, groups.error, groups.data.total]);
  function act(kind: Dialog["kind"], issue: Issue, target: HTMLButtonElement) {
    opener.current = target;
    setDialog({ kind, issue });
  }
  // Rows from before a failed refresh stay readable, but nothing acts on them.
  const stale = !!active.error;
  const actions = (issue: Issue) => (
    <IssueActions issue={issue} user={user} onAct={act} stale={stale} />
  );
  const columns: TableColumn<Issue>[] = [
    {
      id: "code",
      header: "Issue",
      value: (issue) => issue.title || issue.code,
      className: "issue-summary-cell",
      cell: (issue) => <IssueSummary issue={issue} />,
    },
    {
      id: "disposition",
      header: "Status",
      value: (issue) => issue.disposition,
      cell: (issue) => <DispositionBadge issue={issue} />,
    },
    {
      id: "device",
      header: "Device",
      value: (issue) => issue.device_name,
      className: "issue-nowrap",
      cell: (issue) => <DeviceCell issue={issue} />,
    },
    {
      id: "last_seen",
      header: "Last reported",
      value: (issue) => issue.last_seen,
      cell: (issue) => (
        <time dateTime={issue.last_seen || undefined}>
          {issueTime(issue.last_seen)}
        </time>
      ),
    },
    {
      id: "count",
      header: "Attempts",
      value: (issue) => issue.count,
      className: "issue-nowrap",
      cell: (issue) => (
        <>
          {issue.count.toLocaleString()}
          {issue.reports !== undefined && issue.reports > issue.count && (
            <small>reported {plural(issue.reports, "time")}</small>
          )}
        </>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Issue actions</span>,
      cell: actions,
    },
  ];
  const emptyState = (
    <div className="control-empty">
      <h2>
        {query
          ? "No matching issues"
          : state === "all"
            ? "No issues reported"
            : `No ${labels[state].toLowerCase()} issues`}
      </h2>
      <p>
        {query
          ? "Try another search or status."
          : state === "open"
            ? "No device has reported a failure that needs attention. Check Devices for connectivity and current health."
            : "Issues with this status will appear here."}
      </p>
    </div>
  );
  return (
    <div className="control-page issue-page" ref={container}>
      <PageHeader
        title="Issues"
        description="Failures devices reported while applying or running a pipeline version, with Vector's reason and the fix."
        help={{
          topic: "troubleshooting",
          section: "a-pipeline-is-rejected-or-rolled-back",
        }}
        live={{
          updatedAt: active.updatedAt,
          error: active.error || undefined,
          loading: active.loading,
          refreshing: active.refreshing,
          onRefresh: () => void active.reload(),
        }}
      />
      <NotificationsHint user={user} placement="page" />
      <div className="control-toolbar issue-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder="Search devices, pipelines, or reasons"
        />
        <SegmentedControl
          label="Issue status"
          value={state}
          options={(["open", "acknowledged", "resolved", "all"] as const).map(
            (value) => ({ value, label: labels[value] }),
          )}
          onChange={(value) => {
            setState(value);
            setPage(1);
            setGroupPage(1);
          }}
        />
        {!deviceId && (
          <SegmentedControl
            label="Issue layout"
            value={view}
            options={[
              { value: "groups", label: "By version and reason" },
              { value: "list", label: "All issues" },
            ]}
            onChange={setView}
          />
        )}
      </div>
      {deviceId && (
        <p className="issue-scope">
          Issues for{" "}
          <a href={`#/devices/${encodeURIComponent(deviceId)}`}>
            {list.data.items[0]?.device_name || "this device"}
          </a>{" "}
          <Button variant="ghost" onClick={() => navigate("issues")}>
            Show all devices
          </Button>
        </p>
      )}
      {view === "list" ? (
        <div className="control-table issue-table-panel">
          <DataTable
            data={list.data.items}
            columns={columns}
            rowKey={(issue) => issue.id}
            label="Issues"
            className="issue-table"
            error={
              list.error
                ? {
                    title: list.updatedAt
                      ? "Couldn't refresh issues."
                      : "Couldn't load issues.",
                    message: list.error,
                    updatedAt: list.updatedAt,
                    retry: () => void list.reload(),
                    retrying: list.refreshing,
                  }
                : null
            }
            loading={list.loading}
            manualSorting
            sort={sort}
            onSortChange={(value) => {
              setSort(value);
              setPage(1);
            }}
            pagination={
              list.error
                ? undefined
                : {
                    page,
                    size: PAGE_SIZE,
                    total: list.data.total,
                    onPage: setPage,
                  }
            }
            empty={emptyState}
          />
        </div>
      ) : (
        <IssueGroups
          page={groups.data}
          loading={groups.loading}
          error={groups.error}
          updatedAt={groups.updatedAt}
          retry={() => void groups.reload()}
          retrying={groups.refreshing}
          empty={emptyState}
          actions={actions}
          onPage={setGroupPage}
        />
      )}
      {dialog?.kind === "disposition" && (
        <IssueDisposition
          key={`${dialog.issue.id}:${dialog.issue.revision}`}
          issue={dialog.issue}
          close={() => {
            closeDialog();
            void active.reload();
          }}
          onDone={(message) => {
            closeDialog(true);
            void active.reload();
            notify(message, { tone: "success" });
          }}
        />
      )}
      {dialog?.kind === "retry" && (
        <RetryDialog
          issue={dialog.issue}
          user={user}
          close={() => {
            closeDialog();
            void active.reload();
          }}
          onDone={(message) => {
            closeDialog(true);
            void active.reload();
            notify(message, { tone: "success" });
          }}
        />
      )}
    </div>
  );
}

function DispositionBadge({ issue }: { issue: Issue }) {
  return <StatusBadge domain="issue" value={issue.disposition} />;
}

function DeviceCell({ issue }: { issue: Issue }) {
  return (
    <>
      <a
        className="control-row-title"
        href={`#/devices/${encodeURIComponent(issue.device_id)}`}
      >
        {issue.device_name || "Open device"}
      </a>
      {issue.device_revoked && <small>Device access revoked</small>}
      {issue.device_revoked === null && <small>Device no longer exists</small>}
    </>
  );
}

function IssueSummary({ issue }: { issue: Issue }) {
  const fix = leadingDiagnostic(issue.diagnostics)?.hint;
  return (
    <div className="issue-summary">
      <strong>
        {issue.title || "The device couldn't apply the configuration"}
      </strong>
      <p className="issue-context">
        {issue.desired_version_id && issue.configuration_id ? (
          <a
            href={`#/configurations/${encodeURIComponent(issue.configuration_id)}`}
          >
            {versionLabel(issue, issue.desired_version_id)}
          </a>
        ) : (
          versionLabel(issue, issue.desired_version_id)
        )}
        {issue.deployment_id && (
          <>
            {" · "}
            <a
              href={`#/deployments/${encodeURIComponent(issue.deployment_id)}`}
            >
              Deployment
            </a>
          </>
        )}
      </p>
      <p>{issue.message}</p>
      {fix && (
        <p className="issue-fix">
          <strong>Fix</strong> {fix}
        </p>
      )}
      {issue.acknowledged && (
        <div className="issue-acknowledgement">
          <p>
            <strong>
              Acknowledged by {issue.acknowledged_by_name || "an operator"}
            </strong>
            {issue.acknowledged_at && <> · {when(issue.acknowledged_at)}</>}
          </p>
          {issue.acknowledgement_reason && (
            <p>{issue.acknowledgement_reason}</p>
          )}
        </div>
      )}
      <details className="control-disclosure">
        <summary>Investigation details</summary>
        {issue.disposition === "resolved" ? (
          <p>{resolution(issue)} Check the device for its present health.</p>
        ) : issue.device_revoked ? (
          <p>
            This device identity is retired and cannot report recovery. Check
            any replacement separately. Acknowledging records your decision and
            removes this issue from the open list; it does not verify recovery.
          </p>
        ) : isDataPlaneCode(issue.code) ? (
          <p>
            The version applied, but the device's telemetry shows it isn't
            delivering. Fix the destination or the component, or roll back to
            the last working version. This closes by itself after three clean
            checks. On the host, <code>vectory logs</code> shows Vector's full
            output.
          </p>
        ) : (
          <p>
            Fix the cause, then retry on the device or deploy a corrected
            version. On the host, <code>vectory status</code> shows the same
            findings and <code>vectory logs</code> shows Vector's full output.
          </p>
        )}
        <DiagnosticList diagnostics={issue.diagnostics} />
        <DocLink
          topic="troubleshooting"
          section={
            issue.device_revoked
              ? "an-old-issue-stays-open-after-device-recovery"
              : isDataPlaneCode(issue.code)
                ? "a-pipeline-applies-but-delivers-nothing"
                : "a-pipeline-is-rejected-or-rolled-back"
          }
        >
          Troubleshooting guide
        </DocLink>
        <dl className="control-summary-list">
          <div>
            <dt>Attempts</dt>
            <dd>{attemptsLabel(issue.count, issue.reports, issue.code)}</dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd>{issueTime(issue.first_seen)}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>{issue.stage.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd className="control-wrap-code">{issue.code}</dd>
          </div>
          <div>
            <dt>Device ID</dt>
            <dd className="control-wrap-code">{issue.device_id}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function IssueActions({
  issue,
  user,
  onAct,
  stale = false,
}: {
  issue: Issue;
  user: User;
  stale?: boolean;
  onAct: (
    kind: Dialog["kind"],
    issue: Issue,
    target: HTMLButtonElement,
  ) => void;
}) {
  if (!canAct(user, issue)) return null;
  return (
    <div className="issue-actions">
      {!issue.device_revoked &&
        issue.desired_version_id &&
        !isDataPlaneCode(issue.code) && (
          <Button
            variant="secondary compact"
            aria-label={`Retry on device ${issue.device_name || ""}`.trim()}
            disabled={stale}
            onClick={(event) => onAct("retry", issue, event.currentTarget)}
          >
            Retry on device
          </Button>
        )}
      <Button
        variant="ghost compact"
        aria-label={`${issue.disposition === "acknowledged" ? "Reopen" : "Acknowledge"} issue on ${issue.device_name || "this device"}`}
        disabled={stale}
        onClick={(event) => onAct("disposition", issue, event.currentTarget)}
      >
        {issue.disposition === "acknowledged" ? "Reopen" : "Acknowledge"}
      </Button>
    </div>
  );
}

function IssueGroups({
  page,
  loading,
  error,
  updatedAt,
  retry,
  retrying,
  empty,
  actions,
  onPage,
}: {
  page: IssueGroupPage;
  loading: boolean;
  error: string;
  updatedAt: number | null;
  retry: () => void;
  retrying: boolean;
  empty: React.ReactNode;
  actions: (issue: Issue) => React.ReactNode;
  onPage: (page: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const failure = error && (
    <InlineError
      title={updatedAt ? "Couldn't refresh issues." : "Couldn't load issues."}
      error={error}
      updatedAt={updatedAt}
      retry={retry}
      retrying={retrying}
    />
  );
  if (failure && !page.items.length) return failure;
  if (loading && !page.items.length)
    return (
      <div className="issue-loading">
        <Spinner /> Loading issues
      </div>
    );
  if (!page.items.length) return empty;
  return (
    <div
      className={`issue-groups${loading ? " refreshing" : ""}`}
      aria-busy={loading || undefined}
      data-stale={failure ? "" : undefined}
    >
      {failure}
      {page.items.map((group) => (
        <IssueGroupCard
          key={group.key}
          group={group}
          expanded={expanded.has(group.key)}
          onToggle={() =>
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(group.key)) next.delete(group.key);
              else next.add(group.key);
              return next;
            })
          }
          actions={actions}
        />
      ))}
      {page.total > page.page_size && (
        <Pagination
          page={page.page}
          size={page.page_size}
          count={page.total}
          onPage={onPage}
        />
      )}
    </div>
  );
}

function IssueGroupCard({
  group,
  expanded,
  onToggle,
  actions,
}: {
  group: IssueGroup;
  expanded: boolean;
  onToggle: () => void;
  actions: (issue: Issue) => React.ReactNode;
}) {
  const fix = leadingDiagnostic(group.diagnostics)?.hint;
  const counts = (["open", "acknowledged", "resolved"] as const)
    .map((disposition) => ({
      disposition,
      count: group.devices.filter((issue) => issue.disposition === disposition)
        .length,
    }))
    .filter((entry) => entry.count > 0);
  const detailsId = `issue-group-${group.key}`;
  const columns: TableColumn<Issue>[] = [
    {
      id: "device",
      header: "Device",
      value: (issue) => issue.device_name,
      cell: (issue) => <DeviceCell issue={issue} />,
    },
    {
      id: "disposition",
      header: "Status",
      value: (issue) => issue.disposition,
      cell: (issue) => (
        <>
          <DispositionBadge issue={issue} />
          {issue.acknowledged && issue.acknowledgement_reason && (
            <small className="issue-note">{issue.acknowledgement_reason}</small>
          )}
        </>
      ),
    },
    {
      id: "count",
      header: "Attempts",
      value: (issue) => issue.count,
      cell: (issue) => attemptsLabel(issue.count, issue.reports, issue.code),
    },
    {
      id: "last_seen",
      header: "Last reported",
      value: (issue) => issue.last_seen,
      cell: (issue) => (
        <time dateTime={issue.last_seen || undefined}>
          {issueTime(issue.last_seen)}
        </time>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Device actions</span>,
      cell: actions,
    },
  ];
  return (
    <article className="issue-group" aria-labelledby={`${detailsId}-title`}>
      <div className="issue-group-header">
        <div>
          <h2 id={`${detailsId}-title`}>{group.title}</h2>
          <p className="issue-context">
            {group.version_id && group.configuration_id ? (
              <a
                href={`#/configurations/${encodeURIComponent(group.configuration_id)}`}
              >
                {versionLabel(group, group.version_id)}
              </a>
            ) : (
              versionLabel(group, group.version_id)
            )}
            {group.deployment_ids.map((id, index) => (
              <span key={id}>
                {" · "}
                <a href={`#/deployments/${encodeURIComponent(id)}`}>
                  {group.deployment_ids.length > 1
                    ? `Deployment ${index + 1}`
                    : "Deployment"}
                </a>
              </span>
            ))}
          </p>
        </div>
        <p className="issue-group-status">
          {group.issue_count > group.devices.length
            ? plural(group.issue_count, "issue")
            : counts.map((entry, index) => (
                <span
                  key={entry.disposition}
                  className={`issue-count ${entry.disposition}`}
                >
                  {index > 0 && "· "}
                  {entry.count} {labels[entry.disposition].toLowerCase()}
                </span>
              ))}
        </p>
      </div>
      <p className="issue-group-reason">{group.message}</p>
      {fix && (
        <p className="issue-fix">
          <strong>Fix</strong> {fix}
        </p>
      )}
      <p className="issue-group-meta">
        {plural(group.device_count, "device")} ·{" "}
        {attemptsLabel(group.attempts, group.reports, group.code)}
        {group.first_seen && (
          <> · failing since {issueTime(group.first_seen)}</>
        )}
        {group.last_seen && <> · last reported {issueTime(group.last_seen)}</>}
      </p>
      <button
        type="button"
        className="issue-group-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={onToggle}
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {expanded ? "Hide devices and findings" : "Show devices and findings"}
      </button>
      {expanded && (
        <div className="issue-group-details" id={detailsId}>
          {group.diagnostics.length > 0 && (
            <>
              <h3>What Vector reported</h3>
              <DiagnosticList diagnostics={group.diagnostics} />
            </>
          )}
          <h3>Devices</h3>
          <div className="control-table">
            <DataTable
              data={group.devices}
              columns={columns}
              rowKey={(issue) => issue.id}
              label={`Devices with ${group.title}`}
              className="issue-device-table"
              defaultSort={{ column: "last_seen", direction: "desc" }}
            />
          </div>
          {group.issue_count > group.devices.length && (
            <p className="control-muted">
              Showing the {group.devices.length} most recent of{" "}
              {group.issue_count.toLocaleString()} issues. Use All issues to
              browse every device.
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function RetryDialog({
  issue,
  user,
  close,
  onDone,
}: {
  issue: Issue;
  user: User;
  close: () => void;
  onDone: (message: string) => void;
}) {
  const device = useResource<Device | null>(
    `/devices/${encodeURIComponent(issue.device_id)}`,
    null,
  );
  const current = device.data;
  const changed =
    !!current && current.desired_version_id !== issue.desired_version_id;
  const review = current
    ? JSON.stringify([
        current.id,
        current.desired_version_id,
        current.desired_generation,
        current.apply_state,
        !!current.local_paused,
        !!current.sync_paused,
        current.retry_preconditions === true,
      ])
    : "";
  return (
    <Modal
      open
      onClose={close}
      title="Retry on device"
      description={`Ask ${issue.device_name || "this device"} to apply its current assignment again.`}
    >
      <div className="modal-body issue-review">
        <h3>{issue.title}</h3>
        <p>{issue.message}</p>
        {device.error && (
          <ErrorBox message={device.error} retry={device.reload} />
        )}
        {!current && device.loading ? (
          <div className="issue-loading">
            <Spinner /> Loading the device
          </div>
        ) : current ? (
          <>
            <dl className="control-summary-list">
              <div>
                <dt>Device</dt>
                <dd>{current.name}</dd>
              </div>
              <div>
                <dt>Current state</dt>
                <dd>
                  <StatusBadge domain="apply" value={current.apply_state} />
                </dd>
              </div>
              <div>
                <dt>Assignment</dt>
                <dd>
                  {current.desired_version_id
                    ? changed
                      ? "A different version than the one that failed"
                      : `${versionLabel(issue, issue.desired_version_id)} (the version that failed)`
                    : "No pipeline assigned"}
                </dd>
              </div>
            </dl>
            {changed && (
              <p className="control-note">
                This device's assignment changed after this failure. A retry
                applies its current assignment, not the version in this issue.
              </p>
            )}
            <p>
              Retry sends the same version again as a new attempt. Fix the cause
              first, or it will fail the same way. The device confirms success
              only when the agent verifies it.
            </p>
            {!eligibleState(current) && current.desired_version_id && (
              <p className="control-note">
                This device isn't in a failed state now, so there is nothing to
                retry. Check the device for its current status.
              </p>
            )}
            <DeviceApplicationRetry
              key={review}
              device={current}
              user={user}
              onDone={onDone}
              onRefresh={device.reload}
            />
          </>
        ) : null}
      </div>
      <div className="modal-footer">
        <a
          className="button secondary"
          href={`#/devices/${encodeURIComponent(issue.device_id)}`}
          onClick={close}
        >
          Open device
        </a>
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

function IssueDisposition({
  issue,
  close,
  onDone,
}: {
  issue: Issue;
  close: () => void;
  onDone: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState(issue),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const committing = useRef(false);
  // Keep the reviewed action stable. A conflict must never turn an
  // acknowledgement confirmation into an unintended reopen (or vice versa).
  const reopen = issue.disposition === "acknowledged";
  const expectedDisposition = reopen ? "acknowledged" : "open";
  const available =
    snapshot.device_revoked !== null &&
    !snapshot.resolved &&
    snapshot.disposition === expectedDisposition;
  const note = reason.trim();
  const tooLong = [...note].length > 1000;
  const missing = reopen && !note;
  useEffect(() => {
    const guard = (event: Event) => {
      if (committing.current) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!committing.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  async function refresh() {
    setRefreshing(true);
    try {
      setSnapshot(await api<Issue>(`/issues/${snapshot.id}`));
      setStale(false);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  async function save() {
    if (committing.current || stale || !available || missing || tooLong) return;
    committing.current = true;
    setBusy(true);
    setError("");
    try {
      await post<Issue>(
        `/issues/${snapshot.id}/${reopen ? "reopen" : "acknowledge"}`,
        note
          ? { revision: snapshot.revision, reason: note }
          : { revision: snapshot.revision },
      );
      onDone(
        reopen
          ? "Issue reopened. It is back in the open list."
          : "Issue acknowledged. Recovery has not been verified.",
      );
    } catch (failure) {
      if (failure instanceof APIError && failure.status === 409) {
        setStale(true);
        setError(
          "This issue changed since you opened it. Review the latest report before deciding again.",
        );
      } else setError((failure as Error).message);
    } finally {
      committing.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!committing.current) close();
      }}
      title={reopen ? "Reopen issue" : "Acknowledge issue"}
      description={
        reopen
          ? "Return this failure to the open list and record why it needs follow-up."
          : "Record that this failure is known and being handled. It leaves the open list until the device fails a new attempt."
      }
    >
      <div className="modal-body issue-review">
        <h3>{snapshot.title || snapshot.code}</h3>
        <p>{snapshot.message}</p>
        <dl className="control-summary-list">
          <div>
            <dt>Device</dt>
            <dd>
              {snapshot.device_name || "Unnamed device"}
              {snapshot.device_revoked && " (access revoked)"}
            </dd>
          </div>
          <div>
            <dt>Pipeline</dt>
            <dd>{versionLabel(snapshot, snapshot.desired_version_id)}</dd>
          </div>
          <div>
            <dt>Last reported</dt>
            <dd>
              {issueTime(snapshot.last_seen)} ·{" "}
              {attemptsLabel(snapshot.count, snapshot.reports, snapshot.code)}
            </dd>
          </div>
          <div>
            <dt>Current status</dt>
            <dd>{labels[snapshot.disposition]}</dd>
          </div>
        </dl>
        <p>
          {reopen
            ? "Reopening doesn't change the device or its pipeline."
            : snapshot.device_revoked
              ? "This device identity is retired and can't report recovery. Acknowledging records your decision; it doesn't verify a replacement."
              : "Acknowledging doesn't mark the device healthy. The issue resolves when the device verifies a configuration, and a new failed attempt reopens it."}
        </p>
        {!available && (
          <p className="control-note">
            {snapshot.disposition !== expectedDisposition
              ? `This issue is now ${labels[snapshot.disposition].toLowerCase()}. Close this dialog to review it in the issue list.`
              : "This issue can no longer be changed: it is resolved, or its device no longer exists."}
          </p>
        )}
        {error && <ErrorBox message={error} />}
        {stale && (
          <Button
            variant="secondary"
            busy={refreshing}
            onClick={() => void refresh()}
          >
            Review latest issue
          </Button>
        )}
        <Field
          label={reopen ? "Reason for reopening" : "Note (optional)"}
          hint={
            reopen
              ? "Required. Recorded in the audit log; avoid secrets."
              : "Shown with the acknowledgement and recorded in the audit log; avoid secrets."
          }
        >
          <textarea
            rows={3}
            value={reason}
            disabled={busy || refreshing || !available}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {tooLong && (
          <p role="alert">Keep the note to 1,000 characters or fewer.</p>
        )}
      </div>
      <div className="modal-footer">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (!committing.current) close();
          }}
        >
          Cancel
        </Button>
        <Button
          busy={busy}
          disabled={stale || refreshing || !available || missing || tooLong}
          onClick={() => void save()}
        >
          {reopen ? "Reopen issue" : "Acknowledge issue"}
        </Button>
      </div>
    </Modal>
  );
}
