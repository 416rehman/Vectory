import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { DataTable } from "./DataTable";
import { can, type Policy, type SavedPolicy, type User } from "./api";
import { Button, ErrorBox, PageHeader, Spinner, useResource } from "./ui";
import TargetDialog from "./TargetDialog";
import AgentSettingsCreation, {
  type AgentSettingsCreationHandle,
} from "./AgentSettingsCreation";
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
  const { data, error, loading, reload } = useResource<SavedPolicy[]>(
    "/policies",
    [],
  );
  const creation = useRef<AgentSettingsCreationHandle>(null);
  const [deploy, setDeploy] = useState<Policy | null>(null);
  return (
    <div className="control-page">
      <PageHeader
        title="Agent settings"
        help={{
          topic: "glossary",
          section: "devices-permissions-and-credentials",
        }}
        description="Save a set of agent settings, then apply it to selected devices."
      >
        {can(user, "operate") && (
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
          notify("Agent settings saved. Choose devices to apply them.");
          void reload();
        }}
        onApply={(setting) => {
          setDeploy(setting.policy);
          return true;
        }}
      />
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="control-table">
        <DataTable
          data={error ? [] : data}
          rowKey={(setting) => setting.id}
          label="Agent settings"
          loading={loading}
          columns={[
            {
              id: "name",
              header: "Name",
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
              id: "actions",
              header: <span className="sr-only">Apply settings</span>,
              cell: (setting) =>
                can(user, "operate") && (
                  <Button
                    variant="secondary compact"
                    onClick={() => setDeploy(setting.policy)}
                  >
                    Apply to devices
                  </Button>
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
                title="No saved agent settings"
                action={
                  can(user, "operate") ? (
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
                Control how often agents check in, collect metrics, and sync
                pipeline changes.
              </Quiet>
            )
          }
        />
      </div>
      <p className="control-muted">
        Changes take effect after each agent checks in. A local emergency pause
        always stays in effect until cleared on that device.
      </p>
      {deploy && can(user, "operate") && (
        <TargetDialog
          key={user.id}
          userId={user.id}
          open
          onClose={() => setDeploy(null)}
          policy={deploy}
          onDone={notify}
        />
      )}
    </div>
  );
}

export { default as AuditLog } from "./AuditLog";

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
