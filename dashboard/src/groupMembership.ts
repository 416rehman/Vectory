import type { GroupMembershipPreview, GroupMembershipState } from "./api";
import { assignmentName, policySummary } from "./deploymentReview";

type Part = GroupMembershipPreview["devices"][number]["configuration"];

function pipeline(state: NonNullable<GroupMembershipState>) {
  const name =
    state.configuration_name || state.assignment_name || "a pipeline";
  return state.version_number ? `${name} v${state.version_number}` : name;
}

function configurationEffect(part: Part, change: "added" | "removed") {
  const { before, after, pending } = part;
  if (pending)
    return `queues ${assignmentName(pending)}, which deploys when its rollout reaches this device`;
  if (!part.changed) return null;
  if (
    after?.version_id &&
    before?.version_id &&
    after.version_id !== before.version_id
  )
    return `switches it from ${pipeline(before)} to ${pipeline(after)}`;
  if (after?.version_id && !before?.version_id)
    return `deploys ${pipeline(after)}`;
  if (!after && before?.version_id)
    return change === "removed"
      ? `stops managing its pipeline; it keeps running ${pipeline(before)}`
      : `stops managing its pipeline`;
  if (after?.version_id)
    return `moves it to ${after.assignment_name || pipeline(after)}`;
  return null;
}

function policyEffect(part: Part) {
  const { before, after, pending } = part;
  if (pending) return `queues ${assignmentName(pending)}`;
  if (!part.changed) return null;
  if (after?.policy)
    return `applies agent settings (${policySummary(after.policy).toLowerCase()})`;
  if (before?.policy) return "leaves its current agent settings unmanaged";
  return null;
}

/**
 * "Adding web-01 deploys Web access logs v3." One sentence per device, from
 * the server's simulation of the exact membership edit.
 */
export function membershipSentence(
  entry: GroupMembershipPreview["devices"][number],
  name: string,
) {
  const effects = [
    configurationEffect(entry.configuration, entry.change),
    policyEffect(entry.policy),
  ].filter(Boolean);
  const verb = entry.change === "added" ? "Adding" : "Removing";
  if (!effects.length) return `${verb} ${name} changes nothing on it.`;
  return `${verb} ${name} ${effects.join(" and ")}.`;
}
