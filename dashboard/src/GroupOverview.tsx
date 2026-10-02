import { ArrowRight } from "lucide-react";
import type {
  DeploymentPage,
  DeploymentSummary,
  Group,
  GroupSummary,
} from "./api";
import { ErrorBox, Spinner, StatusBadge, useResource } from "./ui";
import { deviceDisplayStatus, statusLabel } from "./status";
import { relativeTime } from "./time";
import { deploymentRoute } from "./deploymentRouting";
import {
  deploymentCounts,
  describeDeployment,
  interval,
} from "./deploymentStatus";
import { runningName } from "./deploymentReviewModel";
import { healthOrder, healthStates } from "./overviewModel";
import { useInventory } from "./useInventory";

/** Members listed by name before "and N more". */
const LISTED = 50;

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
  memberCount,
}: {
  group: Group | GroupSummary;
  /** How many devices the group holds, when the caller knows. */
  memberCount: number | null;
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
  // The first members by name, and the state counts of all of them, from the
  // inventory: a group of thousands is never downloaded to be summarised.
  const inventory = useInventory(
    { group: group.id, sort: "name", dir: "asc", page: 1, size: LISTED },
    30000,
  );
  const members = inventory.data.items;
  const total = inventory.data.total;
  const held = inventory.data.counts.status;
  // Members the fleet no longer knows: the group's count less every state.
  const missing =
    memberCount === null
      ? 0
      : Math.max(
          0,
          memberCount -
            Object.values(held).reduce((sum, count) => sum + count, 0),
        );
  const counts = new Map<string, number>();
  for (const bucket of [...healthOrder, "revoked" as const]) {
    const count = held[bucket];
    if (!count) continue;
    counts.set(
      bucket === "revoked" ? "revoked" : healthStates[bucket][0],
      count,
    );
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
            {inventory.loaded
              ? total === 1
                ? "1 device"
                : `${total.toLocaleString()} devices`
              : "Members"}
          </h3>
          <div className="group-overview-counts">
            {[...counts].map(([state, count]) => (
              <StatusBadge
                key={state}
                domain="device"
                value={state}
                label={`${count} ${statusLabel("device", state).toLowerCase()}`}
              />
            ))}
          </div>
        </div>
        {inventory.resource.error && (
          <ErrorBox
            message={inventory.resource.error}
            retry={inventory.resource.reload}
          />
        )}
        {!inventory.loaded && !inventory.resource.error ? (
          <p className="loading" role="status">
            <Spinner /> Loading members
          </p>
        ) : members.length ? (
          <ul className="group-overview-devices">
            {members.map((device) => {
              return (
                <li key={device.id}>
                  <a href={`#/devices/${encodeURIComponent(device.id)}`}>
                    {device.name}
                  </a>
                  <span className="group-overview-running">
                    {runningName(device)}
                  </span>
                  <StatusBadge
                    domain="device"
                    value={deviceDisplayStatus(device)}
                  />
                  <small>
                    {device.last_seen
                      ? `Checked in ${relativeTime(device.last_seen)}`
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
        {total > members.length && (
          <p className="control-muted">
            And {(total - members.length).toLocaleString()} more.{" "}
            <a href={`#/devices?group=${encodeURIComponent(group.id)}`}>
              View all devices
            </a>
          </p>
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
                  <StatusBadge
                    domain="deployment"
                    value={display.state}
                    label={display.label}
                  />
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
                    {deploymentCounts(d).sentence} ·{" "}
                    {relativeTime(d.created_at)}
                  </span>
                  <StatusBadge
                    domain="deployment"
                    value={display.state}
                    label={display.label}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
