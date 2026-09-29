import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, CopyPlus, Pencil, Plus } from "lucide-react";
import { DataTable } from "./DataTable";
import {
  can,
  type DeploymentPage,
  type DeploymentSummary,
  type Policy,
  type SavedPolicy,
  type SavedPolicyListItem,
  type User,
} from "./api";
import { deploymentRoute } from "./deploymentRouting";
import {
  Button,
  DateCell,
  ErrorBox,
  PageHeader,
  Spinner,
  useResource,
} from "./ui";
import TargetDialog from "./TargetDialog";
import AgentSettingsCreation, {
  type AgentSettingsCreationHandle,
} from "./AgentSettingsCreation";
import AgentSettingsEditor from "./AgentSettingsEditor";
import "./control.css";

const words = (value: string) =>
  value.replaceAll("_", " ").replaceAll(".", " ");
const stateText: Record<string, string> = {
  active: "In progress",
  completed: "Complete",
  scheduled: "Scheduled",
  paused: "Paused",
  failed: "Needs attention",
  cancelled: "Cancelled",
  unassigned: "Removed",
  missed: "Schedule missed",
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
  removed: "No longer targeted",
  revoked: "Revoked",
};
function Status({ state }: { state: string }) {
  return (
    <span className="control-status" data-state={state}>
      {stateText[state] || words(state)}
    </span>
  );
}
function Quiet({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="control-empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Policies({
  user,
  notify,
}: {
  user: User;
  notify: (message: string) => void;
}) {
  const { data, error, loading, reload } = useResource<SavedPolicyListItem[]>(
    "/policies",
    [],
  );
  const creation = useRef<AgentSettingsCreationHandle>(null);
  const editOpener = useRef<HTMLElement | null>(null);
  const [deploy, setDeploy] = useState<{
    setting: SavedPolicy;
    deviceIds: string[];
  } | null>(null);
  const [editing, setEditing] = useState<SavedPolicyListItem | null>(null);
  const operate = can(user, "operate");
  // Settings applied straight from a device or the deploy dialog have no
  // saved record; devices still run them, so list them here too.
  const history = useResource<DeploymentPage>(
    "/deployments/history?status=all&search=Agent%20settings&page=1&page_size=50",
    { items: [], total: 0, page: 1, page_size: 50 },
  );
  const unsaved = unsavedSettings(history.data.items);
  return (
    <div className="control-page agent-settings-page">
      <PageHeader
        title="Agent settings"
        help={{
          topic: "glossary",
          section: "devices-permissions-and-credentials",
        }}
        description="Reusable check-in, sync and metrics settings. Devices change only when you apply them."
      >
        {operate && (
          <Button
            icon={Plus}
            onClick={(event) =>
              creation.current?.openCreate(event.currentTarget)
            }
          >
            New settings
          </Button>
        )}
      </PageHeader>
      <AgentSettingsCreation
        key={`${user.id}:${user.role}`}
        ref={creation}
        user={user}
        onCreated={() => {
          notify("Saved. No devices change until you apply these settings.");
          void reload();
        }}
        onApply={(setting) => {
          setDeploy({ setting, deviceIds: [] });
          return true;
        }}
      />
      {error && <ErrorBox message={error} retry={reload} />}
      {unsaved.length > 0 && (
        <UnsavedSettings
          items={unsaved}
          canSave={operate}
          onSave={(opener, policy) =>
            creation.current?.openCreate(opener, {
              name: settingsName(policy),
              policy,
            })
          }
        />
      )}
      <div className="control-table">
        <DataTable<SavedPolicyListItem>
          data={error ? [] : data}
          rowKey={(setting) => setting.id}
          label="Agent settings"
          loading={loading}
          columns={[
            {
              id: "name",
              header: "Settings",
              value: (setting) => setting.name,
              filter: { placeholder: "Filter settings names" },
              cell: (setting) => <strong>{setting.name}</strong>,
            },
            {
              id: "interval",
              header: "Check-in interval",
              value: (setting) => setting.policy.heartbeat_seconds,
              filter: { placeholder: "Filter seconds" },
              cell: (setting) => `${setting.policy.heartbeat_seconds} seconds`,
            },
            {
              id: "sync",
              header: "Configuration sync",
              value: (setting) =>
                setting.policy.sync_paused ? "Paused" : "Enabled",
              filter: {
                options: [
                  { value: "Paused", label: "Paused" },
                  { value: "Enabled", label: "Enabled" },
                ],
              },
              cell: (setting) =>
                setting.policy.sync_paused ? "Paused" : "Enabled",
            },
            {
              id: "metrics",
              header: "Metrics",
              value: (setting) =>
                setting.policy.telemetry_enabled ? "Collected" : "Off",
              filter: {
                options: [
                  { value: "Collected", label: "Collected" },
                  { value: "Off", label: "Off" },
                ],
              },
              cell: (setting) =>
                setting.policy.telemetry_enabled ? "Collected" : "Off",
            },
            {
              id: "applied",
              header: "Applied to",
              value: (setting) => setting.applied_device_count ?? -1,
              cell: (setting) => <AppliedDevices setting={setting} />,
            },
            {
              id: "updated",
              header: "Updated",
              value: (setting) => setting.updated_at || setting.created_at,
              cell: (setting) => (
                <DateCell value={setting.updated_at || setting.created_at} />
              ),
            },
            {
              id: "actions",
              header: <span className="sr-only">Actions</span>,
              label: "Actions",
              cell: (setting) =>
                operate && (
                  <div className="agent-settings-actions">
                    <Button
                      variant="secondary compact"
                      onClick={() => setDeploy({ setting, deviceIds: [] })}
                    >
                      Apply to devices
                    </Button>
                    {setting.revision !== undefined && (
                      <Button
                        variant="ghost compact"
                        icon={Pencil}
                        aria-label={`Edit ${setting.name}`}
                        onClick={(event) => {
                          editOpener.current = event.currentTarget;
                          setEditing(setting);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      variant="ghost compact"
                      icon={CopyPlus}
                      aria-label={`Duplicate ${setting.name}`}
                      onClick={(event) =>
                        creation.current?.openCreate(event.currentTarget, {
                          name: `${setting.name} copy`.slice(0, 120),
                          policy: setting.policy,
                        })
                      }
                    >
                      Duplicate
                    </Button>
                  </div>
                ),
            },
          ]}
          empty={
            error ? (
              "Agent settings could not be loaded."
            ) : data.length ? (
              "No settings match these filters."
            ) : (
              <Quiet
                title={
                  unsaved.length
                    ? "No saved agent settings yet"
                    : "No saved agent settings"
                }
                action={
                  operate ? (
                    <Button
                      onClick={(event) =>
                        creation.current?.openCreate(event.currentTarget)
                      }
                    >
                      Create settings
                    </Button>
                  ) : undefined
                }
              >
                {unsaved.length
                  ? "The settings above were applied without saving. Save them to reuse and track them here."
                  : "Control how often agents check in, collect metrics, and sync pipeline changes."}
              </Quiet>
            )
          }
        />
      </div>
      <p className="control-muted">
        Devices pick up applied settings on their next check-in. A pause set on
        the device itself stays until someone clears it there.
      </p>
      {editing && operate && (
        <AgentSettingsEditor
          key={editing.id}
          setting={editing}
          returnFocusRef={editOpener}
          onClose={() => setEditing(null)}
          onSaved={() => {
            notify("Saved. No devices change until you apply these settings.");
            void reload();
          }}
          onApply={(setting, deviceIds) => {
            setEditing(null);
            setDeploy({ setting, deviceIds });
          }}
        />
      )}
      {deploy && operate && (
        <TargetDialog
          key={user.id}
          userId={user.id}
          open
          onClose={() => {
            setDeploy(null);
            void reload();
          }}
          policy={deploy.setting.policy}
          policyId={deploy.setting.id}
          policyName={deploy.setting.name}
          initialDeviceIds={deploy.deviceIds}
          onDone={(message) => {
            notify(message);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/** "Check-ins every 15 s, sync on" as a starting name for saved settings. */
function settingsName(policy: Policy) {
  return [
    `Check-ins every ${policy.heartbeat_seconds} s`,
    policy.sync_paused ? "sync paused" : "",
    policy.telemetry_enabled ? "" : "metrics off",
  ]
    .filter(Boolean)
    .join(", ");
}
/**
 * Settings deployments without a saved record that still reach devices,
 * newest first, one per distinct set of values.
 */
export function unsavedSettings(items: DeploymentSummary[]) {
  const seen = new Set<string>();
  return items.filter((d) => {
    if (!d.policy || d.policy_id || d.rolled_back_by) return false;
    if (!["active", "paused", "completed", "scheduled"].includes(d.status))
      return false;
    if (d.target_count - (d.state_counts.removed || 0) <= 0) return false;
    const key = JSON.stringify(d.policy);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function UnsavedSettings({
  items,
  canSave,
  onSave,
}: {
  items: DeploymentSummary[];
  canSave: boolean;
  onSave(opener: HTMLElement, policy: Policy): void;
}) {
  return (
    <section
      className="control-card agent-settings-unsaved"
      aria-labelledby="agent-settings-unsaved-title"
    >
      <h2 id="agent-settings-unsaved-title">Applied without saving</h2>
      <p className="control-muted">
        Devices run these settings, but no saved record holds them.
      </p>
      <ul>
        {items.map((d) => {
          const devices = d.target_count - (d.state_counts.removed || 0);
          return (
            <li key={d.id}>
              <span className="agent-settings-unsaved-copy">
                <strong>{settingsName(d.policy!)}</strong>
                <small>
                  <a
                    href={`#/${deploymentRoute(false, d.id, { search: "", status: "all", page: 1 })}`}
                  >
                    Applied to{" "}
                    {devices === 1 ? "1 device" : `${devices} devices`}
                  </a>
                  {d.created_by_name ? ` by ${d.created_by_name}` : ""} ·{" "}
                  <DateCell value={d.created_at} />
                </small>
              </span>
              {canSave && (
                <Button
                  variant="secondary compact"
                  onClick={(event) => onSave(event.currentTarget, d.policy!)}
                >
                  Save as settings…
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "3 devices", opening the list of devices that follow these settings. */
function AppliedDevices({ setting }: { setting: SavedPolicyListItem }) {
  const count = setting.applied_device_count;
  const devices = setting.applied_devices || [];
  const outdated = setting.outdated_device_count || 0;
  if (count === undefined)
    return <span className="control-muted">Unknown</span>;
  if (!count) return <span className="control-muted">Not applied</span>;
  return (
    <span className="agent-settings-applied">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" className="agent-settings-applied-trigger">
            {count === 1 ? "1 device" : `${count} devices`}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="agent-settings-applied-menu"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            aria-label={`Devices using ${setting.name}`}
          >
            <ul>
              {devices.map((device) => (
                <li key={device.id}>
                  <a href={`#/devices/${encodeURIComponent(device.id)}`}>
                    {device.name || device.id}
                  </a>
                </li>
              ))}
            </ul>
            {count > devices.length && <p>and {count - devices.length} more</p>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {outdated > 0 && (
        <small className="agent-settings-outdated">
          {outdated === count
            ? "On earlier values"
            : `${outdated} on earlier values`}
        </small>
      )}
    </span>
  );
}

export function Settings() {
  const { data, error, loading } = useResource<any>("/settings", null);
  return (
    <div className="control-page">
      <PageHeader
        title="General"
        help={{ topic: "administer", section: "monitor-the-instance" }}
        description="Instance information and host-managed defaults."
      />
      {error && <ErrorBox message={error} />}
      <section className="control-card">
        <h2>Instance</h2>
        {loading ? (
          <Spinner />
        ) : (
          <dl className="control-summary-list">
            <div>
              <dt>Name</dt>
              <dd>{data?.instance_name || "Unavailable"}</dd>
            </div>
            <div>
              <dt>Vectory version</dt>
              <dd>{data?.version || "Unavailable"}</dd>
            </div>
            <div>
              <dt>Vector version</dt>
              <dd>{data?.vector_version || "Unavailable"}</dd>
            </div>
          </dl>
        )}
      </section>
      <section className="control-card">
        <h2>Defaults</h2>
        <dl className="control-summary-list">
          <div>
            <dt>Check-in interval</dt>
            <dd>
              {data?.heartbeat_seconds
                ? `${data.heartbeat_seconds} seconds`
                : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Metric retention</dt>
            <dd>
              {data?.telemetry_retention_days
                ? `${data.telemetry_retention_days} days`
                : "Unavailable"}
            </dd>
          </div>
        </dl>
        <p className="control-muted">
          The host administrator configures this instance. Apply device-specific
          behavior under Devices, Agent settings.
        </p>
        <details className="control-disclosure">
          <summary>Hosting and recovery</summary>
          <div className="control-disclosure-content">
            <p className="control-muted">
              Run one control-plane instance on local persistent storage. Use
              the included backup tool to preserve the database and its trust
              keys together.
            </p>
            <p className="control-muted">
              After restoring an older backup, follow the reviewed
              generation-recovery procedure before resuming deployments. Agent
              counters must not be reset.
            </p>
          </div>
        </details>
      </section>
    </div>
  );
}
