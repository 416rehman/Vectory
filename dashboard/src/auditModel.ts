import { deviceLabel } from "./deviceName";
import { statusLabel } from "./status";
/** Changes hide sign-ins; security shows only sign-in, account and key events. */
export type AuditScope = "changes" | "security" | "all";
export const auditScopes: { value: AuditScope; label: string }[] = [
  { value: "changes", label: "Changes" },
  { value: "security", label: "Security" },
  { value: "all", label: "All events" },
];
export type AuditQuery = {
  scope: AuditScope;
  search: string;
  action: string;
  family: string;
  outcome: string;
  from: string;
  to: string;
  device_id: string;
  actor_id: string;
  target_id: string;
  page: number;
  sort: "action" | "actor" | "outcome" | "created_at";
  direction: "asc" | "desc";
};

export const defaultAuditQuery: AuditQuery = {
  scope: "changes",
  search: "",
  action: "",
  family: "",
  outcome: "",
  from: "",
  to: "",
  device_id: "",
  actor_id: "",
  target_id: "",
  page: 1,
  sort: "created_at",
  direction: "desc",
};

export const auditActions: Record<string, string> = {
  bootstrap: "Workspace created",
  login: "Signed in",
  "login.mfa": "Sign-in verification",
  logout: "Signed out",
  "account.password": "Password changed",
  "account.revoke_sessions": "Other sessions ended",
  "user.create": "Person added",
  "user.update": "Workspace access changed",
  "user.password_reset.issue": "Password reset authorized",
  "user.password_reset.redeem": "Password reset completed",
  // The stored code says mfa; the product says two-factor.
  "user.mfa_reset": "Two-factor reset",
  "mfa.setup": "Authenticator setup started",
  "mfa.confirm": "Authenticator enabled",
  "mfa.disable": "Authenticator disabled",
  "mfa.recovery_code": "Recovery code used",
  "configuration.create": "Pipeline created",
  "configuration.save": "Pipeline saved",
  "configuration.publish": "Pipeline published",
  "configuration.duplicate": "Pipeline duplicated",
  "configuration.archive": "Pipeline archived",
  "configuration.unarchive": "Pipeline unarchived",
  "configuration.restore": "Pipeline draft restored",
  "configuration.tests": "Pipeline tests run",
  "vrl.synthetic_test": "VRL tested",
  "device.enroll": "Device enrolled",
  "device.enroll_refusals_summarized": "Enrollment refusals summarized",
  "device.renew": "Device credentials renewed",
  "device.revoke": "Device access revoked",
  "device.retry": "Device retry requested",
  "device.recovery_authorize": "Device recovery authorized",
  "device.recovery_complete": "Device recovery completed",
  "device.configuration_mode_reported": "Configuration capabilities reported",
  "device.apply_state": "Device apply state changed",
  "group.create": "Group created",
  "group.update": "Group updated",
  "policy.create": "Agent settings created",
  "token.create": "Enrollment token created",
  "token.revoke": "Enrollment token revoked",
  "deployment.create": "Deployment created",
  "deployment.schedule": "Deployment scheduled",
  "deployment.pause": "Deployment paused",
  "deployment.resume": "Deployment resumed",
  "deployment.cancel": "Deployment cancelled",
  "deployment.unassign": "Assignment removed",
  "deployment.rollback": "Rollback deployed",
  "deployment.release": "Deployment released to device",
  "deployment.stage_released_early": "Next stage released early",
  "deployment.gate": "Rollout gate checked",
  "deployment.activate": "Scheduled deployment activated",
  "deployment.missed": "Deployment schedule missed",
  "deployment.refresh_targets": "Scheduled targets refreshed",
  "issue.acknowledge": "Issue acknowledged",
  "issue.reopen": "Issue reopened",
  "notification.channel.create": "Notification channel added",
  "notification.channel.update": "Notification channel changed",
  "notification.channel.delete": "Notification channel removed",
  "notification.channel.test": "Test notification sent",
  "detection.update": "Detection thresholds changed",
  "signing.rotate.prepare": "Signing key rotation prepared",
  "signing.rotate": "Signing key rotated",
  "signing.prune": "Retired signing key removed",
  "signing.device_ca.rotate.prepare": "Device CA rotation prepared",
  "signing.device_ca.rotate": "Device CA rotated",
  "signing.device_ca.retire": "Previous device CA retired",
};

export const auditFamilies: Record<string, string> = {
  configuration: "Pipelines",
  deployment: "Deployments",
  device: "Devices",
  issue: "Issues",
  group: "Groups",
  user: "People",
  account: "Accounts",
  mfa: "Authenticators",
  token: "Enrollment tokens",
  policy: "Agent settings",
  signing: "Signing keys",
  vrl: "VRL tests",
  notification: "Notifications",
  detection: "Detection thresholds",
};

export function auditActionLabel(action: string) {
  return (
    auditActions[action] ||
    action
      .replaceAll("_", " ")
      .replaceAll(".", " ")
      .replace(/^./, (c) => c.toUpperCase())
  );
}
/** The event's name as the list shows it: a refused enrollment says so. */
export function auditEventLabel(item: { action: string; outcome: string }) {
  if (item.action === "device.enroll" && item.outcome !== "success")
    return "Enrollment refused";
  return auditActionLabel(item.action);
}
/** Audit results read from status.ts, the one status vocabulary. */
export function auditOutcomeLabel(outcome: string) {
  return statusLabel("audit", outcome);
}

export function normalizeAuditQuery(
  value: Partial<AuditQuery> = {},
): AuditQuery {
  const next = { ...defaultAuditQuery, ...value };
  if (!auditScopes.some((scope) => scope.value === next.scope))
    next.scope = "changes";
  next.search = Array.from(next.search.trim()).slice(0, 200).join("");
  if (next.action) next.family = "";
  if (!Number.isSafeInteger(next.page) || next.page < 1) next.page = 1;
  if (!["action", "actor", "outcome", "created_at"].includes(next.sort))
    next.sort = "created_at";
  if (next.direction !== "asc" && next.direction !== "desc")
    next.direction = "desc";
  return next;
}

/** An explicit event filter shows matching events of any kind. */
export function effectiveAuditScope(query: AuditQuery): AuditScope {
  return query.action || query.family ? "all" : query.scope;
}

export function auditFilterParams(
  query: AuditQuery,
  dates: "timestamp" | "day" = "timestamp",
) {
  const value = normalizeAuditQuery(query);
  const params = new URLSearchParams();
  if (dates === "day") {
    // Page URLs keep the viewer's choice; the default stays implicit.
    if (value.scope !== "changes") params.set("scope", value.scope);
  } else {
    const scope = effectiveAuditScope(value);
    if (scope !== "all") params.set("scope", scope);
  }
  for (const key of [
    "search",
    "action",
    "family",
    "outcome",
    "device_id",
    "actor_id",
    "target_id",
    "from",
    "to",
  ] as const) {
    if (value[key])
      params.set(
        key,
        dates === "timestamp" && (key === "from" || key === "to")
          ? `${value[key]}T${key === "from" ? "00:00:00.000" : "23:59:59.999"}Z`
          : value[key],
      );
  }
  return params;
}

export function auditHistoryPath(query: AuditQuery) {
  const params = auditFilterParams(query);
  const value = normalizeAuditQuery(query);
  if (value.sort !== "created_at" || value.direction !== "desc") {
    params.set("sort", value.sort);
    params.set("direction", value.direction);
  }
  params.set("page", String(query.page));
  params.set("page_size", "12");
  return `/audit/history?${params}`;
}

export const isAuditId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export function readAuditQuery(search: string): AuditQuery | undefined {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const keys = [
    "search",
    "action",
    "family",
    "outcome",
    "from",
    "to",
    "device_id",
    "actor_id",
    "target_id",
  ] as const;
  if (
    ![...keys, "page", "device", "sort", "direction", "scope"].some((key) =>
      params.has(key),
    )
  )
    return undefined;
  const value: Partial<AuditQuery> = {};
  value.scope = (params.get("scope") as AuditScope) || "changes";
  for (const key of keys)
    value[key] = Array.from(params.get(key) || "")
      .slice(0, key === "search" ? 200 : key === "target_id" ? 256 : 128)
      .join("");
  value.device_id = params.get("device") || value.device_id || "";
  for (const key of ["device_id", "actor_id", "target_id"] as const) {
    // Non-UUID actor identities (scheduler/local-admin) are valid exact filters.
    if (isAuditId(value[key] || "")) value[key] = value[key]!.toLowerCase();
  }
  value.device_id = Array.from(value.device_id).slice(0, 100).join("");
  const page = params.get("page") || "1";
  value.page = /^\d+$/.test(page) ? Number(page) : 1;
  value.sort = (params.get("sort") as AuditQuery["sort"]) || "created_at";
  value.direction =
    (params.get("direction") as AuditQuery["direction"]) || "desc";
  return normalizeAuditQuery(value);
}

export function auditRoute(id: string | null, query: AuditQuery) {
  const params = auditFilterParams(query, "day");
  const value = normalizeAuditQuery(query);
  if (params.has("device_id")) {
    params.set("device", params.get("device_id")!);
    params.delete("device_id");
  }
  params.set("page", String(normalizeAuditQuery(query).page));
  if (value.sort !== "created_at" || value.direction !== "desc") {
    params.set("sort", value.sort);
    params.set("direction", value.direction);
  }
  const normalizedId = id && isAuditId(id) ? id.toLowerCase() : id;
  return `audit${normalizedId ? `/${encodeURIComponent(normalizedId)}` : ""}?${params}`;
}

/** Scope wording for prepared exports, which record it with the filters. */
export function auditScopeSummary(scope?: string | null) {
  return scope === "changes"
    ? "Sign-in events excluded"
    : scope === "security"
      ? "Security events only"
      : "";
}

export function auditFilterSummary(query: AuditQuery) {
  const q = normalizeAuditQuery(query);
  return [
    q.search && `Search: ${q.search}`,
    q.action && auditActionLabel(q.action),
    q.family && `${auditFamilies[q.family] || q.family} events`,
    q.outcome && `Result: ${auditOutcomeLabel(q.outcome)}`,
    q.from && `From: ${q.from}`,
    q.to && `Through: ${q.to}`,
    q.device_id && `Device: ${q.device_id}`,
    q.actor_id && `Actor: ${q.actor_id}`,
    q.target_id && `Target: ${q.target_id}`,
  ].filter(Boolean) as string[];
}

// Only complete identifiers and server-typed identities become resource links.
// Names, raw audit targets and action prefixes never determine a destination.
export function auditResourceRoute(
  kind: string | null | undefined,
  id: string | null | undefined,
) {
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return null;
  const prefix: Record<string, string> = {
    device: "devices",
    configuration: "configurations",
    deployment: "deployments",
    issue: "issues",
  };
  return prefix[kind || ""]
    ? `${prefix[kind || ""]}/${id.toLowerCase()}`
    : null;
}

export function auditDateError(from: string, to: string) {
  const valid = (day: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  if (from && !valid(from)) return "Choose a valid start date.";
  if (to && !valid(to)) return "Choose a valid end date.";
  if (from && to && from > to)
    return "The end date must be on or after the start date.";
  return "";
}

export type AuditChange = { label: string; before?: string; after: string };
const changePairs: [before: string, after: string, label: string][] = [
  ["previous_state", "state", "State"],
  ["previous_generation", "generation", "Configuration generation"],
  [
    "previous_policy_generation",
    "policy_generation",
    "Agent settings generation",
  ],
  ["previous_secret_revision", "secret_revision", "Local secret revision"],
  ["previous_device_id", "replacement_device_id", "Device identity"],
  ["old_device_id", "new_device_id", "Device identity"],
  ["previous_signing_key_id", "signing_key_id", "Signing key"],
];
const changeValues: [key: string, label: string][] = [
  ["version_number", "Version"],
  ["configuration_revision", "Pipeline revision"],
  ["source_revision", "Source revision"],
  ["issue_revision", "Issue revision"],
  ["retry_generation", "Retry generation"],
  ["browser_sessions", "Browser sessions ended"],
  ["password_reset_codes", "Password reset codes revoked"],
  ["enrollment_tokens_to_revoke", "Enrollment tokens revoked"],
  ["mfa_recovery_codes", "Recovery codes"],
];
const scalar = (value: unknown) =>
  ["string", "number", "boolean"].includes(typeof value)
    ? String(value)
    : undefined;
/**
 * Before/after pairs and recorded values an audit event carries, if any.
 * Group revisions are listed with the event's identities instead.
 */
export function auditChanges(
  details: Record<string, unknown> | null | undefined,
) {
  const changes: AuditChange[] = [];
  if (!details) return changes;
  const state = (value: string, key: string) =>
    key.endsWith("state") ? auditOutcomeLabel(value) : value;
  for (const [beforeKey, afterKey, label] of changePairs) {
    const after = scalar(details[afterKey]);
    if (after === undefined) continue;
    const before = scalar(details[beforeKey]);
    changes.push({
      label,
      before: before === undefined ? undefined : state(before, beforeKey),
      after: state(after, afterKey),
    });
  }
  for (const [key, label] of changeValues) {
    const value = scalar(details[key]);
    if (value !== undefined)
      changes.push({
        label,
        after: key === "version_number" ? `v${value}` : value,
      });
  }
  return changes;
}

type GroupableEvent = {
  id: string;
  action: string;
  outcome: string;
  target_name: string | null;
  created_at: string | null;
};
export type AuditRow<T extends GroupableEvent> =
  { kind: "event"; item: T } | { kind: "results"; key: string; items: T[] };
/**
 * Consecutive per-device apply results ("edge-nyc-01 applied and verified")
 * collapse into one row, so deployments and edits stay readable in the
 * default view. A lone result stays a plain row.
 */
export function groupDeviceResults<T extends GroupableEvent>(
  items: T[],
): AuditRow<T>[] {
  const rows: AuditRow<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length > 1)
      rows.push({ kind: "results", key: `results:${run[0].id}`, items: run });
    else if (run.length) rows.push({ kind: "event", item: run[0] });
    run = [];
  };
  for (const item of items) {
    if (item.action === "device.apply_state") run.push(item);
    else {
      flush();
      rows.push({ kind: "event", item });
    }
  }
  flush();
  return rows;
}
/**
 * What a run of device results says: its last word, with the steps behind a
 * disclosure. Outcomes count each device once, by its latest result, so one
 * device that waited and then applied is "applied", not two results.
 *
 * - One device: `title` is "edge-nyc-02 · rolled back" and `last` is that
 *   outcome, for a badge in the Result column; `devices` counts the steps.
 * - Several: "3 device results" with their names, and `outcomes` the count of
 *   each device's last outcome, most common first ("2 applied, 1 rolled back").
 */
export function deviceResultsSummary(items: GroupableEvent[]) {
  const time = (item: GroupableEvent) => Date.parse(item.created_at || "");
  const latest = new Map<string, GroupableEvent>();
  items.forEach((item, index) => {
    // A result without a device name can't be matched with another.
    const key = item.target_name ?? `#${index}`;
    const seen = latest.get(key);
    if (!seen || time(item) > time(seen)) latest.set(key, item);
  });
  const names = [
    ...new Set(
      [...latest.values()].map((item) =>
        item.target_name ? deviceLabel(item.target_name) : "a device",
      ),
    ),
  ];
  const shown = names.slice(0, 2);
  const devices =
    names.length > 2
      ? `${shown.join(", ")} and ${names.length - 2} more`
      : shown.join(" and ");
  const counts = new Map<string, number>();
  for (const item of latest.values())
    counts.set(item.outcome, (counts.get(item.outcome) || 0) + 1);
  const outcomes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([outcome, count]) =>
        `${count} ${auditOutcomeLabel(outcome).toLowerCase()}`,
    )
    .join(", ");
  const only = latest.size === 1 ? [...latest.values()][0] : null;
  return {
    title: only
      ? `${only.target_name ? deviceLabel(only.target_name) : "A device"} · ${auditOutcomeLabel(only.outcome).toLowerCase()}`
      : latest.size === items.length
        ? `${items.length} device results`
        : `${items.length} results for ${latest.size} devices`,
    devices: only ? `${items.length} results` : devices,
    outcomes,
    /** The one device's last outcome; null when the run covers several. */
    last: only ? only.outcome : null,
  };
}
