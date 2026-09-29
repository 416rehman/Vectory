import { useEffect, useRef, useState } from "react";
import {
  APIError,
  api,
  can,
  post,
  when,
  type Issue,
  type IssueHistoryPage,
  type User,
} from "./api";
import {
  Badge,
  Button,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  RefreshButton,
  SearchBox,
  useResource,
} from "./ui";
import DocLink from "./DocLink";
import { DataTable, type TableColumn, type TableSort } from "./DataTable";
import "./control.css";
import "./issues.css";

const words = (value: string) =>
  value.replaceAll("_", " ").replaceAll(".", " ");
const issueTime = (value: string | null) =>
  value ? when(value) : "Unavailable";
type Disposition = Issue["disposition"] | "all";
const labels = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  all: "All issues",
};
const emptyPage: IssueHistoryPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: 12,
};

export default function Issues({
  user,
  notify,
  navigate,
  deviceId,
}: {
  user: User;
  notify: (message: string) => void;
  navigate: (path: string) => void;
  deviceId?: string;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [state, setState] = useState<Disposition>("open"),
    [sort, setSort] = useState<TableSort | null>({
      column: "last_seen",
      direction: "desc",
    }),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<Issue | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null),
    container = useRef<HTMLDivElement | null>(null);
  function closeIssue(saved = false) {
    setSelected(null);
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
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    setPage(1);
  }, [deviceId]);
  const params = new URLSearchParams({
    search: query,
    state,
    page: String(page),
    page_size: "12",
    sort: sort?.column || "last_seen",
    direction: sort?.direction || "desc",
  });
  if (deviceId) params.set("device_id", deviceId);
  const resource = useResource<IssueHistoryPage>(
    `/issues/history?${params}`,
    emptyPage,
  );
  useEffect(() => {
    if (!resource.loading && !resource.error)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(resource.data.total / 12))),
      );
  }, [resource.loading, resource.error, resource.data.total]);
  const columns: TableColumn<Issue>[] = [
    {
      id: "code",
      header: "Issue",
      value: (issue) => issue.code,
      className: "issue-summary-cell",
      cell: (issue) => (
        <div className="issue-summary">
          <strong>{words(issue.code)}</strong>
          <p>{issue.message}</p>
          {issue.acknowledged && (
            <div className="issue-acknowledgement">
              <p>
                <strong>
                  Acknowledged by {issue.acknowledged_by_name || "an operator"}
                </strong>
                {issue.acknowledged_at && <> · {when(issue.acknowledged_at)}</>}
              </p>
              <p>{issue.acknowledgement_reason}</p>
            </div>
          )}
          <details className="control-disclosure">
            <summary>Investigation details</summary>
            {issue.disposition === "resolved" ? (
              <p>
                This device reported a verified configuration application after
                the failure. Check its current status for present health.
              </p>
            ) : issue.device_revoked ? (
              <p>
                This device identity is retired and cannot report recovery.
                Check any replacement separately. Acknowledging records your
                decision and removes this issue from the open list; it does not
                verify recovery.
              </p>
            ) : (
              <p>
                Run <code>vectory doctor</code> on this device. Check its error,
                Vector version, permissions, and available disk, then fix the
                cause and retry from the device page.
              </p>
            )}
            <DocLink
              topic="troubleshooting"
              section={
                issue.device_revoked
                  ? "an-old-issue-stays-open-after-device-recovery"
                  : "a-pipeline-is-rejected-or-rolled-back"
              }
            >
              Troubleshooting guide
            </DocLink>
            <dl className="control-summary-list">
              <div>
                <dt>Device ID</dt>
                <dd className="control-wrap-code">{issue.device_id}</dd>
              </div>
              <div>
                <dt>Stage</dt>
                <dd>{words(issue.stage)}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>{issueTime(issue.first_seen)}</dd>
              </div>
              <div>
                <dt>Code</dt>
                <dd className="control-wrap-code">{issue.code}</dd>
              </div>
            </dl>
          </details>
        </div>
      ),
    },
    {
      id: "disposition",
      header: "Status",
      value: (issue) => issue.disposition,
      filter: {
        value: state,
        onChange: (value) => {
          setState(value as Disposition);
          setPage(1);
        },
        emptyValue: "all",
        allLabel: "All issues",
        manual: true,
        options: Object.entries(labels)
          .filter(([value]) => value !== "all")
          .map(([value, label]) => ({ value, label })),
      },
      cell: (issue) => (
        <Badge
          status={
            issue.disposition === "open"
              ? "failed"
              : issue.disposition === "resolved"
                ? "completed"
                : undefined
          }
        >
          {labels[issue.disposition]}
        </Badge>
      ),
    },
    {
      id: "device",
      header: "Device",
      value: (issue) => issue.device_name,
      cell: (issue) => (
        <>
          <a
            className="control-row-title"
            href={`#/devices/${encodeURIComponent(issue.device_id)}`}
          >
            {issue.device_name || "Open device"}
          </a>
          {issue.device_revoked && <small>Device access revoked</small>}
        </>
      ),
    },
    {
      id: "last_seen",
      header: "Last seen",
      value: (issue) => issue.last_seen,
      cell: (issue) => (
        <time dateTime={issue.last_seen || undefined}>
          {issueTime(issue.last_seen)}
        </time>
      ),
    },
    {
      id: "count",
      header: "Occurrences",
      value: (issue) => issue.count,
      cell: (issue) => issue.count,
    },
    {
      id: "actions",
      header: <span className="sr-only">Issue actions</span>,
      cell: (issue) => (
        <>
          {can(user, "operate") &&
            issue.device_revoked === true &&
            !issue.resolved && (
              <Button
                variant="secondary"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setSelected(issue);
                }}
              >
                {issue.disposition === "acknowledged"
                  ? "Reopen issue"
                  : "Acknowledge issue"}
              </Button>
            )}
        </>
      ),
    },
  ];
  return (
    <div className="control-page issue-page" ref={container}>
      <PageHeader
        title="Issues"
        description="Agent failures, investigation, and recorded follow-up."
        help={{
          topic: "troubleshooting",
          section: "an-old-issue-stays-open-after-device-recovery",
        }}
      />
      <div className="control-toolbar issue-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder="Search devices, codes, or messages"
        />
        <RefreshButton
          busy={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await resource.reload();
            } finally {
              setRefreshing(false);
            }
          }}
          disabled={resource.loading}
        >
          Refresh
        </RefreshButton>
      </div>
      {deviceId && (
        <p className="issue-scope">
          Issues for{" "}
          <a href={`#/devices/${encodeURIComponent(deviceId)}`}>
            {resource.data.items[0]?.device_name || "this device"}
          </a>{" "}
          <Button variant="ghost" onClick={() => navigate("issues")}>
            Show all devices
          </Button>
        </p>
      )}
      {resource.error && (
        <ErrorBox message={resource.error} retry={resource.reload} />
      )}
      <div className="control-table issue-table-panel">
        <DataTable
          data={resource.error ? [] : resource.data.items}
          columns={columns}
          rowKey={(issue) => issue.id}
          label="Issues"
          className="issue-table"
          loading={resource.loading}
          manualSorting
          sort={sort}
          onSortChange={(value) => {
            setSort(value);
            setPage(1);
          }}
          pagination={
            resource.error
              ? undefined
              : {
                  page,
                  size: 12,
                  total: resource.data.total,
                  onPage: setPage,
                }
          }
          empty={
            resource.error ? (
              "Issues could not be loaded."
            ) : (
              <div className="control-empty">
                <h2>
                  {query
                    ? "No matching issues"
                    : `No ${state === "all" ? "reported" : state} issues`}
                </h2>
                <p>
                  {query
                    ? "Try another search or status."
                    : state === "open"
                      ? "No open failures have been reported. Check Devices for connectivity and current health."
                      : "Issues with this status will appear here."}
                </p>
              </div>
            )
          }
        />
      </div>
      {selected && (
        <IssueDisposition
          key={`${selected.id}:${selected.revision}`}
          issue={selected}
          close={() => {
            closeIssue();
            void resource.reload();
          }}
          onDone={(message) => {
            closeIssue(true);
            void resource.reload();
            notify(message);
          }}
        />
      )}
    </div>
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
    snapshot.device_revoked === true &&
    !snapshot.resolved &&
    snapshot.disposition === expectedDisposition;
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
    if (
      committing.current ||
      stale ||
      !available ||
      !reason.trim() ||
      [...reason.trim()].length > 1000
    )
      return;
    committing.current = true;
    setBusy(true);
    setError("");
    try {
      await post<Issue>(
        `/issues/${snapshot.id}/${reopen ? "reopen" : "acknowledge"}`,
        { revision: snapshot.revision, reason: reason.trim() },
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
      title={reopen ? "Reopen issue" : "Acknowledge retired-device issue"}
      description={
        reopen
          ? "Return this failure to the open list and record why it needs follow-up."
          : "Record your decision about this retired identity. Its failure will remain in the issue history."
      }
    >
      <div className="modal-body issue-review">
        <h3>{words(snapshot.code)}</h3>
        <p>{snapshot.message}</p>
        <dl className="control-summary-list">
          <div>
            <dt>Device</dt>
            <dd>{snapshot.device_name || "Unnamed device"}</dd>
          </div>
          <div>
            <dt>Device ID</dt>
            <dd className="control-wrap-code">{snapshot.device_id}</dd>
          </div>
          <div>
            <dt>Last reported</dt>
            <dd>
              {issueTime(snapshot.last_seen)} · {snapshot.count}{" "}
              {snapshot.count === 1 ? "occurrence" : "occurrences"}
            </dd>
          </div>
          <div>
            <dt>Current status</dt>
            <dd>{labels[snapshot.disposition]}</dd>
          </div>
        </dl>
        <p>
          {reopen
            ? "Reopening does not reconnect the retired device or change its pipeline."
            : "Acknowledgement removes this from the open issue count. It does not mark the device healthy or confirm that a replacement recovered."}
        </p>
        {!available && (
          <p className="control-note">
            {snapshot.disposition !== expectedDisposition
              ? `This issue is now ${labels[snapshot.disposition].toLowerCase()}. Close this dialog to review it in the issue list.`
              : "This issue is no longer eligible. Only unresolved issues on revoked device identities can be acknowledged or reopened."}
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
          label={reopen ? "Reason for reopening" : "Reason for acknowledgement"}
          hint="Required. Recorded in the audit log; avoid secrets or private diagnostics."
        >
          <textarea
            rows={3}
            value={reason}
            disabled={busy || refreshing || !available}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {[...reason.trim()].length > 1000 && (
          <p role="alert">Keep the reason to 1,000 characters or fewer.</p>
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
          disabled={
            stale ||
            refreshing ||
            !available ||
            !reason.trim() ||
            [...reason.trim()].length > 1000
          }
          onClick={() => void save()}
        >
          {reopen ? "Reopen issue" : "Acknowledge issue"}
        </Button>
      </div>
    </Modal>
  );
}
