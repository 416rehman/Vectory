import { useState } from "react";
import { ago, when, type Device } from "./api";
import { ErrorBox, RefreshButton, SearchBox, Spinner, useResource } from "./ui";
import DocLink, { HelpLink } from "./DocLink";
import { DataTable, type TableColumn } from "./DataTable";

type ComponentMetric = {
  id: string;
  type?: string;
  events_per_second?: number | null;
  errors?: number | null;
  discarded_events?: number | null;
  buffer_bytes?: number | null;
};
export type TelemetrySample = {
  bucket?: number;
  sampled_at: string;
  events_per_second?: number | null;
  errors?: number | null;
  uptime_seconds?: number | null;
  memory_bytes?: number | null;
  cpu_seconds?: number | null;
  discarded_events?: number | null;
  buffer_bytes?: number | null;
  components?: ComponentMetric[];
};
const present = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const number = (value?: number | null) =>
  present(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "—";
const bytes = (value: number) =>
  value < 1024
    ? `${number(value)} B`
    : value < 1024 * 1024
      ? `${number(value / 1024)} KB`
      : `${number(value / (1024 * 1024))} MB`;
function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return seconds < 60
    ? `${Math.floor(seconds)}s`
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}
const bucket = (sample: TelemetrySample) =>
  sample.bucket ?? Math.floor(new Date(sample.sampled_at).getTime() / 60000);

export default function TelemetryPanel({ device }: { device: Device }) {
  const { data, loading, error, reload } = useResource<{
    device_id: string;
    samples: TelemetrySample[];
  }>(`/devices/${device.id}/telemetry`, { device_id: device.id, samples: [] });
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null),
    [search, setSearch] = useState("");
  const history = (data.device_id === device.id ? data.samples : [])
    .filter((sample) => Number.isFinite(bucket(sample)))
    .sort((a, b) => bucket(a) - bucket(b));
  const latest = [device.telemetry as TelemetrySample | undefined, ...history]
      .filter(
        (sample): sample is TelemetrySample =>
          !!sample && Number.isFinite(Date.parse(sample.sampled_at)),
      )
      .sort((a, b) => Date.parse(b.sampled_at) - Date.parse(a.sampled_at))[0],
    end = history.length ? bucket(history.at(-1)!) : 0,
    start = history.length ? Math.max(bucket(history[0]), end - 119) : 0;
  const byMinute = new Map(history.map((sample) => [bucket(sample), sample]));
  const samples: TelemetrySample[] = history.length
    ? Array.from(
        { length: Math.max(0, Math.min(120, end - start + 1)) },
        (_, index) =>
          byMinute.get(start + index) || {
            bucket: start + index,
            sampled_at: new Date((start + index) * 60000).toISOString(),
          },
      )
    : [];
  const hasThroughput = samples.some((sample) =>
      present(sample.events_per_second),
    ),
    peak = Math.max(
      1,
      ...samples.map((sample) => sample.events_per_second ?? 0),
    );
  const selectedIndex = Math.max(
      0,
      samples.findIndex((sample) => bucket(sample) === selectedBucket),
    ),
    selected =
      selectedBucket === null ? samples.at(-1) : samples[selectedIndex];
  const x = (index: number) =>
      samples.length <= 1 ? 400 : (index / (samples.length - 1)) * 800,
    y = (value: number) => 154 - (value / peak) * 132;
  let drawing = false;
  const line = samples
    .map((sample, index) => {
      if (!present(sample.events_per_second)) {
        drawing = false;
        return "";
      }
      const command = `${drawing ? "L" : "M"}${x(index)},${y(sample.events_per_second)}`;
      drawing = true;
      return command;
    })
    .join(" ");
  const summary = [
    {
      label: "Events / second",
      value: latest?.events_per_second,
      format: number,
    },
    { label: "Errors (total)", value: latest?.errors, format: number },
    {
      label: "Discarded (total)",
      value: latest?.discarded_events,
      format: number,
    },
    { label: "Buffered", value: latest?.buffer_bytes, format: bytes },
  ].filter((metric) => present(metric.value));
  const process = [
    { label: "Vector uptime", value: latest?.uptime_seconds, format: duration },
    { label: "Memory", value: latest?.memory_bytes, format: bytes },
    {
      label: "CPU time",
      value: latest?.cpu_seconds,
      format: (value: number) => `${number(value)}s`,
    },
  ].filter((metric) => present(metric.value));
  const components = latest?.components || [],
    filtered = components.filter((component) =>
      `${component.id} ${component.type || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  const columns: {
    key: "events_per_second" | "errors" | "discarded_events" | "buffer_bytes";
    title: string;
    format: (value: number) => string;
  }[] = [
    { key: "events_per_second", title: "Events / s", format: number },
    { key: "errors", title: "Errors", format: number },
    { key: "discarded_events", title: "Discarded", format: number },
    { key: "buffer_bytes", title: "Buffered", format: bytes },
  ];
  const visibleColumns = columns.filter((column) =>
    components.some((component) => present(component[column.key])),
  );
  const componentColumns: TableColumn<ComponentMetric>[] = [
    {
      id: "component",
      header: "Component",
      value: (component) => `${component.id} ${component.type || ""}`,
      sortValue: (component) => component.id,
      filter: { placeholder: "Name or type" },
      cell: (component) => (
        <>
          <strong>{component.id}</strong>
          {component.type && (
            <small className="fleet-cell-note">
              {component.type.replaceAll("_", " ")}
            </small>
          )}
        </>
      ),
    },
    ...visibleColumns.map((column): TableColumn<ComponentMetric> => ({
      id: column.key,
      header: column.title,
      value: (component) =>
        present(component[column.key]) ? component[column.key] : null,
      filter: { placeholder: "Filter reported value" },
      cell: (component) => (
        <span
          title={present(component[column.key]) ? undefined : "Not reported"}
        >
          {present(component[column.key])
            ? column.format(component[column.key]!)
            : "—"}
        </span>
      ),
    })),
  ];
  const sampleColumns: TableColumn<TelemetrySample>[] = [
    {
      id: "sampled_at",
      header: "Sample time",
      value: (sample) => sample.sampled_at,
      sortValue: (sample) => Date.parse(sample.sampled_at),
      filter: { placeholder: "Date or time (ISO)" },
      cell: (sample) => when(sample.sampled_at),
    },
    {
      id: "events_per_second",
      header: "Events / second",
      value: (sample) => sample.events_per_second,
      filter: { placeholder: "Filter reported value" },
      cell: (sample) => number(sample.events_per_second),
    },
    {
      id: "errors",
      header: "Errors (total)",
      value: (sample) => sample.errors,
      filter: { placeholder: "Filter reported value" },
      cell: (sample) => number(sample.errors),
    },
  ];
  const hasValues =
      summary.length > 0 ||
      process.length > 0 ||
      components.length > 0 ||
      hasThroughput,
    stale =
      latest && Date.now() - new Date(latest.sampled_at).getTime() > 180000;
  return (
    <section className="metrics-workspace">
      <div className="metrics-heading">
        <div>
          <div className="page-title-row">
            <h2>Operational metrics</h2>
            <HelpLink
              topic="telemetry"
              section="interpret-the-numbers"
              label="Help for operational metrics"
            />
          </div>
          {latest && (
            <p>
              {stale ? "Last available sample" : "Last sample"}{" "}
              {ago(latest.sampled_at).toLowerCase()}
              {stale ? ". These values may be out of date." : "."}
            </p>
          )}
        </div>
        <RefreshButton onClick={reload}>Refresh metrics</RefreshButton>
      </div>
      {error && <ErrorBox message={error} retry={reload} />}
      {loading && !hasValues ? (
        <div className="fleet-loading">
          <Spinner />
          Loading metrics
        </div>
      ) : !hasValues && !error ? (
        <div className="metrics-empty">
          <h3>No metrics reported yet</h3>
          <p>
            The agent needs an explicitly configured local metrics endpoint.
            Device connection and pipeline status are still available above.
          </p>
          <details>
            <summary>Telemetry setup</summary>
            <p>
              Add an <code>internal_metrics</code> source and a loopback{" "}
              <code>prometheus_exporter</code> sink to the pipeline. Configure
              the agent’s local <code>--metrics-url</code> and enable telemetry
              in its agent policy.
            </p>
            <DocLink topic="telemetry" section="enable-real-metrics">
              Set up metrics and understand missing samples
            </DocLink>
          </details>
        </div>
      ) : (
        <>
          {summary.length > 0 && (
            <dl className="metrics-summary">
              {summary.map((metric) => (
                <div key={metric.label}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.format(metric.value!)}</dd>
                </div>
              ))}
            </dl>
          )}
          {hasThroughput && (
            <div className="metrics-history">
              <div className="metrics-chart-heading">
                <h3>Source throughput</h3>
                <span>Events / second</span>
              </div>
              <div className="metrics-chart">
                <span className="metrics-chart-peak">{number(peak)}</span>
                <svg
                  viewBox="0 0 800 174"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="Source events per second over reported history. Gaps indicate missing samples."
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (
                      event.key === "ArrowLeft" ||
                      event.key === "ArrowRight"
                    ) {
                      event.preventDefault();
                      const index =
                        selectedBucket === null
                          ? samples.length - 1
                          : selectedIndex;
                      setSelectedBucket(
                        bucket(
                          samples[
                            Math.max(
                              0,
                              Math.min(
                                samples.length - 1,
                                index + (event.key === "ArrowRight" ? 1 : -1),
                              ),
                            )
                          ],
                        ),
                      );
                    }
                  }}
                  onMouseMove={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect(),
                      index = Math.max(
                        0,
                        Math.min(
                          samples.length - 1,
                          Math.round(
                            ((event.clientX - bounds.left) / bounds.width) *
                              (samples.length - 1),
                          ),
                        ),
                      );
                    setSelectedBucket(bucket(samples[index]));
                  }}
                >
                  <line
                    x1="0"
                    y1="154"
                    x2="800"
                    y2="154"
                    className="metrics-baseline"
                  />
                  <path d={line} className="metrics-series" />
                  {samples.length > 1 &&
                    samples.map((sample, index) =>
                      present(sample.events_per_second) &&
                      !present(samples[index - 1]?.events_per_second) &&
                      !present(samples[index + 1]?.events_per_second) ? (
                        <line
                          key={bucket(sample)}
                          x1={Math.max(0, x(index) - 3)}
                          x2={Math.min(800, x(index) + 3)}
                          y1={y(sample.events_per_second)}
                          y2={y(sample.events_per_second)}
                          className="metrics-series"
                        />
                      ) : null,
                    )}
                  {samples.length === 1 &&
                    present(samples[0].events_per_second) && (
                      <line
                        x1="390"
                        x2="410"
                        y1={y(samples[0].events_per_second)}
                        y2={y(samples[0].events_per_second)}
                        className="metrics-series"
                      />
                    )}
                  {selectedBucket !== null && (
                    <line
                      x1={x(selectedIndex)}
                      x2={x(selectedIndex)}
                      y1="10"
                      y2="154"
                      className="metrics-cursor"
                    />
                  )}
                </svg>
              </div>
              <div className="metrics-chart-axis">
                <time>{when(samples[0]?.sampled_at)}</time>
                <time>{when(samples.at(-1)?.sampled_at)}</time>
              </div>
              <p className="metrics-chart-readout" aria-live="polite">
                {selected
                  ? `${when(selected.sampled_at)} — ${present(selected.events_per_second) ? `${number(selected.events_per_second)} events / second` : "No sample reported"}`
                  : ""}
              </p>
              <p className="metrics-note">
                Move over the chart or use arrow keys to inspect samples. Gaps
                mean no report.
              </p>
            </div>
          )}
          {!hasThroughput && summary.length > 0 && (
            <p className="metrics-note">
              Throughput history will appear when the agent reports successive
              source counters.
            </p>
          )}
          {process.length > 0 && (
            <dl className="metrics-process">
              {process.map((metric) => (
                <div key={metric.label}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.format(metric.value!)}</dd>
                </div>
              ))}
            </dl>
          )}
          {components.length > 0 && (
            <div className="metrics-components">
              <div className="metrics-chart-heading">
                <h3>Components</h3>
                <span>{components.length} reporting</span>
              </div>
              {components.length > 8 && (
                <SearchBox
                  value={search}
                  onChange={setSearch}
                  placeholder="Find a component"
                />
              )}
              <DataTable
                data={filtered}
                columns={componentColumns}
                rowKey={(component) => component.id}
                label="Component metrics"
                className="fleet-table"
                empty="No matching components."
              />
              <p className="metrics-note">
                Errors and discarded events are cumulative counters. A dash
                means the component did not report that value.
              </p>
            </div>
          )}
          {samples.length > 0 && (
            <details className="metrics-history-details">
              <summary>View sample history</summary>
              <DataTable
                data={samples}
                columns={sampleColumns}
                rowKey={(sample) => String(bucket(sample))}
                label="Metric sample history"
                className="fleet-table"
                scrollClassName="metrics-history-table"
                defaultSort={{ column: "sampled_at", direction: "desc" }}
                empty="No matching samples."
              />
            </details>
          )}
        </>
      )}
    </section>
  );
}
