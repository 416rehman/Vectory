import { ago, type PipelineSummary } from "./api";

export type LibraryStatus = {
  primary: string;
  detail?: string;
  changed: boolean;
  title?: string;
};

const published = (at: string) => {
  const relative = ago(at);
  return relative === "Just now"
    ? "Published just now"
    : `Published ${relative}`;
};

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
  const devices = pipeline.assigned_devices;
  return {
    primary: `v${version.number} · ${published(version.created_at)}`,
    detail:
      devices === undefined
        ? undefined
        : devices === 0
          ? "Not assigned to devices"
          : `Assigned to ${devices} ${devices === 1 ? "device" : "devices"}`,
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
