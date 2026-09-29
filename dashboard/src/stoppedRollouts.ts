import type { DeploymentSummary } from "./api";
import { progressSegments } from "./deploymentStatus";

/** A rollout that stopped, or was rolled back, and still deserves a look. */
export type StoppedRollout = {
  deployment: DeploymentSummary;
  kind: "stopped" | "rolled_back";
  title: string;
  detail: string;
  at: string;
};

const DAY = 86400000;

function name(d: DeploymentSummary) {
  if (d.policy) return d.policy_name || "Agent settings";
  const pipeline = d.configuration_name || d.name || "A pipeline";
  return d.version_number ? `${pipeline} v${d.version_number}` : pipeline;
}
function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Failed rollouts that still hold devices back, and rollbacks of the last day,
 * newest first. A failed rollout whose devices all verified since, or that a
 * newer version replaced everywhere, no longer needs anyone.
 */
export function stoppedRollouts(
  failed: DeploymentSummary[],
  rolledBack: DeploymentSummary[],
  now = Date.now(),
): StoppedRollout[] {
  const recent = (value: string | null | undefined) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isFinite(at) && now - at <= DAY;
  };
  const items: StoppedRollout[] = [];
  for (const d of failed) {
    if (d.status !== "failed" || d.rolled_back_by) continue;
    const at = d.failed_at || d.created_at;
    if (!recent(at)) continue;
    const current = d.target_count - (d.state_counts.removed || 0);
    if (current <= 0 || d.verified_count >= current) continue;
    const counts = Object.fromEntries(
      progressSegments(d.state_counts, { stopped: true }).map((segment) => [
        segment.key,
        segment.count,
      ]),
    );
    items.push({
      deployment: d,
      kind: "stopped",
      at,
      title:
        d.failure_reason === "incompatible"
          ? `${name(d)} stopped: a device became incompatible`
          : `${name(d)} stopped after ${counts.failed === 1 ? "a failure" : "failures"}`,
      detail:
        [
          counts.failed ? `${counts.failed} failed` : "",
          counts.queued ? `${counts.queued} not released` : "",
          d.verified_count ? `${d.verified_count} applied` : "",
        ]
          .filter(Boolean)
          .join(" · ") || plural(current, "device"),
    });
  }
  for (const d of rolledBack) {
    if (!d.rolled_back_by || !recent(d.rolled_back_at)) continue;
    items.push({
      deployment: d,
      kind: "rolled_back",
      at: d.rolled_back_at!,
      title: `${name(d)} was rolled back${d.rolled_back_to_version ? ` to v${d.rolled_back_to_version}` : ""}`,
      detail: "Fix the pipeline and publish a new version to try again.",
    });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
