import { useEffect, useRef, useState } from "react";
import { ArrowRight, GitBranch } from "lucide-react";
import {
  boundedAPI,
  type PipelineLibraryPage,
  type PipelineSummary,
  type User,
  type Version,
} from "./api";
import { Button, ErrorBox, Modal, SearchBox, Spinner, useResource } from "./ui";
import TargetDialog from "./TargetDialog";
import { since } from "./deploymentStatus";

type VersionItem = {
  id: string;
  number?: number;
  message?: string;
  created_at: string;
  author?: string;
};

/**
 * Starts a deployment from the Deployments page: choose a published pipeline
 * and version, then continue in the same device and release review used
 * everywhere else.
 */
export default function DeploymentPicker({
  user,
  scheduled,
  returnFocusRef,
  initialDeviceIds,
  deviceName,
  onClose,
  onDone,
}: {
  user: User;
  scheduled: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Preselected devices, when started from one device's page. */
  initialDeviceIds?: string[];
  /** Names the single preselected device in the picker's description. */
  deviceName?: string;
  onClose(): void;
  onDone(message: string): void;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [pipeline, setPipeline] = useState<PipelineSummary | null>(null),
    [versionId, setVersionId] = useState(""),
    [version, setVersion] = useState<Version | null>(null),
    [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    search: query,
    state: "active",
    sort: "updated",
    page: "1",
    page_size: "20",
  });
  const library = useResource<PipelineLibraryPage>(
    `/configurations/library?${params}`,
    { items: [], total: 0, page: 1, page_size: 20 },
  );
  const published = library.data.items.filter((item) => item.latest_version);
  const versions = useResource<{ items: VersionItem[]; total: number }>(
    pipeline
      ? `/configurations/${encodeURIComponent(pipeline.id)}/history?kind=versions&page=1&page_size=20`
      : null,
    { items: [], total: 0 },
  );
  function choose(item: PipelineSummary) {
    setPipeline(item);
    setVersionId(item.latest_version?.id || "");
    setError("");
  }
  async function next() {
    if (!versionId || opening) return;
    setOpening(true);
    setError("");
    try {
      const loaded = await boundedAPI<Version>(
        `/versions/${encodeURIComponent(versionId)}`,
      );
      if (!mounted.current) return;
      if (loaded.id !== versionId)
        throw Error(
          "The server returned a different version. Choose it again.",
        );
      setVersion(loaded);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setOpening(false);
    }
  }
  if (version)
    return (
      <TargetDialog
        key={user.id}
        userId={user.id}
        open
        version={version}
        pipelineName={pipeline?.name}
        initialStrategy={scheduled ? "scheduled" : undefined}
        initialDeviceIds={initialDeviceIds}
        onClose={onClose}
        onDone={onDone}
      />
    );
  const versionItems = versions.data.items.filter(
    (item) => typeof item.number === "number",
  );
  return (
    <Modal
      open
      onClose={() => {
        if (!opening) onClose();
      }}
      wide
      className="deployment-picker-modal"
      returnFocusRef={returnFocusRef}
      title={
        scheduled
          ? "Schedule a deployment"
          : deviceName
            ? `Deploy a pipeline to ${deviceName}`
            : "Deploy a pipeline"
      }
      description={
        deviceName
          ? `Choose a published pipeline and version. Next, review how it reaches ${deviceName}.`
          : "Choose a published pipeline and version. Next, pick devices and how to release it."
      }
    >
      <div className="modal-body deployment-picker">
        {(error || library.error) && (
          <ErrorBox message={error || library.error} retry={library.reload} />
        )}
        <SearchBox
          value={search}
          onChange={setSearch}
          maxLength={200}
          placeholder="Search pipelines"
        />
        <div
          className="deployment-picker-list"
          role="radiogroup"
          aria-label="Published pipelines"
          aria-busy={library.loading || undefined}
        >
          {library.loading && !library.data.items.length ? (
            <div className="loading" role="status">
              <Spinner />
              Loading pipelines
            </div>
          ) : published.length ? (
            published.map((item) => (
              <label
                key={item.id}
                className="deployment-picker-option"
                data-selected={pipeline?.id === item.id || undefined}
              >
                <input
                  type="radio"
                  name="deployment-picker-pipeline"
                  checked={pipeline?.id === item.id}
                  onChange={() => choose(item)}
                />
                <GitBranch size={16} aria-hidden="true" />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    Latest v{item.latest_version!.number} · published{" "}
                    {since(item.latest_version!.created_at)?.toLowerCase() ||
                      "recently"}
                    {" · "}
                    {item.component_counts.sources} in,{" "}
                    {item.component_counts.transforms} transforms,{" "}
                    {item.component_counts.sinks} out
                  </small>
                </span>
              </label>
            ))
          ) : (
            <p className="control-muted">
              {query
                ? "No published pipeline matches this search."
                : "No published pipelines yet. Publish a pipeline from the editor, then deploy it here."}{" "}
              {!query &&
                (initialDeviceIds?.length === 1 ? (
                  <a
                    href={`#/configurations?device=${encodeURIComponent(initialDeviceIds[0])}`}
                  >
                    Start from a template
                  </a>
                ) : (
                  <a href="#/configurations">Open pipelines</a>
                ))}
            </p>
          )}
          {library.data.items.length > published.length && (
            <p className="control-muted deployment-picker-hint">
              {library.data.items.length - published.length} draft{" "}
              {library.data.items.length - published.length === 1
                ? "pipeline isn't"
                : "pipelines aren't"}{" "}
              published yet and can't be deployed.
            </p>
          )}
        </div>
        {pipeline && (
          <label className="field deployment-picker-version">
            <span>Version</span>
            <select
              value={versionId}
              onChange={(event) => setVersionId(event.target.value)}
              disabled={versions.loading && !versionItems.length}
            >
              {!versionItems.some(
                (item) => item.id === pipeline.latest_version?.id,
              ) &&
                pipeline.latest_version && (
                  <option value={pipeline.latest_version.id}>
                    v{pipeline.latest_version.number} (latest)
                  </option>
                )}
              {versionItems.map((item, index) => (
                <option key={item.id} value={item.id}>
                  v{item.number}
                  {index === 0 ? " (latest)" : ""}
                  {item.message ? ` · ${item.message.slice(0, 60)}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="modal-footer">
        <Button variant="secondary" disabled={opening} onClick={onClose}>
          Cancel
        </Button>
        <Button
          busy={opening}
          disabled={!versionId || opening}
          onClick={() => void next()}
        >
          {deviceName ? "Continue" : "Choose devices"}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </Modal>
  );
}
