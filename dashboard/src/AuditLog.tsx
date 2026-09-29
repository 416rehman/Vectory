import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Copy,
  Download,
  ExternalLink,
  ScrollText,
} from "lucide-react";
import {
  api,
  post,
  type AuditDetail,
  type AuditSummary,
  type AuditHistoryPage,
  type AuditExport,
} from "./api";
import {
  Button,
  DateCell,
  EmptyState,
  ErrorBox,
  FilterChips,
  InlineError,
  Modal,
  PageHeader,
  PageToolbar,
  SearchBox,
  SegmentedControl,
  Skeleton,
  Spinner,
  StatusBadge,
  useResource,
  type FilterChip,
} from "./ui";
import {
  auditActions,
  auditActionLabel,
  auditChanges,
  auditDateError,
  auditFamilies,
  auditFilterParams,
  auditFilterSummary,
  auditHistoryPath,
  auditOutcomeLabel,
  auditResourceRoute,
  auditRoute,
  auditScopes,
  auditScopeSummary,
  defaultAuditQuery,
  effectiveAuditScope,
  isAuditId,
  normalizeAuditQuery,
  type AuditQuery,
  type AuditScope,
} from "./auditModel";
export type { AuditQuery } from "./auditModel";
import { exactLocal, exactUtc, shortLocal } from "./time";
import "./audit.css";
import { DataTable, TableCard, type TableColumn } from "./DataTable";
import DocLink from "./DocLink";
import { auditOutcomes } from "./status";

const emptyPage: AuditHistoryPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: 12,
};
const defaultNavigate = (path: string) => {
  window.location.hash = `#/${path}`;
};
type Navigate = (path: string) => void;

function ResourceLink({
  kind,
  id,
  name,
  navigate,
}: {
  kind?: string | null;
  id?: string | null;
  name: string;
  navigate: Navigate;
}) {
  const route = auditResourceRoute(kind, id);
  return route ? (
    <a
      href={`#/${route}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {name}
    </a>
  ) : (
    <span>{name}</span>
  );
}

function Result({ outcome }: { outcome: string }) {
  return (
    <StatusBadge domain="audit" value={outcome} className="audit-result" />
  );
}

function Loading({ children }: { children: React.ReactNode }) {
  return (
    <div className="audit-loading" role="status">
      <Spinner />
      {children}
    </div>
  );
}

/** Second-precision local time, with the exact local and UTC time on hover. */
function EventTime({ value }: { value: string | null }) {
  return value ? (
    <time
      dateTime={value}
      title={`${exactLocal(value)} · ${exactUtc(value)}`}
      className="audit-time"
    >
      {shortLocal(value)}
    </time>
  ) : (
    <span className="audit-muted">Time unavailable</span>
  );
}

const systemActors: Record<string, string> = {
  scheduler: "Scheduler (automatic)",
  "local-admin": "Local administrator",
  anonymous: "Unauthenticated request",
};
function actorLabel(item: Pick<AuditSummary, "actor" | "actor_kind">) {
  return (
    (item.actor_kind === "system" && systemActors[item.actor]) ||
    item.actor ||
    "Unknown actor"
  );
}
const kindLabels: Record<string, string> = {
  deployment: "Deployment",
  configuration: "Pipeline",
  device: "Device",
  issue: "Issue",
  group: "Group",
  policy: "Agent settings",
  token: "Enrollment token",
  user: "Person",
};
/** A readable target: its name, else its kind and short ID, never a raw compound key. */
function targetLabel(
  item: Pick<
    AuditSummary,
    "target" | "target_id" | "target_kind" | "target_name"
  >,
) {
  if (item.target_name) return item.target_name;
  const kind = kindLabels[item.target_kind];
  if (kind && item.target_id && isAuditId(item.target_id))
    return `${kind} ${item.target_id.slice(0, 8)}`;
  return item.target;
}

const scopeHints: Record<AuditScope, string> = {
  changes: "Sign-ins are hidden. Account and settings changes still show.",
  security: "Only sign-ins, account, authenticator and signing-key events.",
  all: "Every recorded event, including sign-ins.",
};

export function AuditLog({
  navigate = defaultNavigate,
  initialDeviceId,
  initialQuery,
  onQueryChange,
  selectedAuditId,
  routeKey,
  routeQuery,
}: {
  navigate?: Navigate;
  initialDeviceId?: string;
  initialQuery?: AuditQuery;
  onQueryChange?(query: AuditQuery): void;
  selectedAuditId?: string | null;
  routeKey?: string;
  routeQuery?: AuditQuery;
}) {
  const [query, setQuery] = useState(() =>
    normalizeAuditQuery(
      routeQuery || initialQuery || { device_id: initialDeviceId || "" },
    ),
  );
  const [search, setSearch] = useState(query.search);
  const [filterDraft, setFilterDraft] = useState(query);
  const [localId, setLocalId] = useState<string | null>(null);
  const [exportQuery, setExportQuery] = useState<AuditQuery | null>(null);
  const priorRoute = useRef(routeKey);
  const controlled = selectedAuditId !== undefined;
  const detailId =
    (controlled ? selectedAuditId : localId)?.toLowerCase() || null;
  const opener = useRef<HTMLElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const previousId = useRef(detailId);
  useEffect(() => {
    if (priorRoute.current === routeKey) return;
    priorRoute.current = routeKey;
    const next = normalizeAuditQuery(
      routeQuery || { device_id: initialDeviceId || "" },
    );
    setQuery(next);
    setSearch(next.search);
    setFilterDraft(next);
  }, [routeKey, routeQuery, initialDeviceId]);
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = normalizeAuditQuery({ ...query, search }).search;
      if (next !== query.search)
        setQuery((current) => ({ ...current, search: next, page: 1 }));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query.search]);
  useEffect(() => {
    if (previousId.current && !detailId)
      requestAnimationFrame(() => {
        (opener.current?.isConnected
          ? opener.current
          : container.current?.querySelector<HTMLInputElement>(
              ".search-field input",
            )
        )?.focus();
      });
    previousId.current = detailId;
  }, [detailId]);
  const dateError = auditDateError(query.from, query.to);
  const events = useResource<AuditHistoryPage>(
    dateError ? null : auditHistoryPath(query),
    emptyPage,
  );
  const { data, loading, error, reload } = events;
  useEffect(() => {
    if (
      !loading &&
      !error &&
      !dateError &&
      query.page > Math.max(1, Math.ceil(data.total / 12))
    ) {
      setQuery((current) => ({
        ...current,
        page: Math.max(1, Math.ceil(data.total / 12)),
      }));
    }
  }, [loading, error, dateError, query.page, data.total]);
  const summary = auditFilterSummary(query);
  function openDetail(id: string, element: HTMLElement) {
    // Return focus to the row's event link, the keyboard path to this dialog.
    opener.current =
      element.querySelector<HTMLElement>(".audit-event-title") ?? element;
    if (controlled) {
      keepListRoute(query);
      navigate(auditRoute(id, query));
    } else setLocalId(id);
  }
  function closeDetail() {
    if (controlled) navigate(auditRoute(null, query));
    else setLocalId(null);
  }
  function applyScope(patch: Partial<AuditQuery>) {
    const next = normalizeAuditQuery({ ...query, ...patch, page: 1 });
    setQuery(next);
    setSearch(next.search);
    setFilterDraft(next);
    if (controlled && detailId) navigate(auditRoute(null, next));
    else setLocalId(null);
  }
  const filterError = auditDateError(filterDraft.from, filterDraft.to);
  const filterSelection = query.action
    ? `action:${query.action}`
    : query.family
      ? `family:${query.family}`
      : "";
  const actorName =
    data.items.find((item) => item.actor_id === query.actor_id)?.actor ||
    query.actor_id;
  const chips: FilterChip[] = [
    query.search && {
      id: "search",
      label: `Search: ${query.search}`,
      text: `search ${query.search}`,
      onRemove: () => applyScope({ search: "" }),
    },
    (query.action || query.family) && {
      id: "event",
      label: query.action
        ? auditActionLabel(query.action)
        : `${auditFamilies[query.family] || query.family} events`,
      text: "event",
      onRemove: () => applyScope({ action: "", family: "" }),
    },
    query.outcome && {
      id: "outcome",
      label: `Result: ${auditOutcomeLabel(query.outcome)}`,
      text: "result",
      onRemove: () => applyScope({ outcome: "" }),
    },
    query.from && {
      id: "from",
      label: `From: ${query.from}`,
      text: "start date",
      onRemove: () => applyScope({ from: "" }),
    },
    query.to && {
      id: "to",
      label: `Through: ${query.to}`,
      text: "end date",
      onRemove: () => applyScope({ to: "" }),
    },
    query.device_id && {
      id: "device",
      label: `Device ${query.device_id}`,
      text: "device",
      onRemove: () => applyScope({ device_id: "" }),
    },
    query.actor_id && {
      id: "actor",
      label: `Actor ${actorName}`,
      text: "actor",
      onRemove: () => applyScope({ actor_id: "" }),
    },
    query.target_id && {
      id: "target",
      label: `Target ${query.target_id}`,
      text: "target",
      onRemove: () => applyScope({ target_id: "" }),
    },
  ].filter(Boolean) as FilterChip[];
  const eventFilter = !!(query.action || query.family);
  // The event name is the keyboard path to its details; rows and cards also
  // open them on click.
  const eventLink = (item: AuditSummary) => (
    <a
      className="audit-event-title"
      href={`#/${auditRoute(item.id, query)}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        openDetail(item.id, event.currentTarget);
      }}
    >
      {auditActionLabel(item.action)}
    </a>
  );
  const columns: TableColumn<AuditSummary>[] = [
    {
      id: "action",
      header: "Event",
      value: (item) => item.action,
      filter: {
        manual: true,
        active: eventFilter,
        onClear: () => applyScope({ action: "", family: "" }),
        content: (
          <div className="audit-column-fields">
            <label>
              Event
              <select
                aria-label="Event"
                value={filterSelection}
                onChange={(event) => {
                  const [kind, value] = event.target.value.split(":");
                  applyScope({
                    action: kind === "action" ? value : "",
                    family: kind === "family" ? value : "",
                  });
                }}
              >
                <option value="">All events</option>
                <optgroup label="Event groups">
                  {Object.entries(auditFamilies).map(([key, name]) => (
                    <option key={key} value={`family:${key}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Specific events">
                  {Object.entries(auditActions).map(([key, name]) => (
                    <option key={key} value={`action:${key}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
                {filterSelection &&
                  !(query.action
                    ? auditActions[query.action]
                    : auditFamilies[query.family]) && (
                    <option value={filterSelection}>
                      {query.action || query.family}
                    </option>
                  )}
              </select>
            </label>
            <p className="audit-muted">
              An event filter shows matching events of any kind. Sorting uses
              the event type code.
            </p>
          </div>
        ),
      },
      cell: (item) => (
        <span className="audit-event">
          {eventLink(item)}
          {(item.target_name || item.target) && (
            <span className="audit-target">
              <ResourceLink
                kind={item.target_kind}
                id={item.target_exists === false ? null : item.target_id}
                name={targetLabel(item)}
                navigate={navigate}
              />
            </span>
          )}
        </span>
      ),
    },
    {
      id: "actor",
      header: "By",
      value: (item) => item.actor,
      width: "20%",
      filter: query.actor_id
        ? {
            manual: true,
            active: true,
            onClear: () => applyScope({ actor_id: "" }),
            content: (
              <p className="audit-muted" title={query.actor_id}>
                Showing activity by <strong>{actorName}</strong>.
              </p>
            ),
          }
        : undefined,
      cell: (item) => (
        <span className="audit-actor">
          <ResourceLink
            kind={item.actor_kind}
            id={item.actor_id}
            name={actorLabel(item)}
            navigate={navigate}
          />
        </span>
      ),
    },
    {
      id: "outcome",
      header: "Result",
      value: (item) => item.outcome,
      width: 176,
      filter: {
        manual: true,
        value: query.outcome,
        allLabel: "All results",
        options: [
          ...Object.entries(auditOutcomes).map(([value, { label }]) => ({
            value,
            label: value === "failure" ? `${label} (request)` : label,
          })),
          ...(query.outcome && !Object.hasOwn(auditOutcomes, query.outcome)
            ? [
                {
                  value: query.outcome,
                  label: auditOutcomeLabel(query.outcome),
                },
              ]
            : []),
        ],
        onChange: (outcome) => applyScope({ outcome }),
      },
      cell: (item) => <Result outcome={item.outcome} />,
    },
    {
      id: "created_at",
      header: "Time",
      value: (item) => item.created_at,
      width: 168,
      defaultDirection: "desc",
      filter: {
        manual: true,
        active: !!(query.from || query.to),
        onClear: () => applyScope({ from: "", to: "" }),
        content: (
          <form
            className="audit-column-fields"
            onSubmit={(event) => {
              event.preventDefault();
              if (!filterError)
                applyScope({ from: filterDraft.from, to: filterDraft.to });
            }}
          >
            <label>
              From
              <input
                aria-label="From date"
                type="date"
                value={filterDraft.from}
                onChange={(event) =>
                  setFilterDraft((current) => ({
                    ...current,
                    from: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Through
              <input
                aria-label="Through date"
                type="date"
                value={filterDraft.to}
                onChange={(event) =>
                  setFilterDraft((current) => ({
                    ...current,
                    to: event.target.value,
                  }))
                }
              />
            </label>
            <p className="audit-muted">Dates include the whole day in UTC.</p>
            {filterError && (
              <p role="alert" className="audit-validation">
                {filterError}
              </p>
            )}
            <Button type="submit" disabled={!!filterError}>
              Apply dates
            </Button>
          </form>
        ),
      },
      cell: (item) => <EventTime value={item.created_at} />,
    },
  ];
  const filtered = summary.length > 0;
  return (
    <div className="audit-page" ref={container}>
      <PageHeader
        title="Audit log"
        help={{
          topic: "administer",
          section: "review-and-export-audit-events",
        }}
        description="Changes, access and device events across your workspace."
        live={
          dateError
            ? undefined
            : {
                updatedAt: events.updatedAt,
                error,
                loading,
                refreshing: events.refreshing,
                onRefresh: () => void reload(),
              }
        }
      >
        <Button
          variant="secondary"
          icon={Download}
          disabled={
            loading || !!error || !!dateError || search.trim() !== query.search
          }
          onClick={() => setExportQuery({ ...query })}
        >
          Export results
        </Button>
      </PageHeader>
      <PageToolbar
        search={
          <SearchBox
            value={search}
            onChange={(value) =>
              setSearch(Array.from(value).slice(0, 200).join(""))
            }
            placeholder="Search activity"
            shortcut
          />
        }
        count={
          loading && !events.updatedAt
            ? undefined
            : `${data.total.toLocaleString()} ${data.total === 1 ? "event" : "events"}`
        }
        filters={
          <FilterChips
            chips={chips}
            onClearAll={() =>
              applyScope({ ...defaultAuditQuery, scope: query.scope })
            }
            clearLabel="Clear filters"
            clearFrom={1}
          />
        }
      >
        <SegmentedControl
          label="Event scope"
          options={auditScopes}
          value={eventFilter ? "all" : query.scope}
          onChange={(scope) => applyScope({ scope })}
          disabled={eventFilter}
          hint="An event filter is selected, so matching events of any kind are shown."
        />
      </PageToolbar>
      {!eventFilter && query.scope !== "all" && (
        <p className="audit-scope-note">
          {scopeHints[query.scope]}{" "}
          {query.scope === "changes" ? (
            <button
              type="button"
              className="audit-text-button"
              onClick={() => applyScope({ scope: "security" })}
            >
              Show security events
            </button>
          ) : (
            <button
              type="button"
              className="audit-text-button"
              onClick={() => applyScope({ scope: "changes" })}
            >
              Show changes
            </button>
          )}
        </p>
      )}
      {dateError && <ErrorBox message={dateError} />}
      {error && !dateError && (
        <InlineError
          title={
            data.items.length
              ? "Couldn't refresh the audit log."
              : "Couldn't load the audit log."
          }
          error={error}
          updatedAt={events.updatedAt}
          retry={() => void reload()}
          retrying={events.refreshing}
        />
      )}
      <TableCard>
        <DataTable
          data={dateError ? [] : data.items}
          columns={columns}
          rowKey={(item) => item.id}
          label="Audit events"
          className="audit-table"
          loading={loading && !events.updatedAt}
          skeletonRows={8}
          manualSorting
          sort={{ column: query.sort, direction: query.direction }}
          onSortChange={(sort) =>
            applyScope({
              sort: (sort?.column || "created_at") as AuditQuery["sort"],
              direction: sort?.direction || "desc",
            })
          }
          onRowClick={(item, event) => openDetail(item.id, event.currentTarget)}
          pagination={{
            page: query.page,
            size: 12,
            total: dateError ? 0 : data.total,
            onPage: (page) => setQuery((current) => ({ ...current, page })),
            noun: "events",
          }}
          mobileCard={(item) => ({
            title: eventLink(item),
            status: <Result outcome={item.outcome} />,
            meta: [
              targetLabel(item),
              actorLabel(item) === targetLabel(item) ? null : actorLabel(item),
              item.created_at
                ? shortLocal(item.created_at)
                : "Time unavailable",
            ],
          })}
          empty={
            error ? (
              <EmptyState variant="error" title="Activity could not be loaded">
                {error}
              </EmptyState>
            ) : dateError ? (
              <EmptyState
                variant="filtered"
                title="Choose a valid date range"
              />
            ) : filtered ? (
              <EmptyState
                variant="filtered"
                title="No matching events"
                action={
                  <Button
                    variant="secondary"
                    onClick={() =>
                      applyScope({ ...defaultAuditQuery, scope: query.scope })
                    }
                  >
                    Clear filters
                  </Button>
                }
              >
                Change or clear the filters to see more activity.
              </EmptyState>
            ) : (
              <EmptyState
                variant="quiet"
                icon={ScrollText}
                title={
                  query.scope === "security"
                    ? "No security events recorded"
                    : "No activity recorded"
                }
              >
                {query.scope === "security"
                  ? "Sign-ins, account and authenticator changes will appear here."
                  : "Pipeline changes, enrollments and deployments will appear here."}
              </EmptyState>
            )
          }
        />
      </TableCard>
      {detailId && (
        <AuditInspector
          key={detailId}
          id={detailId}
          query={query}
          navigate={navigate}
          onClose={closeDetail}
          onActor={(actor_id) => applyScope({ actor_id })}
        />
      )}
      {exportQuery && (
        <ExportAudit
          query={exportQuery}
          approximateCount={data.total}
          onClose={() => setExportQuery(null)}
        />
      )}
    </div>
  );
}

/** Keep the list route under the dialog so closing returns to this view. */
function keepListRoute(query: AuditQuery) {
  window.history.replaceState(
    window.history.state,
    "",
    `#/${auditRoute(null, query)}`,
  );
}

function AuditPermalink({ route }: { route: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "manual">(
    "idle",
  );
  const input = useRef<HTMLInputElement | null>(null);
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `#/${route}`;
  const link = url.href;
  useEffect(() => {
    if (state === "manual") {
      input.current?.focus();
      input.current?.select();
    }
  }, [state]);
  async function copy() {
    setState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(link);
      setState("copied");
    } catch {
      setState("manual");
    }
  }
  return (
    <div className="audit-permalink">
      <div className="audit-actions">
        <Button
          variant="secondary compact"
          icon={Copy}
          busy={state === "copying"}
          onClick={copy}
          aria-label="Copy event link"
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
      </div>
      {state === "manual" && (
        <label className="audit-link-fallback">
          Event link
          <input ref={input} readOnly value={link} />
          <span>
            Clipboard access is unavailable. Select and copy the link.
          </span>
        </label>
      )}
      <span className="sr-only" role="status">
        {state === "copied" ? "Event link copied." : ""}
      </span>
    </div>
  );
}

const detailLabels: Record<string, string> = {
  reason: "Reason",
  issue_revision: "Issue revision",
  revision: "Revision",
  configuration_revision: "Pipeline revision",
  version_number: "Version",
  generation: "Configuration generation",
  policy_generation: "Policy generation",
  secret_revision: "Secret revision",
  old_device_id: "Previous device ID",
  new_device_id: "Replacement device ID",
  device_id: "Device ID",
  deployment_id: "Deployment ID",
  configuration_id: "Pipeline ID",
  version_id: "Version ID",
  request_id: "Request ID",
  correlation_id: "Correlation ID",
  retry_generation: "Retry generation",
  state: "State",
  previous_state: "Previous state",
  source_revision: "Source revision",
  issue_id: "Issue ID",
  previous_secret_revision: "Previous secret revision",
  actual_sha256: "Effective configuration digest",
  applied_template_sha256: "Template digest",
  previous_generation: "Previous configuration generation",
  previous_policy_generation: "Previous policy generation",
  secret_revision_floor: "Secret revision floor",
  sha256: "Configuration digest",
  policy_sha256: "Agent settings digest",
  browser_sessions: "Browser sessions",
  password_reset_codes: "Password reset codes",
  enrollment_tokens_to_revoke: "Enrollment tokens to revoke",
  mfa_recovery_codes: "Authenticator recovery codes",
  previous_device_id: "Previous device ID",
  replacement_device_id: "Replacement device ID",
  previous_signing_key_id: "Previous signing key ID",
  signing_key_id: "Signing key ID",
  reason_code: "Refusal reason",
  name: "Device name",
  token_id: "Enrollment token ID",
  agent_os: "Agent operating system",
  agent_arch: "Agent architecture",
  agent_version: "Agent version",
  configuration_mode: "Configuration mode",
  client_address: "Client address",
};

function AuditInspector({
  id,
  query,
  navigate,
  onClose,
  onActor,
}: {
  id: string;
  query: AuditQuery;
  navigate: Navigate;
  onClose(): void;
  onActor(id: string): void;
}) {
  const valid = isAuditId(id);
  const { data, loading, error, reload } = useResource<AuditDetail | null>(
    valid ? `/audit/${id}` : null,
    null,
  );
  const changes = data ? auditChanges(data.details) : [];
  return (
    <Modal
      open
      onClose={onClose}
      title="Event details"
      description="The recorded action and its associated identities."
      size="lg"
    >
      <div className="modal-body audit-inspector">
        {!valid ? (
          <p role="alert">This event link has an invalid identifier.</p>
        ) : loading ? (
          <div className="audit-inspector-loading" aria-busy="true">
            <Loading>Loading event…</Loading>
            <Skeleton width="60%" height={14} />
            <Skeleton width="80%" height={12} />
          </div>
        ) : error ? (
          <ErrorBox message={error} retry={reload} />
        ) : (
          data && (
            <>
              <div className="audit-detail-title">
                <h2>{auditActionLabel(data.action)}</h2>
                <Result outcome={data.outcome} />
              </div>
              <p className="audit-detail-time">
                {data.created_at ? (
                  <>
                    <time dateTime={data.created_at}>
                      {exactLocal(data.created_at)}
                    </time>
                    <span className="audit-muted">
                      {exactUtc(data.created_at)}
                    </span>
                  </>
                ) : (
                  <span className="audit-muted">Time unavailable</span>
                )}
              </p>
              <AuditPermalink route={auditRoute(id, query)} />
              <dl className="audit-detail-list">
                <div>
                  <dt>By</dt>
                  <dd>
                    <ResourceLink
                      kind={data.actor_kind}
                      id={data.actor_id}
                      name={actorLabel(data)}
                      navigate={navigate}
                    />
                    {data.actor_id && (
                      <button
                        className="audit-text-button"
                        onClick={() => onActor(data.actor_id)}
                      >
                        View this actor’s activity
                      </button>
                    )}
                  </dd>
                </div>
                {(data.target_name || data.target) && (
                  <div>
                    <dt>Target</dt>
                    <dd>
                      <ResourceLink
                        kind={data.target_kind}
                        id={
                          data.target_exists === false ? null : data.target_id
                        }
                        name={targetLabel(data)}
                        navigate={navigate}
                      />
                    </dd>
                  </div>
                )}
                {data.device_id && data.target_kind !== "device" && (
                  <div>
                    <dt>Device</dt>
                    <dd>
                      <ResourceLink
                        kind="device"
                        id={data.device_id}
                        name={data.device_id}
                        navigate={navigate}
                      />
                    </dd>
                  </div>
                )}
                {typeof data.details?.reason === "string" && (
                  <div>
                    <dt>Reason</dt>
                    <dd className="audit-reason">{data.details.reason}</dd>
                  </div>
                )}
                {data.action === "group.update" && (
                  <>
                    <div>
                      <dt>Previous group revision</dt>
                      <dd>
                        {data.details.previous_group_revision ?? "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt>Group revision</dt>
                      <dd>{data.details.group_revision ?? "Not recorded"}</dd>
                    </div>
                  </>
                )}
              </dl>
              {changes.length > 0 && (
                <section
                  className="audit-changes"
                  aria-labelledby="audit-changes-title"
                >
                  <h3 id="audit-changes-title">What changed</h3>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Before</th>
                        <th scope="col">
                          <span className="sr-only">Changed to</span>
                        </th>
                        <th scope="col">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((change) => (
                        <tr key={change.label}>
                          <th scope="row">{change.label}</th>
                          <td
                            className={
                              change.before === undefined
                                ? "audit-muted"
                                : undefined
                            }
                          >
                            {change.before ?? "Not recorded"}
                          </td>
                          <td aria-hidden="true" className="audit-change-arrow">
                            <ArrowRight size={13} />
                          </td>
                          <td>{change.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              <details className="audit-technical">
                <summary>Technical details</summary>
                <dl className="audit-detail-list">
                  <div>
                    <dt>Event ID</dt>
                    <dd>{data.id}</dd>
                  </div>
                  <div>
                    <dt>Action</dt>
                    <dd>{data.action}</dd>
                  </div>
                  {data.created_at && (
                    <div>
                      <dt>Recorded at</dt>
                      <dd>{data.created_at}</dd>
                    </div>
                  )}
                  {data.actor_id && (
                    <div>
                      <dt>Actor ID</dt>
                      <dd>{data.actor_id}</dd>
                    </div>
                  )}
                  {data.target && (
                    <div>
                      <dt>Recorded target</dt>
                      <dd>{data.target}</dd>
                    </div>
                  )}
                  {data.request_id && (
                    <div>
                      <dt>Request ID</dt>
                      <dd>{data.request_id}</dd>
                    </div>
                  )}
                  {Object.entries(data.details || {})
                    .filter(
                      ([key, value]) =>
                        key !== "reason" &&
                        !!detailLabels[key] &&
                        ["string", "number", "boolean"].includes(typeof value),
                    )
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>{detailLabels[key]}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            </>
          )
        )}
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          Return to audit log
        </Button>
      </div>
    </Modal>
  );
}

function bytes(value: number) {
  return value < 1024
    ? `${value} bytes`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function exportDownloadPath(file: AuditExport) {
  return isAuditId(file.id) &&
    file.download_path === `/api/v1/audit/exports/${file.id}/download`
    ? file.download_path
    : null;
}

function ExportScope({ filters }: { filters: AuditExport["filters"] }) {
  // Export metadata already contains normalized UTC timestamps. It is display-only:
  // never pass it through the day-input-to-timestamp request converter.
  const scope = [
    auditScopeSummary(filters.scope),
    ...auditFilterSummary({ ...defaultAuditQuery, ...filters, scope: "all" }),
  ].filter(Boolean);
  return scope.length ? (
    <ul className="audit-export-scope">
      {scope.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  ) : (
    <p className="audit-muted">All recorded workspace events.</p>
  );
}

function ExportAudit({
  query,
  approximateCount,
  onClose,
}: {
  query: AuditQuery;
  approximateCount: number;
  onClose(): void;
}) {
  const [file, setFile] = useState<AuditExport | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [requested, setRequested] = useState(false);
  const [now, setNow] = useState(performance.now());
  const receivedAt = useRef(performance.now());
  const active = useRef(true),
    busyRef = useRef(false);
  const {
    data: retained,
    loading: retainedLoading,
    error: retainedError,
    reload: reloadRetained,
  } = useResource<AuditExport[]>("/audit/exports", []);
  // Exports record the scope they apply; event filters include every kind.
  const summary = [
    auditScopeSummary(effectiveAuditScope(query)),
    ...auditFilterSummary(query),
  ].filter(Boolean);
  useEffect(() => {
    active.current = true;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, []);
  const lifetime = file
    ? Date.parse(file.expires_at) - Date.parse(file.created_at)
    : 0;
  const expired =
    !!file &&
    (!Number.isFinite(lifetime) ||
      lifetime <= 0 ||
      now - receivedAt.current >= lifetime);
  // Accept only the backend's exact same-origin download resource, never an arbitrary URL.
  const downloadPath = file ? exportDownloadPath(file) : null;
  async function prepare() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setRequested(false);
    try {
      const result = await post<AuditExport>(
        "/audit/exports",
        Object.fromEntries(auditFilterParams(query)),
      );
      if (active.current) {
        setFile(result);
        receivedAt.current = performance.now();
        setNow(receivedAt.current);
        void reloadRetained();
      } else if (isAuditId(result.id)) {
        void api(`/audit/exports/${result.id}`, { method: "DELETE" }).catch(
          () => {},
        );
      }
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function discard(id: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/audit/exports/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (active.current) {
        if (file?.id === id) setFile(null);
        setRequested(false);
        await reloadRetained();
      }
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Export audit events"
      description="Prepare a complete JSONL file for the reviewed filter scope."
    >
      <div className="modal-body audit-export">
        <p>
          <DocLink topic="administer" section="review-and-export-audit-events">
            Export guide
          </DocLink>{" "}
          ·{" "}
          <DocLink topic="glossary" section="export-formats">
            About JSONL
          </DocLink>
        </p>
        {error && (
          <>
            <ErrorBox message={error} />
            <p className="audit-muted">
              If a size or capacity limit was reached, narrow the date range or
              discard an earlier prepared file before trying again.
            </p>
          </>
        )}
        <h3>Included events</h3>
        {summary.length ? (
          <ul className="audit-export-scope">
            {summary.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        ) : (
          <p>All recorded events in this workspace.</p>
        )}
        <p className="audit-muted">
          All matching pages are included. The current view contains
          approximately {approximateCount.toLocaleString()} matching events; the
          exact count is determined when the file is prepared.
        </p>
        {!file && (
          <p>
            The server creates a consistent snapshot. New events recorded
            afterward are not included.
          </p>
        )}
        {!file && (
          <p className="audit-muted">
            Each export is limited to 100,000 events, 128 MiB and two minutes of
            preparation. You can retain two prepared files per account for ten
            minutes; the instance allows four in total. Exceeding a limit
            returns an error, never a truncated export.
          </p>
        )}
        {busy && (
          <Loading>
            {file ? "Updating prepared file…" : "Preparing export…"} If you
            close now, an unfinished preparation will be discarded when it
            completes.
          </Loading>
        )}
        {file && (
          <section className="audit-export-ready" aria-label="Prepared export">
            <h3>{expired ? "Export expired" : "File ready"}</h3>
            <ExportScope filters={file.filters} />
            <dl className="audit-detail-list">
              <div>
                <dt>Events</dt>
                <dd>{file.row_count.toLocaleString()}</dd>
              </div>
              <div>
                <dt>File size</dt>
                <dd>{bytes(file.byte_count)}</dd>
              </div>
              <div>
                <dt>File prepared</dt>
                <dd>
                  <DateCell value={file.created_at} />
                </dd>
              </div>
              <div>
                <dt>Available until</dt>
                <dd>{new Date(file.expires_at).toLocaleString()}</dd>
              </div>
            </dl>
            <p className="audit-muted">
              The download requires this signed-in session. Check your browser’s
              downloads for completion.
            </p>
            <details className="audit-technical">
              <summary>File verification</summary>
              <p>SHA-256 of the prepared file:</p>
              <code>{file.sha256}</code>
              <p>
                The JSONL file contains snapshot metadata, event records and a
                final completion record. Keep the complete file for
                verification.
              </p>
            </details>
            {!downloadPath && (
              <p role="alert">
                The server returned an invalid download address. Prepare the
                export again.
              </p>
            )}
          </section>
        )}
        {requested && (
          <p role="status">
            Download requested. Check your browser’s downloads; this page cannot
            confirm that the file was saved.
          </p>
        )}
        {(retainedLoading ||
          retainedError ||
          retained.some((item) => item.id !== file?.id)) && (
          <section
            className="audit-export-ready"
            aria-label="Earlier prepared files"
          >
            <h3>Earlier prepared files</h3>
            <p className="audit-muted">
              Each file keeps the original scope shown below. It is available
              only in the session that prepared it, until expiry or discard.
            </p>
            {retainedLoading && <Loading>Loading prepared files…</Loading>}
            {retainedError && (
              <ErrorBox message={retainedError} retry={reloadRetained} />
            )}
            <ul className="audit-retained-files">
              {retained
                .filter((item) => item.id !== file?.id)
                .map((item) => (
                  <li key={item.id} className="audit-retained-file">
                    <strong>
                      {item.row_count.toLocaleString()} events ·{" "}
                      {bytes(item.byte_count)}
                    </strong>
                    <ExportScope filters={item.filters} />
                    <span className="audit-muted">
                      Prepared {new Date(item.created_at).toLocaleString()} ·
                      Available until{" "}
                      {new Date(item.expires_at).toLocaleString()}
                    </span>
                    <div className="audit-actions">
                      {exportDownloadPath(item) ? (
                        <a
                          className="button secondary compact"
                          href={exportDownloadPath(item)!}
                          download
                          onClick={() => setRequested(true)}
                          aria-label={`Download file prepared ${item.created_at}`}
                        >
                          Download JSONL
                        </a>
                      ) : (
                        <span role="alert">Download address unavailable</span>
                      )}
                      <Button
                        variant="secondary compact"
                        disabled={busy}
                        onClick={() => void discard(item.id)}
                        aria-label={`Discard file prepared ${item.created_at}`}
                      >
                        Discard
                      </Button>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {file && (
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => void discard(file.id)}
          >
            Discard file
          </Button>
        )}
        {!file || expired || !downloadPath ? (
          <Button busy={busy} onClick={prepare}>
            {file ? "Prepare again" : "Prepare export"}
          </Button>
        ) : (
          !busy && (
            <a
              className="button"
              href={downloadPath}
              download
              onClick={() => {
                setRequested(true);
              }}
            >
              <Download size={16} />
              Download JSONL
            </a>
          )
        )}
      </div>
    </Modal>
  );
}

export default AuditLog;
