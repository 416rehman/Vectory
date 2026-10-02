import { useMemo } from "react";
import type { DeploymentPage, PipelineSummary } from "./api";
import { countLabel } from "./countLabel";
import {
  outcomeText,
  rolloutOutcome,
  type RolloutOutcome,
} from "./rolloutOutcome";
import { exactLocal, relativeTime } from "./time";
import { useResource } from "./ui";

export type LibraryStatus = {
  primary: string;
  detail?: string;
  /** How the newest rollout of this version ended, while no device runs it. */
  outcome?: { text: string; at: string; deploymentId: string };
  changed: boolean;
  title?: string;
};

const published = (at: string) =>
  `Published ${relativeTime(at, Date.now(), "at an unknown time")}`;

const runsVersion = (pipeline: PipelineSummary, number: number) =>
  (pipeline.running_versions ?? []).some(
    (entry) => entry.devices > 0 && entry.number === number,
  );

/** A published version no device runs is the one a failed rollout would explain. */
const unexplained = (pipeline: PipelineSummary) =>
  !pipeline.archived &&
  !!pipeline.latest_version &&
  !runsVersion(pipeline, pipeline.latest_version.number);

/**
 * Where the pipeline runs: the versions devices last verified, against how
 * many are assigned. A newer version that no device runs yet is named, so a
 * rolled-back release never reads as live.
 */
function reachDetail(pipeline: PipelineSummary, latest: number) {
  const assigned = pipeline.assigned_devices;
  const running = (pipeline.running_versions ?? []).filter(
    (entry) => entry.devices > 0,
  );
  if (!pipeline.running_versions)
    return assigned === undefined
      ? undefined
      : assigned === 0
        ? "Not assigned to devices"
        : `Assigned to ${countLabel(assigned, "device")}`;
  if (!running.length)
    return !assigned
      ? "Not assigned to devices"
      : `Assigned to ${countLabel(assigned, "device")} · not verified running yet`;
  const total = running.reduce((sum, entry) => sum + entry.devices, 0);
  const versions =
    running.length === 1
      ? `Running v${running[0].number} on ${
          assigned !== undefined && assigned >= total
            ? `${running[0].devices} of ${assigned}`
            : countLabel(total, "device")
        }`
      : `Running ${running
          .map((entry) => `v${entry.number} on ${entry.devices}`)
          .join(
            ", ",
          )}${assigned !== undefined && assigned >= total ? ` of ${assigned}` : ""}`;
  return running.some((entry) => entry.number === latest)
    ? versions
    : `${versions} · v${latest} not running`;
}

/**
 * What the library says about a pipeline: its published state first, then
 * where it is assigned, and whether the draft has changes that are not
 * published. Assignment is not evidence that Vector runs there. When no device
 * runs the latest version, `outcome` says how its newest rollout ended.
 */
export function libraryStatus(
  pipeline: PipelineSummary,
  outcome?: RolloutOutcome | null,
): LibraryStatus {
  const version = pipeline.latest_version;
  if (pipeline.archived)
    return {
      primary: version ? `Archived · v${version.number}` : "Archived",
      changed: false,
    };
  if (!version)
    return { primary: "Not published", detail: "Draft only", changed: false };
  return {
    primary: `v${version.number} · ${published(version.created_at)}`,
    detail: reachDetail(pipeline, version.number),
    outcome:
      outcome && unexplained(pipeline)
        ? {
            text: outcomeText(outcome, version.number),
            at: outcome.at,
            deploymentId: outcome.deploymentId,
          }
        : undefined,
    changed: version.draft_changed === true,
    title: `Version ${version.number} published ${new Date(version.created_at).toLocaleString()}${version.author ? ` by ${version.author}` : ""}`,
  };
}

// The newest rollouts of each kind: enough for the versions a page of rows
// publishes, and a bounded read however long the history grows.
const WINDOW = 20;
const noRollouts: DeploymentPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: WINDOW,
};

/**
 * Reads the newest failed and rolled-back rollouts once for the page, only
 * while a row's latest version runs nowhere, and returns each row's outcome.
 * A read that fails leaves the rows saying what the library already knows.
 */
export function useLibraryOutcomes(pipelines: PipelineSummary[]) {
  const needed = pipelines.some(unexplained);
  const read = (status: string) =>
    needed
      ? `/deployments/history?status=${status}&page=1&page_size=${WINDOW}`
      : null;
  const failed = useResource<DeploymentPage>(read("failed"), noRollouts, 0, {
    interval: 60_000,
  });
  const rolledBack = useResource<DeploymentPage>(
    read("rolled_back"),
    noRollouts,
    0,
    { interval: 60_000 },
  );
  const rollouts = useMemo(
    () => [...failed.data.items, ...rolledBack.data.items],
    [failed.data.items, rolledBack.data.items],
  );
  return (pipeline: PipelineSummary) =>
    pipeline.latest_version
      ? rolloutOutcome(rollouts, pipeline.id, pipeline.latest_version.number)
      : null;
}

/** "v4 failed on 1 device · 12m ago", linking to the rollout. */
export function OutcomeLine({
  outcome,
}: {
  outcome: NonNullable<LibraryStatus["outcome"]>;
}) {
  return (
    <span className="pipeline-status-outcome" title={exactLocal(outcome.at)}>
      <a href={`#/deployments/${encodeURIComponent(outcome.deploymentId)}`}>
        {outcome.text}
      </a>
      {" · "}
      {relativeTime(outcome.at)}
    </span>
  );
}

export default function PipelineStatus({
  pipeline,
  outcome,
}: {
  pipeline: PipelineSummary;
  outcome?: RolloutOutcome | null;
}) {
  const status = libraryStatus(pipeline, outcome);
  return (
    <div className="pipeline-status" title={status.title}>
      <span className="pipeline-status-main">
        {status.primary}
        {status.changed && (
          <span className="pipeline-status-chip">Unpublished changes</span>
        )}
      </span>
      {status.detail && <small>{status.detail}</small>}
      {status.outcome && (
        <small>
          <OutcomeLine outcome={status.outcome} />
        </small>
      )}
    </div>
  );
}
