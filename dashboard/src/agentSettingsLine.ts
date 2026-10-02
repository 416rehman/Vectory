import type { Assignment, Policy } from "./api";
import { interval } from "./deploymentStatus";

/** "Sep 29", or "Sep 29, 2025" when it isn't this year. */
function day(at: string, now: Date) {
  const date = new Date(at);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/**
 * Where a device's agent settings come from, as the server reports it:
 * "Check-in 15 s · applied by Ada on Sep 29 (not saved)". Each part appears
 * only when the server gave it. `policy_id` is null for settings never saved
 * under a name, and absent when the server doesn't say, which names nothing.
 */
export function agentSettingsLine(
  device: { effective_policy?: Policy; policy_assignment?: Assignment },
  now = new Date(),
) {
  const { effective_policy: policy, policy_assignment: assignment } = device;
  const parts: string[] = [];
  if (policy) parts.push(`Check-in ${interval(policy.heartbeat_seconds)}`);
  if (!assignment) parts.push("no settings assignment reported");
  else {
    const date = assignment.created_at ? day(assignment.created_at, now) : null;
    const applied = [
      assignment.created_by_name && `by ${assignment.created_by_name}`,
      date && `on ${date}`,
    ]
      .filter(Boolean)
      .join(" ");
    if (applied) parts.push(`applied ${applied}`);
  }
  const saved =
    assignment?.policy_id === null
      ? "not saved"
      : assignment?.policy_id
        ? assignment.policy_name
          ? `saved as “${assignment.policy_name}”`
          : "saved"
        : "";
  const line = parts.length
    ? `${parts.join(" · ")}${saved ? ` (${saved})` : ""}`
    : saved;
  return line.charAt(0).toUpperCase() + line.slice(1);
}
