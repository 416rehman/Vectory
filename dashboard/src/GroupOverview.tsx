import { ArrowRight } from "lucide-react";
import type { DeploymentPage, DeploymentSummary, Device, Group } from "./api";
import { ErrorBox, Spinner, useResource } from "./ui";
import { deploymentRoute } from "./deploymentRouting";
import {
  describeDeployment,
  interval,
  isLive,
  since,
  type StatusTone,
} from "./deploymentStatus";
import { StatusChip } from "./DeploymentRollout";
import { runningName } from "./deploymentReview";

const deviceTones: Record<string, [string, StatusTone]> = {
  verified: ["Verified", "success"],
  unmanaged: ["Local config", "neutral"],
  applying: ["Applying", "info"],
  failed: ["Failed", "danger"],
  rolled_back: ["Rolled back", "danger"],
  verification_unknown: ["Needs verification", "warning"],
  paused: ["Sync paused", "warning"],
  offline: ["Offline", "warning"],
  awaiting_first_check_in: ["Waiting for first check-in", "neutral"],
  revoked: ["Revoked", "neutral"],
};
function deviceState(device: Device): [string, StatusTone] {
  return (
    deviceTones[device.status] || [
      device.status.replaceAll("_", " "),
      "neutral",
    ]
  );
}
function assignmentTitle(d: DeploymentSummary) {
  if (d.policy)
    return d.policy_name
      ? `“${d.policy_name}” settings`
      : `Agent settings (${d.policy.sync_paused ? "sync paused" : "sync on"}, ${interval(d.policy.heartbeat_seconds)} check-ins)`;
  const pipeline = d.configuration_name || d.name || "Pipeline";
  return d.version_number ? `${pipeline} v${d.version_number}` : pipeline;
}
const route = (id: string) =>
  `#/${deploymentRoute(false, id, { search: "", status: "all", page: 1 })}`;

/**
 * What a group is for: its members and their state, what is assigned to it
 * and its recent rollouts. Read-only; editing lives on the Members tab.
 */
export default function GroupOverview({
  group,
  devices,
}: {
  group: Group;
  devices: Device[];
}) {
  const params = new URLSearchParams({
    group_id: group.id,
    status: "all",
    page: "1",
    page_size: "12",
  });
  const history = useResource<DeploymentPage>(
    `/deployments/history?${params}`,
    {
      items: [],
      total: 0,
      page: 1,
      page_size: 12,
    },
  );
  const members = group.device_ids
    .map((id) => devices.find((device) => device.id === id))
    .filter((device): device is Device => !!device)
    .sort((a, b) => a.name.localeCompare(b.name));
  const missing = group.device_ids.length - members.length;
  const counts = new Map<
    string,
    { label: string; tone: StatusTone; count: number }
  >();
  for (const device of members) {
    const [label, tone] = deviceState(device);
    const entry = counts.get(label) || { label, tone, count: 0 };
    entry.count += 1;
    counts.set(label, entry);
  }
  // Current assignments: still able to deliver something to members.
  const current = history.data.items.filter(
    (d) =>
      ["active", "paused", "completed", "scheduled"].includes(d.status) &&
      !d.rolled_back_by,
  );
  const recent = history.data.items.slice(0, 5);
  return (
    <div className="group-overview">
      <section aria-labelledby="group-overview-members">
        <div className="group-overview-head">
          <h3 id="group-overview-members">
            {members.length === 1 ? "1 device" : `${members.length} devices`}
          </h3>
          <div className="group-overview-counts">
            {[...counts.values()].map((entry) => (
              <StatusChip key={entry.label} tone={entry.tone}>
                {entry.count} {entry.label.toLowerCase()}
              </StatusChip>
            ))}
          </div>
        </div>
        {members.length ? (
          <ul className="group-overview-devices">
            {members.slice(0, 50).map((device) => {
              const [label, tone] = deviceState(device);
              return (
                <li key={device.id}>
                  <a href={`#/devices/${encodeURIComponent(device.id)}`}>
                    {device.name}
                  </a>
                  <span className="group-overview-running">
                    {runningName(device)}
                  </span>
                  <StatusChip tone={tone}>{label}</StatusChip>
                  <small>
                    {device.last_seen
                      ? `Checked in ${since(device.last_seen)?.toLowerCase()}`
                      : "Never checked in"}
                  </small>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="control-muted">
            No members yet. Add devices on the Members tab.
          </p>
        )}
        {members.length > 50 && (
          <p className="control-muted">And {members.length - 50} more.</p>
        )}
        {missing > 0 && (
          <p className="control-muted">
            {missing} {missing === 1 ? "member is" : "members are"} no longer
            enrolled.
          </p>
        )}
      </section>
      <section aria-labelledby="group-overview-assigned">
        <h3 id="group-overview-assigned">Assigned to this group</h3>
        {history.error && (
          <ErrorBox message={history.error} retry={history.reload} />
        )}
        {history.loading && !history.data.items.length ? (
          <p className="loading" role="status">
            <Spinner /> Loading assignments
          </p>
        ) : current.length ? (
          <ul className="group-overview-assignments">
            {current.map((d) => {
              const display = describeDeployment(d);
              return (
                <li key={d.id}>
                  <a href={route(d.id)}>{assignmentTitle(d)}</a>
                  <span className="control-muted">
                    {d.target_mode === "persistent"
                      ? "Follows this group"
                      : "Deployed to its members at the time (fixed)"}{" "}
                    · priority {d.priority}
                  </span>
                  <StatusChip tone={display.tone} spin={isLive(d.status)}>
                    {display.label}
                  </StatusChip>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="control-muted">
            Nothing is assigned through this group. Deploy a pipeline or apply
            settings and choose this group as the target.
          </p>
        )}
      </section>
      {recent.length > 0 && (
        <section aria-labelledby="group-overview-recent">
          <h3 id="group-overview-recent">Recent rollouts</h3>
          <ul className="group-overview-rollouts">
            {recent.map((d) => {
              const display = describeDeployment(d);
              return (
                <li key={d.id}>
                  <a href={route(d.id)}>
                    {assignmentTitle(d)}
                    <ArrowRight size={13} aria-hidden="true" />
                  </a>
                  <span className="control-muted">
                    {d.verified_count} of{" "}
                    {d.target_count - (d.state_counts.removed || 0)} verified ·{" "}
                    {since(d.created_at)?.toLowerCase()}
                  </span>
                  <StatusChip tone={display.tone} spin={isLive(d.status)}>
                    {display.label}
                  </StatusChip>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
