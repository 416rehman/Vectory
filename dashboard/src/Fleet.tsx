import { useEffect, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ChartNoAxesCombined,
  Plus,
  Workflow,
} from "lucide-react";
import DocLink from "./DocLink";
import AgentUpgrade from "./AgentUpgrade";
import GroupEditor from "./GroupEditor";
import { GroupRecovery } from "./GroupRecovery";
import { useGroupOperations } from "./groupRequests";
import TabLabel from "./TabLabel";
import { DataTable, type TableColumn, type TableSort } from "./DataTable";
import { matchesTableFilter, sortTableRows } from "./dataTableModel";
import {
  currentConfigurationAttempt,
  deviceApplicationExplanation,
} from "./deviceApplication";
import {
  ago,
  can,
  post,
  put,
  when,
  type Audit,
  type AuditHistoryPage,
  type Configuration,
  type Device,
  type Group,
  type IssueHistoryPage,
  type Policy,
  type User,
  type Version,
} from "./api";
import {
  Button,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  RefreshButton,
  SearchBox,
  Spinner,
  useResource,
} from "./ui";
import TargetDialog from "./TargetDialog";
import { DeviceRecoveryActions } from "./RecoveryActions";
import DeviceRevocation from "./DeviceAccessRevocation";
import TelemetryPanel from "./TelemetryPanel";
import { deploymentRoute, isDeploymentId } from "./deploymentRouting";
import {
  auditResourceRoute,
  auditRoute,
  defaultAuditQuery,
  isAuditId,
} from "./auditModel";
import "./fleet.css";

type Navigate = (path: string) => void;
const attentionStates = [
  "failed",
  "rolled_back",
  "verification_unknown",
  "offline",
  "conflict",
];
const needsAttention = (device: Device) =>
  device.status !== "revoked" &&
  (attentionStates.includes(device.status) ||
    attentionStates.includes(device.apply_state));
const online = (device: Device) =>
  !!device.last_seen && !["offline", "revoked"].includes(device.status);
const connectionState = (device: Device) =>
  device.status === "revoked"
    ? "revoked"
    : online(device)
      ? "online"
      : "offline";
const platform = (device: Device) =>
  [device.os, device.arch].filter(Boolean).join(" / ") ||
  "Platform not reported";
const stateLabels: Record<string, string> = {
  verified: "Applied",
  verified_applied: "Applied",
  offline: "Offline",
  revoked: "Revoked",
  paused: "Sync paused",
  unmanaged: "No assignment",
  failed: "Apply failed",
  rolled_back: "Rolled back",
  verification_unknown: "Check required",
  conflict: "Assignment conflict",
  applying: "Applying",
  desired: "Pending",
  downloaded: "Downloaded",
  validated: "Validated",
  written: "Applying",
  reload_requested: "Starting Vector",
};
function Status({ value, label }: { value: string; label?: string }) {
  const kind = ["verified", "verified_applied", "online"].includes(value)
    ? "ok"
    : ["failed", "rolled_back", "conflict", "revoked"].includes(value)
      ? "error"
      : ["paused", "verification_unknown", "offline"].includes(value)
        ? "warning"
        : "neutral";
  return (
    <span className={`fleet-status fleet-status-${kind}`}>
      {label || stateLabels[value] || value.replaceAll("_", " ")}
    </span>
  );
}
function pipelineState(device: Device) {
  if (device.status === "revoked") return "revoked";
  if (device.local_paused || device.sync_paused) return "paused";
  if (!device.desired_version_id) return "unmanaged";
  if (device.status === "verified") return "verified";
  if (device.apply_state === "verified_applied")
    return device.status === "offline" &&
      device.reported_generation === device.desired_generation
      ? "verified_applied"
      : "applying";
  return device.apply_state || "desired";
}
function attentionReason(device: Device) {
  if (device.status === "offline")
    return "Check the agent connection on this host.";
  if (device.apply_state === "rolled_back")
    return "The latest apply failed. The last working pipeline was restored.";
  if (device.apply_state === "verification_unknown")
    return "The agent could not confirm that Vector is running.";
  if (device.status === "conflict")
    return "Review conflicting pipeline assignments.";
  return "Review the reported issue before retrying the pipeline.";
}
function Loading({ children }: { children: string }) {
  return (
    <div className="fleet-loading">
      <Spinner />
      {children}
    </div>
  );
}
function Blank({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="fleet-empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
const activityLabels: Record<string, string> = {
  "configuration.create": "Pipeline created",
  "configuration.save": "Pipeline saved",
  "configuration.publish": "Pipeline published",
  "configuration.duplicate": "Pipeline duplicated",
  "configuration.archive": "Pipeline archived",
  "configuration.unarchive": "Pipeline unarchived",
  "configuration.restore": "Pipeline draft restored",
  "group.create": "Device group created",
  "group.update": "Device group updated",
  "policy.create": "Agent settings saved",
  "token.create": "Enrollment token created",
  "token.revoke": "Enrollment token revoked",
  "device.enroll": "Device enrollment",
  "device.revoke": "Device access revoked",
  "device.renew": "Device credentials renewed",
  "device.retry": "Pipeline retry requested",
  "device.recovery_authorize": "Device recovery authorized",
  "device.recovery_complete": "Device recovery completed",
  "device.apply_state": "Pipeline status updated",
  "deployment.create": "Deployment created",
  "deployment.schedule": "Deployment scheduled",
  "deployment.release": "Deployment released to device",
  "deployment.gate": "Deployment health check",
  "deployment.missed": "Scheduled deployment missed",
  "deployment.activate": "Deployment activation",
  "deployment.pause": "Deployment paused",
  "deployment.resume": "Deployment resumed",
  "deployment.cancel": "Deployment canceled",
  "deployment.rollback": "Deployment rollback requested",
  "deployment.unassign": "Assignment removed",
  "deployment.refresh_targets": "Deployment targets refreshed",
  "issue.acknowledge": "Issue acknowledged",
  "issue.reopen": "Issue reopened",
  "vrl.synthetic_test": "Transform tested",
  "user.create": "User added",
  "user.update": "Account access updated",
  "account.password": "Password changed",
  "account.revoke_sessions": "Other sessions signed out",
  "user.password_reset.issue": "Password reset issued",
  "user.password_reset.redeem": "Password reset completed",
  "mfa.enable": "Two-factor authentication enabled",
  "mfa.disable": "Two-factor authentication disabled",
  "mfa.recovery_code": "Recovery code used",
  "login.mfa": "Two-factor sign-in",
  "signing.rotate.prepare": "Signing key rotation prepared",
  "signing.rotate": "Signing key rotated",
  "signing.prune": "Previous signing key removed",
  bootstrap: "Workspace created",
  login: "Sign-in",
  logout: "Sign-out",
};
function ActivityRows({
  entries,
  names = {},
  deviceId,
}: {
  entries: Audit[];
  names?: Record<string, string>;
  deviceId?: string;
}) {
  const actorName = (entry: Audit) =>
    names[entry.actor_id || entry.actor] ||
    (
      {
        scheduler: "Automatic",
        "local-admin": "Local administrator",
        anonymous: "Unauthenticated request",
      } as Record<string, string>
    )[entry.actor] ||
    (entry.actor_id && entry.actor_id !== entry.actor
      ? entry.actor
      : undefined);
  return (
    <ol className="fleet-activity-list">
      {entries.map((entry) => {
        const actor = actorName(entry);
        const sameIdentity =
          (entry.actor_kind === "user" || entry.actor_kind === "device") &&
          entry.target_kind === entry.actor_kind &&
          !!entry.actor_id &&
          !!entry.target_id &&
          isAuditId(entry.actor_id) &&
          isAuditId(entry.target_id) &&
          entry.actor_id.toLowerCase() === entry.target_id.toLowerCase();
        const target =
          actor && sameIdentity
            ? undefined
            : entry.target_name || names[entry.target_id || entry.target];
        const targetRoute =
          entry.target_exists === true
            ? auditResourceRoute(entry.target_kind, entry.target_id)
            : null;
        const actorRoute =
          entry.actor_kind === "device"
            ? auditResourceRoute("device", entry.actor_id)
            : entry.actor_kind === "user" &&
                entry.actor_id &&
                isAuditId(entry.actor_id)
              ? auditRoute(null, {
                  ...defaultAuditQuery,
                  actor_id: entry.actor_id.toLowerCase(),
                  device_id: deviceId || "",
                })
              : null;
        const outcome =
          entry.outcome !== "success" && entry.outcome
            ? stateLabels[entry.outcome] || entry.outcome.replaceAll("_", " ")
            : undefined;
        return (
          <li key={entry.id}>
            <div>
              <a
                className="fleet-activity-link"
                href={`#/${auditRoute(entry.id, { ...defaultAuditQuery, device_id: deviceId || "" })}`}
              >
                {activityLabels[entry.action] || "Activity recorded"}
              </a>
              <span className="fleet-activity-meta">
                {target &&
                  (targetRoute ? (
                    <a href={`#/${targetRoute}`}>{target}</a>
                  ) : (
                    target
                  ))}
                {target && actor && " · "}
                {actor && (
                  <>
                    by{" "}
                    {actorRoute ? (
                      <a
                        href={`#/${actorRoute}`}
                        title={
                          entry.actor_kind === "user"
                            ? `View activity by ${actor}`
                            : undefined
                        }
                      >
                        {actor}
                      </a>
                    ) : (
                      actor
                    )}
                  </>
                )}
                {(target || actor) && outcome && " · "}
                {outcome}
              </span>
            </div>
            <time
              dateTime={entry.created_at || undefined}
              title={
                entry.created_at ? when(entry.created_at) : "Time unavailable"
              }
            >
              {entry.created_at ? ago(entry.created_at) : "Time unavailable"}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

export { Overview } from "./Overview";

export function Devices({
  user,
  notify,
  navigate,
  deviceId,
}: {
  user: User;
  notify: (message: string) => void;
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
function DeviceList({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: (message: string) => void;
  navigate: Navigate;
}) {
  const { data, loading, error, reload } = useResource<Device[]>(
    "/devices",
    [],
  );
  const [search, setSearch] = useState(""),
    [nameFilter, setNameFilter] = useState(""),
    [connectionFilter, setConnectionFilter] = useState(""),
    [pipelineFilter, setPipelineFilter] = useState(""),
    [sort, setSort] = useState<TableSort | null>({
      column: "device",
      direction: "asc",
    }),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]),
    [policy, setPolicy] = useState<Policy | null>(null);
  const filtered = sortTableRows(
    data.filter(
      (device) =>
        `${device.name} ${device.os} ${device.arch} ${Object.entries(
          device.labels || {},
        )
          .flat()
          .join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        matchesTableFilter(device.name, nameFilter, false) &&
        (!connectionFilter || connectionState(device) === connectionFilter) &&
        (!pipelineFilter ||
          (pipelineFilter === "attention" && needsAttention(device)) ||
          pipelineState(device) === pipelineFilter ||
          (pipelineFilter === "verified" &&
            pipelineState(device) === "verified_applied")),
    ),
    [
      { id: "device", value: (device) => device.name },
      { id: "connection", value: connectionState },
      {
        id: "pipeline",
        value: (device) =>
          `${needsAttention(device) ? "0" : "1"} ${pipelineState(device)}`,
      },
      {
        id: "last_seen",
        value: (device) =>
          device.last_seen ? Date.parse(device.last_seen) : null,
      },
    ],
    sort,
  );
  const currentPage = Math.min(
      page,
      Math.max(1, Math.ceil(filtered.length / 12)),
    ),
    visible = filtered.slice((currentPage - 1) * 12, currentPage * 12),
    selectedIds = selected.filter((id) =>
      data.some((device) => device.id === id && device.status !== "revoked"),
    ),
    operable = visible.filter((device) => device.status !== "revoked");
  useEffect(
    () => setPage(1),
    [search, nameFilter, connectionFilter, pipelineFilter, sort],
  );
  const selectedDevices = data.filter((device) =>
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
  function toggle(id: string) {
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }
  function clearFilters() {
    setSearch("");
    setNameFilter("");
    setConnectionFilter("");
    setPipelineFilter("");
  }
  const columns: TableColumn<Device>[] = [
    ...(can(user, "operate")
      ? [
          {
            id: "select",
            label: "Select devices",
            className: "fleet-check",
            headerClassName: "fleet-check",
            header: (
              <input
                aria-label="Select visible devices"
                type="checkbox"
                checked={
                  operable.length > 0 &&
                  operable.every((device) => selectedIds.includes(device.id))
                }
                disabled={loading || !!error || !operable.length}
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
            cell: (device: Device) => (
              <input
                aria-label={`Select ${device.name}`}
                type="checkbox"
                disabled={device.status === "revoked"}
                checked={selectedIds.includes(device.id)}
                onChange={() => toggle(device.id)}
              />
            ),
          },
        ]
      : []),
    {
      id: "device",
      header: "Device",
      value: (device) => device.name,
      filter: {
        value: nameFilter,
        onChange: setNameFilter,
        manual: true,
        placeholder: "Filter device names",
      },
      cell: (device) => (
        <button
          className="fleet-device-name"
          onClick={() => navigate(`devices/${device.id}`)}
        >
          <strong>{device.name}</strong>
          <small>{platform(device)}</small>
        </button>
      ),
    },
    {
      id: "connection",
      header: "Connection",
      value: connectionState,
      filter: {
        value: connectionFilter,
        onChange: setConnectionFilter,
        manual: true,
        options: [
          { value: "online", label: "Online" },
          { value: "offline", label: "Offline" },
          { value: "revoked", label: "Revoked" },
        ],
      },
      cell: (device) => (
        <Status
          value={connectionState(device)}
          label={
            connectionState(device) === "online"
              ? "Online"
              : connectionState(device) === "revoked"
                ? "Revoked"
                : "Offline"
          }
        />
      ),
    },
    {
      id: "pipeline",
      header: "Pipeline",
      value: pipelineState,
      filter: {
        value: pipelineFilter,
        onChange: setPipelineFilter,
        manual: true,
        options: [
          { value: "attention", label: "Needs attention" },
          ...[
            "verified",
            "desired",
            "applying",
            "paused",
            "unmanaged",
            "failed",
            "rolled_back",
            "conflict",
            "verification_unknown",
          ].map((value) => ({ value, label: stateLabels[value] })),
        ],
      },
      cell: (device) => (
        <>
          <Status value={pipelineState(device)} />
          {device.status === "offline" &&
            device.apply_state === "verified_applied" && (
              <small className="fleet-cell-note">Last reported state</small>
            )}
        </>
      ),
    },
    {
      id: "last_seen",
      header: "Last seen",
      value: (device) => device.last_seen,
      cell: (device) => (
        <time dateTime={device.last_seen} title={when(device.last_seen)}>
          {ago(device.last_seen)}
        </time>
      ),
    },
    {
      id: "open",
      header: <span className="sr-only">Open device</span>,
      cell: (device) => (
        <button
          className="fleet-row-open"
          aria-label={`Open ${device.name}`}
          onClick={() => navigate(`devices/${device.id}`)}
        >
          <ArrowRight size={17} />
        </button>
      ),
    },
  ];
  return (
    <div className="fleet-workspace">
      <PageHeader
        title="Devices"
        help={{ topic: "installation", section: "verify-the-first-connection" }}
        description={
          loading || error
            ? "Manage enrolled Vector hosts."
            : `${data.length} enrolled ${data.length === 1 ? "device" : "devices"}. ${data.filter(online).length} currently online.`
        }
      >
        {can(user, "operate") && (
          <Button icon={Plus} onClick={() => navigate("enrollment")}>
            Add device
          </Button>
        )}
      </PageHeader>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="fleet-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search devices"
        />
        <div className="fleet-toolbar-controls">
          <RefreshButton
            onClick={reload}
            busy={loading}
            aria-label="Refresh devices"
            title="Refresh devices"
          />
        </div>
      </div>
      {selectedIds.length > 0 && can(user, "operate") && (
        <div className="fleet-selection-bar">
          <strong>{selectedIds.length} selected</strong>
          <div>
            <Button
              variant="secondary compact"
              disabled={!preserveSettings}
              onClick={() =>
                sharedPolicy &&
                setPolicy({
                  ...sharedPolicy,
                  sync_paused: true,
                })
              }
            >
              Pause sync…
            </Button>
            <Button
              variant="secondary compact"
              disabled={!preserveSettings}
              onClick={() =>
                sharedPolicy &&
                setPolicy({
                  ...sharedPolicy,
                  sync_paused: false,
                })
              }
            >
              Resume sync…
            </Button>
            <button className="fleet-link" onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
          {!preserveSettings && (
            <p>
              Select devices with the same check-in and telemetry settings, or
              pause them individually. Existing settings will be preserved.
            </p>
          )}
        </div>
      )}
      <div className="fleet-table-panel">
        <DataTable
          data={error ? [] : filtered}
          columns={columns}
          rowKey={(device) => device.id}
          label="Devices"
          className="fleet-table"
          loading={loading}
          sort={sort}
          onSortChange={setSort}
          manualSorting
          pagination={
            error ? undefined : { page: currentPage, size: 12, onPage: setPage }
          }
          empty={
            error ? (
              "Devices could not be loaded."
            ) : (
              <Blank
                title={data.length ? "No matching devices" : "No devices yet"}
                action={
                  data.length ? (
                    <Button variant="secondary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : can(user, "operate") ? (
                    <Button onClick={() => navigate("enrollment")}>
                      Add device
                    </Button>
                  ) : undefined
                }
              >
                {data.length
                  ? "Try another name, platform or status."
                  : "Enroll an agent to manage the Vector pipeline on that host."}
              </Blank>
            )
          }
        />
      </div>
      {policy && can(user, "operate") && (
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
            void reload();
          }}
        />
      )}
    </div>
  );
}

function DeviceDetail({
  id,
  user,
  notify,
  navigate,
}: {
  id: string;
  user: User;
  notify: (message: string) => void;
  navigate: Navigate;
}) {
  const resource = useResource<Device | null>(`/devices/${id}`, null),
    device = resource.data;
  const [tab, setTab] = useState("pipeline"),
    [policy, setPolicy] = useState<Policy | null>(null);
  const canReviewPolicy = can(user, "operate") && device?.status !== "revoked";
  useEffect(() => {
    if (!device || !canReviewPolicy) setPolicy(null);
  }, [device, canReviewPolicy]);
  const version = useResource<Version | null>(
    device?.desired_version_id
      ? `/versions/${device.desired_version_id}`
      : null,
    null,
  );
  const configuration = useResource<Configuration | null>(
    version.data?.configuration_id
      ? `/configurations/${version.data.configuration_id}`
      : null,
    null,
  );
  const afterAction = (message: string) => {
    notify(message);
    void resource.reload();
  };
  const assignmentLink = (assignmentId?: string) =>
    typeof assignmentId === "string" && isDeploymentId(assignmentId)
      ? `#/${deploymentRoute(false, assignmentId, {
          search: "",
          status: "all",
          page: 1,
        })}`
      : null;
  const pipelineAssignment = assignmentLink(device?.assignment?.id);
  const settingsAssignment = assignmentLink(device?.policy_assignment?.id);
  return (
    <div className="device-workspace">
      <button className="device-back" onClick={() => navigate("devices")}>
        <ArrowLeft size={15} />
        Back to devices
      </button>
      {!resource.loading && !device && (
        <PageHeader
          title="Device unavailable"
          description="Try again to load this device, or return to the device list."
          help={{
            topic: "troubleshooting",
            section: "a-device-page-shows-mismatched-details",
            label: "Help loading this device",
          }}
        />
      )}
      {resource.error && (
        <ErrorBox message={resource.error} retry={resource.reload} />
      )}
      {resource.loading ? (
        <Loading>Loading device</Loading>
      ) : (
        device && (
          <>
            <PageHeader
              title={device.name}
              description={platform(device)}
              help={{
                topic: "telemetry",
                section: "investigate-a-change",
                label: "Help for this device",
              }}
            >
              <RefreshButton
                onClick={resource.reload}
                busy={resource.loading}
              />
            </PageHeader>
            <div className="device-summary">
              <div>
                <span>Connection</span>
                <strong>
                  {device.status === "revoked"
                    ? "Access revoked"
                    : online(device)
                      ? "Online"
                      : "Offline"}
                </strong>
                <small title={when(device.last_seen)}>
                  {device.last_seen
                    ? `Last seen ${ago(device.last_seen).toLowerCase()}`
                    : "No heartbeat received"}
                </small>
              </div>
              <div>
                <span>Pipeline</span>
                <strong>
                  {configuration.data?.name ||
                    (device.desired_version_id
                      ? "Assigned pipeline"
                      : "No assignment")}
                </strong>
                <small>
                  {version.data ? `Version ${version.data.number} · ` : ""}
                  {stateLabels[pipelineState(device)] ||
                    device.apply_state.replaceAll("_", " ")}
                </small>
              </div>
              <div>
                <span>Vector</span>
                <strong>{device.vector_version || "Not reported"}</strong>
                <small>
                  {device.agent_version
                    ? `Agent ${device.agent_version}`
                    : "Agent version not reported"}
                </small>
                <AgentUpgrade key={device.id} device={device} />
              </div>
            </div>
            {needsAttention(device) && (
              <div className="device-notice device-notice-warning">
                <div>
                  <strong>
                    {device.status === "offline"
                      ? "This device is offline"
                      : stateLabels[device.apply_state] || "Action required"}
                  </strong>
                  <p>
                    {attentionReason(device)}{" "}
                    <DocLink
                      topic="troubleshooting"
                      section={
                        device.status === "offline"
                          ? "a-device-is-offline-or-never-connects"
                          : "a-pipeline-is-rejected-or-rolled-back"
                      }
                    >
                      Troubleshoot this device
                    </DocLink>
                  </p>
                </div>
                <Button
                  variant="secondary compact"
                  onClick={() => setTab("activity")}
                >
                  Review activity
                </Button>
              </div>
            )}
            {(device.sync_paused || device.local_paused) && (
              <div className="device-notice">
                <div>
                  <strong>
                    {device.local_paused
                      ? "Sync paused on this host"
                      : device.pause_acknowledged
                        ? "Sync paused"
                        : "Waiting for pause confirmation"}
                  </strong>
                  <p>
                    {device.local_paused
                      ? "A host operator must run vectory resume locally. Remote changes cannot remove this pause."
                      : "The current workload continues. New configuration changes wait until sync resumes."}
                  </p>
                </div>
              </div>
            )}
            <div
              className="device-tabs"
              role="tablist"
              aria-label="Device details"
            >
              {[
                { value: "pipeline", label: "Pipeline", icon: Workflow },
                {
                  value: "metrics",
                  label: "Metrics",
                  icon: ChartNoAxesCombined,
                },
                { value: "activity", label: "Activity", icon: Activity },
              ].map(({ value, label, icon }) => (
                <button
                  role="tab"
                  key={value}
                  id={`device-tab-${value}`}
                  aria-selected={tab === value}
                  aria-controls="device-detail-panel"
                  tabIndex={tab === value ? 0 : -1}
                  onKeyDown={(event) => {
                    const order = ["pipeline", "metrics", "activity"];
                    if (
                      event.key === "ArrowRight" ||
                      event.key === "ArrowLeft"
                    ) {
                      event.preventDefault();
                      const next =
                        order[
                          (order.indexOf(tab) +
                            (event.key === "ArrowRight" ? 1 : 2)) %
                            order.length
                        ];
                      setTab(next);
                      document.getElementById(`device-tab-${next}`)?.focus();
                    }
                  }}
                  onClick={() => setTab(value)}
                >
                  <TabLabel icon={icon}>{label}</TabLabel>
                </button>
              ))}
            </div>
            <div
              className="device-tab-panel"
              role="tabpanel"
              id="device-detail-panel"
              aria-labelledby={`device-tab-${tab}`}
            >
              {tab === "pipeline" && (
                <section className="fleet-section device-pipeline">
                  <div className="fleet-section-heading">
                    <h2>
                      {device.desired_version_id
                        ? "Assigned pipeline"
                        : "No pipeline assigned"}
                    </h2>
                    {device.desired_version_id && (
                      <Status value={pipelineState(device)} />
                    )}
                  </div>
                  {(version.error || configuration.error) && (
                    <ErrorBox
                      message={version.error || configuration.error}
                      retry={() => {
                        void version.reload();
                        void configuration.reload();
                      }}
                    />
                  )}
                  {device.desired_version_id ? (
                    <div className="device-pipeline-content">
                      <h3>
                        {configuration.data?.name ||
                          (version.loading || configuration.loading
                            ? "Loading pipeline…"
                            : "Pipeline details could not be loaded")}
                      </h3>
                      {version.data && (
                        <p>
                          Version {version.data.number}
                          {version.data.message
                            ? ` — ${version.data.message}`
                            : ""}
                        </p>
                      )}
                      <p className="device-explanation">
                        {deviceApplicationExplanation(device, version.data)}
                      </p>
                      {device.uses_local_secrets && (
                        <p className="device-secret-note">
                          This pipeline uses credentials stored on the device.
                          Secret values are never sent to this dashboard.
                        </p>
                      )}
                      <div className="device-action-row">
                        {configuration.data && (
                          <Button
                            variant="secondary"
                            onClick={() =>
                              navigate(
                                `configurations/${configuration.data!.id}`,
                              )
                            }
                          >
                            Open pipeline
                          </Button>
                        )}
                        {pipelineAssignment && (
                          <a
                            className="button secondary"
                            href={pipelineAssignment}
                          >
                            View pipeline assignment
                          </a>
                        )}
                      </div>
                      {device.assignment && !pipelineAssignment && (
                        <p>Pipeline assignment link unavailable.</p>
                      )}
                    </div>
                  ) : (
                    <div className="device-pipeline-content">
                      <p>
                        No published pipeline is assigned. An adopted local
                        workload may continue running; a device without a
                        managed configuration waits without starting Vector. An
                        agent check-in alone does not confirm a running
                        workload.
                      </p>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          navigate(
                            `configurations?device=${encodeURIComponent(device.id)}`,
                          )
                        }
                      >
                        Choose pipeline
                      </Button>
                    </div>
                  )}
                </section>
              )}
              {tab === "pipeline" && (
                <section
                  className="fleet-section device-pipeline"
                  aria-labelledby="device-agent-settings-heading"
                >
                  <div className="fleet-section-heading">
                    <h2 id="device-agent-settings-heading">Agent settings</h2>
                  </div>
                  <div className="device-pipeline-content">
                    <p>
                      {device.policy_assignment
                        ? `Current server policy comes from an assignment with priority ${device.policy_assignment.priority}.`
                        : "No settings assignment reported."}
                    </p>
                    {device.effective_policy ? (
                      <dl className="control-summary-list">
                        <div>
                          <dt>Check-in interval</dt>
                          <dd>
                            {device.effective_policy.heartbeat_seconds} seconds
                          </dd>
                        </div>
                        <div>
                          <dt>Metrics</dt>
                          <dd>
                            {device.effective_policy.telemetry_enabled
                              ? "Enabled"
                              : "Disabled"}
                          </dd>
                        </div>
                        <div>
                          <dt>Server sync policy</dt>
                          <dd>
                            {device.effective_policy.sync_paused
                              ? "Paused"
                              : "Enabled"}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p>Current agent settings have not been reported.</p>
                    )}
                    {settingsAssignment ? (
                      <div className="device-action-row">
                        <a
                          className="button secondary"
                          href={settingsAssignment}
                        >
                          View settings assignment
                        </a>
                      </div>
                    ) : device.policy_assignment ? (
                      <p>Settings assignment link unavailable.</p>
                    ) : null}
                  </div>
                </section>
              )}
              {tab === "metrics" && <TelemetryPanel device={device} />}
              {tab === "activity" && (
                <DeviceActivity
                  device={device}
                  user={user}
                  navigate={navigate}
                />
              )}
            </div>
            <details className="device-disclosure">
              <summary>Technical details</summary>
              <dl className="device-technical">
                <div>
                  <dt>Vector configuration mode</dt>
                  <dd>
                    {device.configuration_mode === "full"
                      ? "Full Vector configuration"
                      : "Restricted components and resources"}
                  </dd>
                </div>
                <div>
                  <dt>Device ID</dt>
                  <dd>{device.id}</dd>
                </div>
                <div>
                  <dt>Last heartbeat</dt>
                  <dd>{when(device.last_seen)}</dd>
                </div>
                <div>
                  <dt>Desired generation</dt>
                  <dd>{device.desired_generation}</dd>
                </div>
                <div>
                  <dt>Last verified generation</dt>
                  <dd>{device.reported_generation}</dd>
                </div>
                <div>
                  <dt>Assignment progress</dt>
                  <dd>{device.apply_state}</dd>
                </div>
                {device.reported_apply_state && (
                  <div>
                    <dt>Reported workload state</dt>
                    <dd>{device.reported_apply_state}</dd>
                  </div>
                )}
                <div>
                  <dt>Current assignment attempt</dt>
                  <dd>
                    {currentConfigurationAttempt(device, version.data)
                      ? `Generation ${device.configuration_attempt!.generation} · ${device.configuration_attempt!.state.replaceAll("_", " ")}`
                      : "Not reported"}
                  </dd>
                </div>
                <div>
                  <dt>Desired version ID</dt>
                  <dd>{device.desired_version_id || "None"}</dd>
                </div>
                {device.desired_sha256 !== undefined && (
                  <div>
                    <dt>Desired artifact SHA-256</dt>
                    <dd>{device.desired_sha256 || "None"}</dd>
                  </div>
                )}
                <div>
                  <dt>Actual file SHA-256</dt>
                  <dd>{device.actual_sha256 || "Not reported"}</dd>
                </div>
                {device.uses_local_secrets && (
                  <>
                    <div>
                      <dt>Applied template SHA-256</dt>
                      <dd>
                        {device.applied_template_sha256 || "Not reported"}
                      </dd>
                    </div>
                    <div>
                      <dt>Local secret attempt revision</dt>
                      <dd>{device.secret_revision ?? "Not reported"}</dd>
                    </div>
                  </>
                )}
                {device.assignment && (
                  <>
                    <div>
                      <dt>Assignment</dt>
                      <dd>{device.assignment.id}</dd>
                    </div>
                    <div>
                      <dt>Priority</dt>
                      <dd>{device.assignment.priority}</dd>
                    </div>
                    <div>
                      <dt>Selection reason</dt>
                      <dd>{device.assignment.reason}</dd>
                    </div>
                  </>
                )}
                {device.policy_assignment && (
                  <>
                    <div>
                      <dt>Settings assignment</dt>
                      <dd>{device.policy_assignment.id}</dd>
                    </div>
                    <div>
                      <dt>Settings priority</dt>
                      <dd>{device.policy_assignment.priority}</dd>
                    </div>
                    <div>
                      <dt>Settings selection reason</dt>
                      <dd>{device.policy_assignment.reason}</dd>
                    </div>
                  </>
                )}
                {Object.keys(device.labels || {}).length > 0 && (
                  <div>
                    <dt>Labels</dt>
                    <dd>
                      {Object.entries(device.labels)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(", ")}
                    </dd>
                  </div>
                )}
              </dl>
            </details>
            {(can(user, "operate") || can(user, "admin")) && (
              <details className="device-disclosure">
                <summary>Sync, recovery and access</summary>
                <div className="device-management">
                  <h3>Configuration sync</h3>
                  <p>
                    Pause incoming configuration changes while you work on this
                    host. Keep its current check-in interval and telemetry
                    settings.
                  </p>
                  <div className="device-action-row">
                    {can(user, "operate") && device.status !== "revoked" && (
                      <Button
                        variant="secondary"
                        disabled={!device.effective_policy}
                        onClick={() =>
                          device.effective_policy &&
                          setPolicy({
                            ...device.effective_policy,
                            sync_paused: !device.sync_paused,
                          })
                        }
                      >
                        {device.sync_paused
                          ? "Review resume policy…"
                          : "Review pause policy…"}
                      </Button>
                    )}
                  </div>
                  {!device.effective_policy && (
                    <p>
                      Refresh this device to load its current agent settings
                      before pausing or resuming sync.
                    </p>
                  )}
                  <DeviceRecoveryActions
                    device={device}
                    user={user}
                    onDone={afterAction}
                    onRefresh={resource.reload}
                  />
                  <DeviceRevocation
                    key={`${user.id}:${user.role}:${device.id}`}
                    device={device}
                    user={user}
                    onRefresh={resource.reload}
                  />
                </div>
              </details>
            )}
            {policy && canReviewPolicy && (
              <TargetDialog
                key={user.id}
                open
                userId={user.id}
                onClose={() => setPolicy(null)}
                policy={policy}
                preserveExistingSettings
                initialDeviceIds={[device.id]}
                onDone={afterAction}
              />
            )}
          </>
        )
      )}
    </div>
  );
}
function DeviceActivity({
  device,
  user,
  navigate,
}: {
  device: Device;
  user: User;
  navigate: Navigate;
}) {
  const id = device.id;
  const issues = useResource<IssueHistoryPage>(
      `/issues/history?state=open&device_id=${encodeURIComponent(id)}&page_size=5`,
      { items: [], total: 0, page: 1, page_size: 5 },
    ),
    audit = useResource<AuditHistoryPage>(
      `/audit/history?device_id=${encodeURIComponent(id)}&page_size=12`,
      { items: [], total: 0, page: 1, page_size: 12 },
    );
  const reports = issues.data.items,
    entries = audit.data.items;
  return (
    <div className="device-activity">
      {(issues.error || audit.error) && (
        <ErrorBox
          message={issues.error || audit.error}
          retry={() => {
            void issues.reload();
            void audit.reload();
          }}
        />
      )}
      <section className="fleet-section">
        <div className="fleet-section-heading">
          <h2>Open issues</h2>
          <button
            className="fleet-link"
            onClick={() => navigate(`issues?device=${encodeURIComponent(id)}`)}
          >
            View device issues <ArrowRight size={14} />
          </button>
        </div>
        {issues.loading ? (
          <Loading>Loading issues</Loading>
        ) : reports.length ? (
          <div className="device-issue-list">
            {issues.data.total > reports.length && (
              <p className="fleet-section-message">
                Showing the latest {reports.length} of {issues.data.total} open
                issues.
              </p>
            )}
            {reports.map((issue) => (
              <article key={issue.id}>
                <strong>{issue.code.replaceAll("_", " ")}</strong>
                <p>{issue.message}</p>
                <small>
                  Last reported{" "}
                  {issue.last_seen
                    ? ago(issue.last_seen).toLowerCase()
                    : "at an unavailable time"}
                  {issue.count > 1 ? ` · ${issue.count} reports` : ""}
                </small>
              </article>
            ))}
          </div>
        ) : issues.error ? null : (
          <p className="fleet-section-message">
            No open issues have been reported for this device.
          </p>
        )}
      </section>
      <section className="fleet-section">
        <div className="fleet-section-heading">
          <h2>Recent changes</h2>
          <button
            className="fleet-link"
            onClick={() =>
              navigate(`audit?device=${encodeURIComponent(id)}&page=1`)
            }
          >
            View device activity <ArrowRight size={14} />
          </button>
        </div>
        {audit.loading ? (
          <Loading>Loading activity</Loading>
        ) : entries.length ? (
          <ActivityRows
            entries={entries}
            names={{ [device.id]: device.name, [user.id]: user.name }}
            deviceId={device.id}
          />
        ) : audit.error ? null : (
          <p className="fleet-section-message">
            No events have been recorded for this device identity.
          </p>
        )}
      </section>
    </div>
  );
}

export function Groups({
  user,
  notify,
}: {
  user: User;
  notify: (message: string) => void;
}) {
  const groups = useResource<Group[]>("/groups", []),
    devices = useResource<Device[]>("/devices", []);
  const groupRequests = useGroupOperations(user.id);
  const createBlocked =
    groupRequests.operations.length > 0 || groupRequests.errors.length > 0;
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Group | null>(null),
    [search, setSearch] = useState(""),
    [nameFilter, setNameFilter] = useState(""),
    [membersFilter, setMembersFilter] = useState(""),
    [sort, setSort] = useState<TableSort | null>({
      column: "group",
      direction: "asc",
    }),
    [page, setPage] = useState(1),
    [savedGroup, setSavedGroup] = useState<Group | null>(null);
  const sortGroups = (rows: Group[]) =>
    sortTableRows(
      rows,
      [
        { id: "group", value: (group) => group.name },
        { id: "members", value: (group) => group.device_ids.length },
      ],
      sort,
    );
  const allowed = can(user, "operate"),
    filtered = sortGroups(
      groups.data.filter(
        (group) =>
          `${group.name} ${group.description}`
            .toLowerCase()
            .includes(search.toLowerCase()) &&
          matchesTableFilter(group.name, nameFilter, false) &&
          (!membersFilter ||
            (membersFilter === "empty"
              ? group.device_ids.length === 0
              : group.device_ids.length > 0)),
      ),
    ),
    currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 12)));
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
    const query = `${refreshed.name} ${refreshed.description}`
      .toLowerCase()
      .includes(search.toLowerCase())
      ? search
      : "";
    const visible = sortGroups(
      groups.data.filter((group) =>
        `${group.name} ${group.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    );
    setSearch(query);
    setNameFilter("");
    setMembersFilter("");
    setPage(
      Math.floor(
        visible.findIndex((group) => group.id === savedGroup.id) / 12,
      ) + 1,
    );
    setSavedGroup(null);
  }, [groups.data, savedGroup, search, sort]);
  function edit(group?: Group) {
    if (!group && createBlocked) return;
    setEditing(group || null);
    setOpen(true);
  }
  const columns: TableColumn<Group>[] = [
    {
      id: "group",
      header: "Group",
      value: (group) => group.name,
      filter: {
        value: nameFilter,
        onChange: (value) => {
          setNameFilter(value);
          setPage(1);
        },
        manual: true,
        placeholder: "Filter group names",
      },
      cell: (group) => (
        <button className="fleet-device-name" onClick={() => edit(group)}>
          <strong>{group.name}</strong>
          {group.description && <small>{group.description}</small>}
        </button>
      ),
    },
    {
      id: "members",
      header: "Members",
      value: (group) => group.device_ids.length,
      filter: {
        value: membersFilter,
        onChange: (value) => {
          setMembersFilter(value);
          setPage(1);
        },
        manual: true,
        options: [
          { value: "empty", label: "No members" },
          { value: "populated", label: "Has members" },
        ],
      },
      cell: (group) => (
        <>
          <strong className="fleet-member-count">
            {group.device_ids.length}{" "}
            {group.device_ids.length === 1 ? "device" : "devices"}
          </strong>
          <small className="fleet-cell-note">
            {group.device_ids
              .slice(0, 3)
              .map(
                (id) => devices.data.find((device) => device.id === id)?.name,
              )
              .filter(Boolean)
              .join(", ")}
            {group.device_ids.length > 3
              ? ` +${group.device_ids.length - 3} more`
              : ""}
          </small>
        </>
      ),
    },
    {
      id: "manage",
      header: <span className="sr-only">Manage group</span>,
      cell: (group) => (
        <button className="fleet-link" onClick={() => edit(group)}>
          {allowed ? "Edit group" : "View members"}
          <ArrowRight size={14} />
        </button>
      ),
    },
  ];
  return (
    <div className="fleet-workspace">
      <PageHeader
        title="Groups"
        help={{ topic: "deployments", section: "review-the-target-set" }}
        description="Group devices to assign a pipeline or agent policy together."
      >
        {allowed && (
          <Button icon={Plus} onClick={() => edit()} disabled={createBlocked}>
            Create group
          </Button>
        )}
      </PageHeader>
      {groups.error && (
        <ErrorBox message={groups.error} retry={groups.reload} />
      )}
      <GroupRecovery
        user={user}
        onRecovered={() => {
          void groups.reload();
          notify("Group creation confirmed.");
        }}
        onReview={(group) => edit(group)}
      />
      <div className="fleet-toolbar">
        <SearchBox
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search groups"
        />
        <RefreshButton
          onClick={groups.reload}
          busy={groups.loading}
          aria-label="Refresh groups"
          title="Refresh groups"
        />
      </div>
      <div className="fleet-table-panel">
        <DataTable
          data={groups.error ? [] : filtered}
          columns={columns}
          rowKey={(group) => group.id}
          label="Groups"
          className="fleet-table"
          loading={groups.loading}
          sort={sort}
          onSortChange={(value) => {
            setSort(value);
            setPage(1);
          }}
          manualSorting
          pagination={
            groups.error
              ? undefined
              : { page: currentPage, size: 12, onPage: setPage }
          }
          empty={
            groups.error ? (
              "Groups could not be loaded."
            ) : (
              <Blank
                title={
                  groups.data.length ? "No matching groups" : "No groups yet"
                }
                action={
                  groups.data.length ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSearch("");
                        setNameFilter("");
                        setMembersFilter("");
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : allowed ? (
                    <Button onClick={() => edit()} disabled={createBlocked}>
                      Create group
                    </Button>
                  ) : undefined
                }
              >
                {groups.data.length
                  ? "Try another group name or member filter."
                  : "Create a group for devices that share an environment, region or purpose."}
              </Blank>
            )
          }
        />
      </div>
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
            notify("Group saved.");
            void groups.reload();
          }}
        />
      )}
    </div>
  );
}
