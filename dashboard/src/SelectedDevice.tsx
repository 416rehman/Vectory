import type { Device } from "./api";
import { Button, Spinner, useResource } from "./ui";
import type { PipelineDestination } from "./pipelineDestination";

export function pipelineRoute(
  id?: string,
  device?: string,
  destination?: PipelineDestination,
) {
  const query = new URLSearchParams();
  if (device) query.set("device", device);
  if (destination) {
    query.set("panel", destination.panel);
    if (destination.section) query.set("section", destination.section);
  }
  return `configurations${id ? `/${encodeURIComponent(id)}` : ""}${query.size ? `?${query}` : ""}`;
}

export default function SelectedDevice({
  id,
  onClear,
}: {
  id: string;
  onClear(): void;
}) {
  const {
    data: device,
    error,
    reload,
  } = useResource<Device | null>(`/devices/${encodeURIComponent(id)}`, null);
  return (
    <aside
      className="pipeline-device-context"
      aria-label="Selected deployment device"
    >
      <div>
        {error ? (
          <>
            <strong>Selected device unavailable</strong>
            <p>{error}</p>
          </>
        ) : device ? (
          <>
            <strong>Choosing a pipeline for {device.name}</strong>
            <p>Review a published version and its targets before deploying.</p>
          </>
        ) : (
          <span>
            <Spinner /> Loading selected device
          </span>
        )}
      </div>
      <div className="pipeline-device-actions">
        {error && (
          <Button variant="secondary compact" onClick={reload}>
            Try again
          </Button>
        )}
        <Button variant="ghost compact" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </aside>
  );
}
