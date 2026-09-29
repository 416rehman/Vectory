import { useEffect, useState, type KeyboardEvent } from "react";
import { Check, X } from "lucide-react";
import { when, type Device } from "./api";
import { relativeTime } from "./time";
import {
  ErrorBox,
  RefreshButton,
  SegmentedControl,
  Spinner,
  useResource,
} from "./ui";
import DocLink, { HelpLink } from "./DocLink";
import { DataTable, type TableColumn } from "./DataTable";
import VectorLogSummaryView from "./VectorLogSummary";
import type {
  ComponentTelemetry,
  TelemetryHistory,
  TelemetryRange,
  TelemetrySample,
} from "./runtimeModel";
import {
  axisTime,
  bridgeSlots,
  bridgedSlots,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  isolatedPoints,
  niceMax,
  present,
  readableSlot,
  seriesPath,
  timeline,
  type TimelinePoint,
} from "./telemetryChart";
import "./telemetry-panel.css";

export type { TelemetrySample } from "./runtimeModel";

const ranges: { value: TelemetryRange; label: string; minutes: number }[] = [
  { value: "15m", label: "15 min", minutes: 15 },
  { value: "1h", label: "1 hour", minutes: 60 },
  { value: "6h", label: "6 hours", minutes: 360 },
  { value: "24h", label: "24 hours", minutes: 1440 },
  { value: "7d", label: "7 days", minutes: 10080 },
];

type Series = {
  key: keyof TelemetrySample;
  label: string;
  tone: "in" | "out" | "critical" | "muted";
};
type Chart = {
  id: string;
  title: string;
  unit: string;
  series: Series[];
  format: (value: number) => string;
  /** Fixed axis maximum (ratios), else a clean maximum from the data. */
  max?: number;
};
const charts: Chart[] = [
  {
    id: "throughput",
    title: "Throughput",
    unit: "events / second",
    format: formatNumber,
    series: [
      { key: "events_per_second", label: "In (sources)", tone: "in" },
      { key: "events_out_per_second", label: "Out (sinks)", tone: "out" },
    ],
  },
  {
    id: "errors",
    title: "Errors",
    unit: "per minute",
    format: formatNumber,
    series: [{ key: "errors_per_minute", label: "Errors", tone: "critical" }],
  },
  {
    id: "discarded",
    title: "Discarded events",
    unit: "per minute",
    format: formatNumber,
    series: [
      {
        key: "dropped_per_minute",
        label: "Dropped due to errors",
        tone: "critical",
      },
      {
        key: "filtered_per_minute",
        label: "Filtered out (expected)",
        tone: "muted",
      },
    ],
  },
  {
    id: "buffer",
    title: "Buffer fill",
    unit: "fullest buffer",
    format: formatPercent,
    max: 1,
    series: [{ key: "buffer_utilization", label: "Buffer fill", tone: "in" }],
  },
];

const value = (
  sample: TelemetrySample | undefined,
  key: keyof TelemetrySample,
) => (sample && present(sample[key]) ? (sample[key] as number) : undefined);

/** Operational metrics for one device. W6 renders it on the device page. */
export default function TelemetryPanel({
  device,
  logs = true,
}: {
  device: Device;
  /** Show the device's recent Vector warnings and errors below the metrics. */
  logs?: boolean;
}) {
  const [range, setRange] = useState<TelemetryRange>("1h"),
    [hover, setHover] = useState<number | null>(null);
  const resource = useResource<TelemetryHistory>(
    `/devices/${encodeURIComponent(device.id)}/telemetry?range=${range}`,
    { device_id: device.id, samples: [] },
  );
  // Keep the previous render while a new range loads: no flash, no jump.
  const [shown, setShown] = useState<TelemetryHistory | null>(null);
  const settled = !resource.loading && !resource.error;
  useEffect(() => {
    if (settled && resource.data.device_id === device.id)
      setShown(resource.data);
  }, [settled, resource.data, device.id]);
  useEffect(() => setHover(null), [range, device.id]);
  const history =
    shown && shown.device_id === device.id
      ? shown
      : { device_id: device.id, samples: [] };
  const points = timeline(history);
  const heartbeat = device.effective_policy?.heartbeat_seconds ?? 60;
  const freshSeconds = Math.max(180, heartbeat * 3);
  const candidates = [
    device.telemetry ?? undefined,
    ...[...history.samples].reverse(),
  ].filter(
    (sample): sample is TelemetrySample =>
      !!sample && Number.isFinite(Date.parse(sample.sampled_at)),
  );
  const latest = candidates.sort(
    (a, b) => Date.parse(b.sampled_at) - Date.parse(a.sampled_at),
  )[0];
  const stale =
    !!latest &&
    Date.now() - Date.parse(latest.sampled_at) > freshSeconds * 1000;
  const components = device.telemetry?.components ?? [];
  const visibleCharts = charts.filter((chart) =>
    points.some((point) =>
      chart.series.some((series) => present(value(point.sample, series.key))),
    ),
  );
  const hasValues =
    !!latest || visibleCharts.length > 0 || components.length > 0;
  const span = ranges.find((option) => option.value === range)!.minutes;
  // Lines cross empty slots shorter than one check-in: not a missed report.
  const bridge = bridgeSlots(heartbeat, history.step_seconds ?? 60);
  const runtime = device.host_runtime;
  const disabled = device.effective_policy?.telemetry_enabled === false;
  return (
    <section className="metrics-workspace telemetry-panel">
      <div className="telemetry-heading">
        <div>
          <div className="page-title-row">
            <h2>Operational metrics</h2>
            <HelpLink
              topic="telemetry"
              section="interpret-the-numbers"
              label="Help for operational metrics"
            />
          </div>
          {(latest ||
            runtime?.metrics_source === "discovered" ||
            runtime?.metrics_source === "explicit") && (
            <p>
              {latest ? (
                <>
                  {stale ? "Last available sample" : "Last sample"}{" "}
                  {relativeTime(latest.sampled_at)}
                  {stale ? ". These values may be out of date." : "."}{" "}
                </>
              ) : null}
              <MetricsSource device={device} />
            </p>
          )}
        </div>
        <div className="telemetry-controls">
          <SegmentedControl
            label="Time range"
            options={ranges}
            value={range}
            onChange={setRange}
          />
          <RefreshButton onClick={resource.reload} busy={resource.loading}>
            Refresh
          </RefreshButton>
        </div>
      </div>
      {resource.error && (
        <ErrorBox message={resource.error} retry={resource.reload} />
      )}
      {disabled && (
        <p className="telemetry-notice" role="status">
          Metrics collection is turned off in this device's agent settings.
          Values below were reported before it was turned off.
        </p>
      )}
      {!hasValues && resource.loading && !shown ? (
        <div className="fleet-loading">
          <Spinner />
          Loading metrics
        </div>
      ) : !hasValues ? (
        <MetricsDiagnosis device={device} />
      ) : (
        <div
          className={`telemetry-body${resource.loading ? " refreshing" : ""}`}
          aria-busy={resource.loading || undefined}
        >
          {latest && <StatTiles sample={latest} />}
          {visibleCharts.length > 0 ? (
            <div className="telemetry-charts">
              {visibleCharts.map((chart) => (
                <MetricChart
                  key={chart.id}
                  chart={chart}
                  points={points}
                  span={span}
                  bridge={bridge}
                  hover={hover}
                  onHover={setHover}
                />
              ))}
            </div>
          ) : (
            <p className="telemetry-note">
              No history in this range yet. Charts appear once the agent has
              reported successive samples.
            </p>
          )}
          {visibleCharts.length > 0 && (
            <p className="telemetry-note">
              A gap means the device sent no metrics for longer than one
              check-in. Move over a chart or focus it and use the arrow keys to
              read values.
            </p>
          )}
          <ProcessStats sample={latest} runtime={runtime} />
          {components.length > 0 && <ComponentTable components={components} />}
          {points.some((point) => point.sample) && (
            <SampleTable points={points} />
          )}
        </div>
      )}
      {logs && (
        <div className="telemetry-logs">
          <VectorLogSummaryView summary={device.vector_log_summary} />
        </div>
      )}
    </section>
  );
}

function MetricsSource({ device }: { device: Device }) {
  const runtime = device.host_runtime;
  if (!runtime?.metrics_source || runtime.metrics_source === "none")
    return null;
  return runtime.metrics_source === "discovered" ? (
    <>
      Read from <code>{runtime.metrics_address}</code>, the Prometheus exporter
      in the running pipeline.
    </>
  ) : (
    <>
      Read from the metrics URL configured on the device
      {runtime.metrics_address ? (
        <>
          {" "}
          (<code>{runtime.metrics_address}</code>)
        </>
      ) : null}
      .
    </>
  );
}

const exporterFragment = `"sources": {
  "vectory_internal_metrics": { "type": "internal_metrics" }
},
"sinks": {
  "vectory_metrics_exporter": {
    "type": "prometheus_exporter",
    "inputs": ["vectory_internal_metrics"],
    "address": "127.0.0.1:9598"
  }
}`;

/** Why a device reports no metrics, one check per line, with the fix. */
export function MetricsDiagnosis({ device }: { device: Device }) {
  const runtime = device.host_runtime;
  const allowed = device.effective_policy?.telemetry_enabled !== false;
  const source = runtime?.metrics_source;
  const heartbeat = device.effective_policy?.heartbeat_seconds ?? 60;
  const checks: { ok: boolean | null; label: string; detail: string }[] = [
    {
      ok: allowed,
      label: allowed
        ? "Metrics collection is allowed by the agent settings"
        : "Metrics collection is turned off in the agent settings",
      detail: allowed
        ? ""
        : "Turn on metrics in an agent settings deployment for this device.",
    },
  ];
  if (!runtime)
    checks.push({
      ok: null,
      label:
        "This agent version reads metrics only from a URL configured on the host",
      detail:
        "Update the agent so it finds the pipeline's exporter automatically, or run vectory configure-metrics on the device.",
    });
  else if (source === "none")
    checks.push({
      ok: false,
      label: "The running pipeline has no loopback Prometheus exporter",
      detail:
        "Add an internal_metrics source connected to a prometheus_exporter sink on a loopback address, then deploy it. The agent finds it automatically; nothing needs to change on the host.",
    });
  else
    checks.push({
      ok: true,
      label:
        source === "discovered"
          ? `Found the exporter at ${runtime.metrics_address} in the running pipeline`
          : "A metrics URL is configured on the device",
      detail: "",
    });
  const waiting = allowed && !!runtime && source !== "none";
  return (
    <div className="telemetry-empty">
      <h3>
        {waiting ? "Waiting for the first sample" : "No metrics reported"}
      </h3>
      <ul className="telemetry-checks">
        {checks.map((check) => (
          <li key={check.label}>
            {check.ok === null ? (
              <span className="telemetry-check-mark unknown" aria-hidden="true">
                –
              </span>
            ) : check.ok ? (
              <Check
                className="telemetry-check-mark ok"
                size={16}
                aria-hidden="true"
              />
            ) : (
              <X
                className="telemetry-check-mark missing"
                size={16}
                aria-hidden="true"
              />
            )}
            <div>
              <p>
                <span className="sr-only">
                  {check.ok === null
                    ? "Unknown: "
                    : check.ok
                      ? "Done: "
                      : "Missing: "}
                </span>
                {check.label}
              </p>
              {check.detail && (
                <p className="telemetry-check-detail">{check.detail}</p>
              )}
            </div>
          </li>
        ))}
        {waiting && (
          <li>
            <span className="telemetry-check-mark unknown" aria-hidden="true">
              –
            </span>
            <p>
              A sample arrives with each check-in (every {heartbeat} seconds).
              Connection and pipeline status are still available above.
            </p>
          </li>
        )}
      </ul>
      <details className="telemetry-fragment">
        <summary>Pipeline fragment for metrics</summary>
        <pre>
          <code>{exporterFragment}</code>
        </pre>
        <DocLink topic="telemetry" section="enable-real-metrics">
          Set up metrics and understand missing samples
        </DocLink>
      </details>
    </div>
  );
}

function StatTiles({ sample }: { sample: TelemetrySample }) {
  const tiles = [
    {
      label: "Events in",
      unit: "/ s",
      value: sample.events_per_second,
      format: formatNumber,
    },
    {
      label: "Events out",
      unit: "/ s",
      value: sample.events_out_per_second,
      format: formatNumber,
    },
    {
      label: "Errors",
      unit: "/ min",
      value: sample.errors_per_minute,
      format: formatNumber,
      note: present(sample.errors)
        ? `${formatNumber(sample.errors)} since Vector started`
        : undefined,
    },
    {
      label: "Dropped due to errors",
      unit: "/ min",
      value: sample.dropped_per_minute,
      format: formatNumber,
      note: present(sample.discarded_error)
        ? `${formatNumber(sample.discarded_error)} since Vector started`
        : undefined,
    },
    {
      label: "Filtered out (expected)",
      unit: "/ min",
      value: sample.filtered_per_minute,
      format: formatNumber,
      note: present(sample.discarded_intentional)
        ? `${formatNumber(sample.discarded_intentional)} since Vector started`
        : undefined,
    },
    {
      label: "Buffer fill",
      unit: "",
      value: sample.buffer_utilization,
      format: formatPercent,
      note: present(sample.buffer_bytes)
        ? `${formatBytes(sample.buffer_bytes)} buffered`
        : undefined,
    },
  ];
  // Older agents report only cumulative totals; show them rather than nothing.
  const legacy = [
    { label: "Errors (total)", value: sample.errors, format: formatNumber },
    {
      label: "Discarded (total)",
      value: sample.discarded_events,
      format: formatNumber,
    },
    { label: "Buffered", value: sample.buffer_bytes, format: formatBytes },
  ];
  const shown = tiles.filter((tile) => present(tile.value));
  const fallback = shown.length
    ? []
    : legacy.filter((tile) => present(tile.value));
  if (!shown.length && !fallback.length) return null;
  return (
    <dl className="telemetry-tiles">
      {shown.map((tile) => (
        <div key={tile.label}>
          <dt>{tile.label}</dt>
          <dd>
            {tile.format(tile.value!)}
            {tile.unit && <small> {tile.unit}</small>}
          </dd>
          {tile.note && <dd className="telemetry-tile-note">{tile.note}</dd>}
        </div>
      ))}
      {fallback.map((tile) => (
        <div key={tile.label}>
          <dt>{tile.label}</dt>
          <dd>{tile.format(tile.value!)}</dd>
        </div>
      ))}
    </dl>
  );
}

const chartWidth = 800,
  chartHeight = 120;

function MetricChart({
  chart,
  points,
  span,
  bridge,
  hover,
  onHover,
}: {
  chart: Chart;
  points: TimelinePoint[];
  span: number;
  /** Empty slots a line may cross (see bridgeSlots). */
  bridge: number;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const series = chart.series.filter((item) =>
    points.some((point) => present(value(point.sample, item.key))),
  );
  const reported = points.map((point) =>
    series.some((item) => present(value(point.sample, item.key))),
  );
  const bridged = bridgedSlots(reported, bridge);
  const peak = Math.max(
    0,
    ...points.flatMap((point) =>
      series.map((item) => value(point.sample, item.key) ?? 0),
    ),
  );
  const max = chart.max ?? niceMax(peak);
  const x = (index: number) =>
    points.length <= 1
      ? chartWidth / 2
      : (index / (points.length - 1)) * chartWidth;
  const y = (reading: number) =>
    chartHeight - Math.min(1, reading / max) * (chartHeight - 4);
  const selected =
    hover !== null && hover < points.length
      ? readableSlot(hover, reported, bridged)
      : null;
  const readoutIndex = selected ?? lastReported(points, series);
  const readoutPoint = readoutIndex === null ? undefined : points[readoutIndex];
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const last = points.length - 1;
    const current = selected ?? readoutIndex ?? last;
    const step =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
    const next = step
      ? current + step
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : null;
    if (next === null) return;
    event.preventDefault();
    const slot = Math.max(0, Math.min(last, next));
    onHover(step ? readableSlot(slot, reported, bridged, step) : slot);
  }
  const label = `${chart.title}, ${chart.unit}, ${series.map((item) => item.label).join(" and ")}. Gaps mean no report.`;
  return (
    <figure className="telemetry-chart">
      <figcaption>
        <span className="telemetry-chart-title">{chart.title}</span>
        <span className="telemetry-chart-unit">{chart.unit}</span>
      </figcaption>
      {series.length > 1 && (
        <ul className="telemetry-legend">
          {series.map((item) => (
            <li key={String(item.key)}>
              <span
                className={`telemetry-key ${item.tone}`}
                aria-hidden="true"
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <p className="telemetry-readout" aria-live="polite">
        {readoutPoint ? (
          <>
            <time dateTime={readoutPoint.at}>{when(readoutPoint.at)}</time>
            {series.map((item) => {
              const reading = value(readoutPoint.sample, item.key);
              return (
                <span key={String(item.key)}>
                  {series.length > 1 && (
                    <span
                      className={`telemetry-key ${item.tone}`}
                      aria-hidden="true"
                    />
                  )}
                  <strong>
                    {present(reading) ? chart.format(reading) : "No report"}
                  </strong>
                  {series.length > 1 && <> {item.label.toLowerCase()}</>}
                </span>
              );
            })}
          </>
        ) : (
          "No report in this range"
        )}
      </p>
      <div
        className="telemetry-plot"
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={move}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio =
            (event.clientX - bounds.left) / Math.max(1, bounds.width);
          onHover(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.round(ratio * (points.length - 1)),
              ),
            ),
          );
        }}
        onPointerLeave={() => onHover(null)}
        onBlur={() => onHover(null)}
      >
        <span className="telemetry-tick top">{chart.format(max)}</span>
        <span className="telemetry-tick middle">{chart.format(max / 2)}</span>
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1="0"
            x2={chartWidth}
            y1={y(max)}
            y2={y(max)}
            className="telemetry-grid"
          />
          <line
            x1="0"
            x2={chartWidth}
            y1={y(max / 2)}
            y2={y(max / 2)}
            className="telemetry-grid"
          />
          <line
            x1="0"
            x2={chartWidth}
            y1={chartHeight}
            y2={chartHeight}
            className="telemetry-baseline"
          />
          {series.map((item) => {
            const values = points.map((point) => value(point.sample, item.key));
            return (
              <g
                key={String(item.key)}
                className={`telemetry-series ${item.tone}`}
              >
                <path d={seriesPath(values, x, y, bridge)} />
                {isolatedPoints(values, bridge).map((index) => (
                  <line
                    key={index}
                    x1={Math.max(0, x(index) - 4)}
                    x2={Math.min(chartWidth, x(index) + 4)}
                    y1={y(values[index]!)}
                    y2={y(values[index]!)}
                  />
                ))}
              </g>
            );
          })}
          {selected !== null && (
            <line
              x1={x(selected)}
              x2={x(selected)}
              y1="0"
              y2={chartHeight}
              className="telemetry-cursor"
            />
          )}
        </svg>
      </div>
      <div className="telemetry-axis" aria-hidden="true">
        <span>{points[0] ? axisTime(points[0].at, span) : ""}</span>
        <span>{points.length ? axisTime(points.at(-1)!.at, span) : ""}</span>
      </div>
    </figure>
  );
}

function lastReported(points: TimelinePoint[], series: Series[]) {
  for (let index = points.length - 1; index >= 0; index--)
    if (series.some((item) => present(value(points[index].sample, item.key))))
      return index;
  return null;
}

function ProcessStats({
  sample,
  runtime,
}: {
  sample?: TelemetrySample;
  runtime?: Device["host_runtime"];
}) {
  const stats = [
    {
      label: "Vector uptime",
      value: sample?.uptime_seconds,
      format: formatDuration,
    },
    { label: "Memory", value: sample?.memory_bytes, format: formatBytes },
    {
      label: "CPU time",
      value: sample?.cpu_seconds,
      format: (seconds: number) => `${formatNumber(seconds)}s`,
    },
  ].filter((stat) => present(stat.value));
  const data = runtime?.data_dir;
  if (!stats.length && !data) return null;
  return (
    <dl className="telemetry-process">
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt>{stat.label}</dt>
          <dd>{stat.format(stat.value!)}</dd>
        </div>
      ))}
      {data && (
        <div>
          <dt>Data directory</dt>
          <dd>
            <code>{data}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

type ComponentColumn = {
  id: string;
  title: string;
  read: (component: ComponentTelemetry) => number | null | undefined;
  format: (value: number) => string;
};
const componentColumns: ComponentColumn[] = [
  {
    id: "received",
    title: "In / s",
    read: (component) => component.received_events_per_second,
    format: formatNumber,
  },
  {
    id: "sent",
    title: "Out / s",
    read: (component) => component.events_per_second,
    format: formatNumber,
  },
  {
    id: "errors",
    title: "Errors / min",
    read: (component) => component.errors_per_minute,
    format: formatNumber,
  },
  {
    id: "dropped",
    title: "Dropped / min",
    read: (component) => component.dropped_per_minute,
    format: formatNumber,
  },
  {
    id: "filtered",
    title: "Filtered / min",
    read: (component) => component.filtered_per_minute,
    format: formatNumber,
  },
  {
    id: "buffer",
    title: "Buffer fill",
    read: (component) => component.buffer_utilization,
    format: formatPercent,
  },
  {
    id: "busy",
    title: "Busy",
    read: (component) => component.utilization,
    format: formatPercent,
  },
  // Older agents report only these cumulative counters.
  {
    id: "errors_total",
    title: "Errors (total)",
    read: (component) =>
      present(component.errors_per_minute) ? undefined : component.errors,
    format: formatNumber,
  },
  {
    id: "discarded_total",
    title: "Discarded (total)",
    read: (component) =>
      present(component.dropped_per_minute) ||
      present(component.filtered_per_minute)
        ? undefined
        : component.discarded_events,
    format: formatNumber,
  },
];
const kindOrder = { source: 0, transform: 1, sink: 2 };

function ComponentTable({ components }: { components: ComponentTelemetry[] }) {
  const visible = componentColumns.filter((column) =>
    components.some((component) => present(column.read(component))),
  );
  const rows = [...components].sort(
    (a, b) =>
      (kindOrder[a.kind ?? "transform"] ?? 1) -
        (kindOrder[b.kind ?? "transform"] ?? 1) || a.id.localeCompare(b.id),
  );
  const columns: TableColumn<ComponentTelemetry>[] = [
    {
      id: "component",
      header: "Component",
      value: (component) =>
        `${component.id} ${component.kind || ""} ${component.type || ""}`,
      sortValue: (component) => component.id,
      filter: { placeholder: "Name, kind or type" },
      cell: (component) => (
        <>
          <strong>{component.id}</strong>
          {(component.kind || component.type) && (
            <small className="fleet-cell-note">
              {[component.kind, component.type?.replaceAll("_", " ")]
                .filter(Boolean)
                .join(" · ")}
            </small>
          )}
          {component.sent_by_output &&
            Object.keys(component.sent_by_output).length > 1 && (
              <small className="telemetry-outputs">
                {Object.entries(component.sent_by_output)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, rate]) => `${name} ${formatNumber(rate)}/s`)
                  .join(" · ")}
              </small>
            )}
        </>
      ),
    },
    ...visible.map((column): TableColumn<ComponentTelemetry> => ({
      id: column.id,
      header: column.title,
      value: (component) => column.read(component) ?? null,
      filter: { placeholder: "Filter reported value" },
      cell: (component) => {
        const reading = column.read(component);
        return present(reading) ? (
          column.format(reading)
        ) : (
          <span title="Not reported">—</span>
        );
      },
    })),
  ];
  return (
    <div className="telemetry-components">
      <div className="telemetry-section-heading">
        <h3>Components</h3>
        <span>{components.length} reporting · latest sample</span>
      </div>
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(component) => component.id}
        label="Component metrics"
        className="fleet-table telemetry-component-table"
        empty="No matching components."
        mobileCard={(component) => ({
          title: component.id,
          status: component.kind ? (
            <span className="telemetry-kind">{component.kind}</span>
          ) : undefined,
          meta: [
            component.type?.replaceAll("_", " ") || null,
            ...visible.map((column) => {
              const reading = column.read(component);
              return present(reading)
                ? `${column.title}: ${column.format(reading)}`
                : null;
            }),
          ],
        })}
      />
      <p className="telemetry-note">
        Filtered counts events a filter or sample transform dropped on purpose;
        dropped counts events lost to errors. A dash means the component did not
        report that value.
      </p>
    </div>
  );
}

const sampleColumns: {
  id: string;
  title: string;
  read: (sample: TelemetrySample) => number | null | undefined;
  format: (value: number) => string;
}[] = [
  {
    id: "in",
    title: "In / s",
    read: (sample) => sample.events_per_second,
    format: formatNumber,
  },
  {
    id: "out",
    title: "Out / s",
    read: (sample) => sample.events_out_per_second,
    format: formatNumber,
  },
  {
    id: "errors",
    title: "Errors / min",
    read: (sample) => sample.errors_per_minute,
    format: formatNumber,
  },
  {
    id: "dropped",
    title: "Dropped / min",
    read: (sample) => sample.dropped_per_minute,
    format: formatNumber,
  },
  {
    id: "filtered",
    title: "Filtered / min",
    read: (sample) => sample.filtered_per_minute,
    format: formatNumber,
  },
  {
    id: "buffer",
    title: "Buffer fill",
    read: (sample) => sample.buffer_utilization,
    format: formatPercent,
  },
];

function SampleTable({ points }: { points: TimelinePoint[] }) {
  const rows = points.filter(
    (point): point is TimelinePoint & { sample: TelemetrySample } =>
      !!point.sample,
  );
  // Only what the device reported: no column of dashes.
  const visible = sampleColumns.filter((column) =>
    rows.some((point) => present(column.read(point.sample))),
  );
  const columns: TableColumn<(typeof rows)[number]>[] = [
    {
      id: "at",
      header: "Time",
      value: (point) => point.at,
      sortValue: (point) => point.bucket,
      filter: { placeholder: "Date or time (ISO)" },
      cell: (point) => when(point.at),
    },
    ...visible.map((column): TableColumn<(typeof rows)[number]> => ({
      id: column.id,
      header: column.title,
      value: (point) => column.read(point.sample) ?? null,
      filter: { placeholder: "Filter reported value" },
      cell: (point) => {
        const reading = column.read(point.sample);
        return present(reading) ? (
          column.format(reading)
        ) : (
          <span title="Not reported">—</span>
        );
      },
    })),
  ];
  return (
    <details className="telemetry-samples">
      <summary>View samples as a table</summary>
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(point) => String(point.bucket)}
        label="Metric samples"
        className="fleet-table"
        scrollClassName="telemetry-sample-table"
        defaultSort={{ column: "at", direction: "desc" }}
        empty="No samples in this range."
      />
    </details>
  );
}
