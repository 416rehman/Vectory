import type { PipelineSummary } from "./api";
import { countLabel } from "./countLabel";
import { relativeTime } from "./time";

export type LibraryStatus = {
  primary: string;
  detail?: string;
  changed: boolean;
  title?: string;
};

const published = (at: string) =>
  `Published ${relativeTime(at, Date.now(), "at an unknown time")}`;

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
 * published. Assignment is not evidence that Vector runs there.
 */
export function libraryStatus(pipeline: PipelineSummary): LibraryStatus {
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
    changed: version.draft_changed === true,
    title: `Version ${version.number} published ${new Date(version.created_at).toLocaleString()}${version.author ? ` by ${version.author}` : ""}`,
  };
}

export default function PipelineStatus({
  pipeline,
}: {
  pipeline: PipelineSummary;
}) {
  const status = libraryStatus(pipeline);
  return (
    <div className="pipeline-status" title={status.title}>
      <span className="pipeline-status-main">
        {status.primary}
        {status.changed && (
          <span className="pipeline-status-chip">Unpublished changes</span>
        )}
      </span>
      {status.detail && <small>{status.detail}</small>}
    </div>
  );
}
