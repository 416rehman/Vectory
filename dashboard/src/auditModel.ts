export type AuditQuery = {
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
  "deployment.gate": "Rollout gate checked",
  "deployment.activate": "Scheduled deployment activated",
  "deployment.missed": "Deployment schedule missed",
  "deployment.refresh_targets": "Scheduled targets refreshed",
  "issue.acknowledge": "Issue acknowledged",
  "issue.reopen": "Issue reopened",
  "signing.rotate.prepare": "Signing key rotation prepared",
  "signing.rotate": "Signing key rotated",
  "signing.prune": "Retired signing key removed",
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
};

export const auditOutcomes: Record<string, string> = {
  success: "Succeeded",
  failure: "Failed",
  failed: "Failed",
  denied: "Denied",
  conflict: "Conflict",
  missed: "Missed",
  prepared: "Prepared",
  full: "Full capabilities",
  restricted: "Restricted capabilities",
  unmanaged: "No pipeline",
  desired: "Update pending",
  downloaded: "Downloaded",
  validated: "Validated",
  written: "Written",
  reload_requested: "Restart requested",
  verified_applied: "Applied and verified",
  verification_unknown: "Verification needed",
  rolled_back: "Rolled back",
  incompatible: "Incompatible",
  paused: "Paused",
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
export function auditOutcomeLabel(outcome: string) {
  return (
    auditOutcomes[outcome] ||
    outcome.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
  );
}

export function normalizeAuditQuery(
  value: Partial<AuditQuery> = {},
): AuditQuery {
  const next = { ...defaultAuditQuery, ...value };
  next.search = Array.from(next.search.trim()).slice(0, 200).join("");
  if (next.action) next.family = "";
  if (!Number.isSafeInteger(next.page) || next.page < 1) next.page = 1;
  if (!["action", "actor", "outcome", "created_at"].includes(next.sort))
    next.sort = "created_at";
  if (next.direction !== "asc" && next.direction !== "desc")
    next.direction = "desc";
  return next;
}

export function auditFilterParams(
  query: AuditQuery,
  dates: "timestamp" | "day" = "timestamp",
) {
  const value = normalizeAuditQuery(query);
  const params = new URLSearchParams();
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
    ![...keys, "page", "device", "sort", "direction"].some((key) =>
      params.has(key),
    )
  )
    return undefined;
  const value: Partial<AuditQuery> = {};
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
