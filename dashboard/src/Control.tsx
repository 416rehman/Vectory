import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDown,
  CopyPlus,
  Pencil,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { DataTable, TableCard } from "./DataTable";
import {
  can,
  type SavedPolicy,
  type SavedPolicyListItem,
  type User,
} from "./api";
import {
  Button,
  DateCell,
  EmptyState,
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
import type { Notify } from "./toast";

export function Policies({ user, notify }: { user: User; notify: Notify }) {
  const { data, error, loading, reload, refreshing, updatedAt } = useResource<
    SavedPolicyListItem[]
  >("/policies", []);
  // Nothing saved yet: the first-run message replaces the table.
  const firstRun = !loading && !error && data.length === 0;
  const creation = useRef<AgentSettingsCreationHandle>(null);
  const editOpener = useRef<HTMLElement | null>(null);
  const [deploy, setDeploy] = useState<{
    setting: SavedPolicy;
    deviceIds: string[];
  } | null>(null);
  const [editing, setEditing] = useState<SavedPolicyListItem | null>(null);
  const operate = can(user, "operate");
  return (
    <div className="control-page agent-settings-page">
      <PageHeader
        title="Agent settings"
        help={{
          topic: "glossary",
          section: "devices-permissions-and-credentials",
        }}
        description="Reusable check-in, sync and metrics settings. Devices change only when you apply them."
        live={{
          updatedAt,
          error: error || undefined,
          loading,
          refreshing,
          onRefresh: () => void reload(),
        }}
      >
        {operate && !firstRun && (
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
          notify("Saved. No devices change until you apply these settings.", {
            tone: "success",
          });
          void reload();
        }}
        onApply={(setting) => {
          setDeploy({ setting, deviceIds: [] });
          return true;
        }}
      />
      {firstRun ? (
        <TableCard>
          <EmptyState
            icon={SlidersHorizontal}
            title="No saved agent settings"
            action={
              operate ? (
                <Button
                  icon={Plus}
                  onClick={(event) =>
                    creation.current?.openCreate(event.currentTarget)
                  }
                >
                  New settings
                </Button>
              ) : undefined
            }
          >
            Control how often agents check in, collect metrics, and sync
            pipeline changes.
          </EmptyState>
        </TableCard>
      ) : (
        <TableCard className="control-table">
          <DataTable<SavedPolicyListItem>
            data={data}
            rowKey={(setting) => setting.id}
            label="Agent settings"
            loading={loading}
            error={
              error
                ? {
                    title: updatedAt
                      ? "Couldn't refresh agent settings."
                      : "Couldn't load agent settings.",
                    message: error,
                    updatedAt,
                    retry: () => void reload(),
                    retrying: refreshing,
                  }
                : null
            }
            mobileCard={(setting) => ({
              title: setting.name,
              meta: [
                `Check-in every ${setting.policy.heartbeat_seconds} s`,
                setting.policy.sync_paused ? "Sync paused" : "Sync on",
                setting.policy.telemetry_enabled ? "Metrics on" : "Metrics off",
              ],
              status: operate ? (
                <Button
                  variant="secondary compact"
                  onClick={() => setDeploy({ setting, deviceIds: [] })}
                >
                  Apply
                </Button>
              ) : undefined,
            })}
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
                cell: (setting) =>
                  `${setting.policy.heartbeat_seconds} seconds`,
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
              <EmptyState variant="filtered" title="No matching settings">
                Try another name, interval or state.
              </EmptyState>
            }
          />
        </TableCard>
      )}
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
            notify("Saved. No devices change until you apply these settings.", {
              tone: "success",
            });
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
            notify(message, { tone: "success" });
            void reload();
          }}
        />
      )}
    </div>
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
