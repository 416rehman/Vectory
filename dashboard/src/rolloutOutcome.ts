import type { DeploymentSummary } from "./api";
import { countLabel } from "./countLabel";

/** How the newest rollout of a pipeline version ended badly. */
export type RolloutOutcome = {
  kind: "rolled_back" | "failed";
  deploymentId: string;
  /** When it stopped or was rolled back. */
  at: string;
  /** Devices the version reached; null when none still count to this rollout. */
  devices: number | null;
};

const endedAt = (d: DeploymentSummary) =>
  d.rolled_back_by
    ? d.rolled_back_at || d.created_at
    : d.failed_at || d.created_at;

/**
 * The newest rollout of this pipeline version that was rolled back or stopped
 * after failures, among the rollouts given. It says nothing about a rollout
 * that went well, or one that fell outside those reads. `devices` counts the
 * rollout's targets that were released and are still its own: a target moved
 * to another rollout, or never released, is not one the version reached.
 */
export function rolloutOutcome(
  rollouts: DeploymentSummary[],
  pipelineId: string,
  versionNumber: number,
): RolloutOutcome | null {
  let best: DeploymentSummary | null = null;
  for (const d of rollouts) {
    if (d.policy || d.configuration_id !== pipelineId) continue;
    if (d.version_number !== versionNumber) continue;
    if (!d.rolled_back_by && d.status !== "failed") continue;
    if (!best || Date.parse(endedAt(d)) > Date.parse(endedAt(best))) best = d;
  }
  if (!best) return null;
  const counts = best.state_counts || {};
  const reached =
    (best.target_count ?? 0) - (counts.removed || 0) - (counts.pending || 0);
  return {
    kind: best.rolled_back_by ? "rolled_back" : "failed",
    deploymentId: best.id,
    at: endedAt(best),
    devices: reached > 0 ? reached : null,
  };
}

/** "v2 rolled back on 1 device": what happened to the version, in words. */
export function outcomeText(outcome: RolloutOutcome, versionNumber: number) {
  const what = outcome.kind === "rolled_back" ? "rolled back" : "failed";
  return outcome.devices
    ? `v${versionNumber} ${what} on ${countLabel(outcome.devices, "device")}`
    : `v${versionNumber} ${what}`;
}
