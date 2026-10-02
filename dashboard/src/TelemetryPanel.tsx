import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { when, type AuditHistoryPage, type Device } from "./api";
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
import MetricChart, {
  ChangeList,
  reading,
  type ChartSpec,
} from "./MetricChart";
import ComponentMetrics from "./ComponentMetrics";
import type {
  TelemetryHistory,
  TelemetryRange,
  TelemetrySample,
} from "./runtimeModel";
import {
  applyMarkers,
  counterNote,
  counterSince,
  lastVersionChange,
  markedSince,
  type ApplyMarker,
  type ChangeEvent,
} from "./deviceChanges";
import {
  bridgeSlots,
  chartRanges,
  defaultRange,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  lastSlots,
  present,
  telemetryPollMs,
  timeline,
  type TimelinePoint,
} from "./telemetryChart";
import "./telemetry-panel.css";

export type { TelemetrySample } from "./runtimeModel";

const charts: ChartSpec[] = [
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

const FIFTEEN_MINUTES = 15 * 60_000;

/** Operational metrics for one device, shown on its page. */
export default function TelemetryPanel({
  device,
  logs = true,
  components: withComponents = true,
}: {
  device: Device;
  /** Show the device's recent Vector warnings and errors below the metrics. */
  logs?: boolean;
  /**
   * Show the Components table here. The device page lifts it out to its own
   * full-width card on wide screens, where it needs the room.
   */
  components?: boolean;
}) {
  // Until a range is chosen the charts open on the shortest one that holds all
  // of the device's history (15 minutes, then an hour). The hour is read
  // either way: its minutes are the same ones.
  const [chosen, setChosen] = useState<TelemetryRange | null>(null),
    [hover, setHover] = useState<number | null>(null);
  const readRange: TelemetryRange = chosen ?? "1h";
  const resource = useResource<TelemetryHistory>(
    `/devices/${encodeURIComponent(device.id)}/telemetry?range=${readRange}`,
    { device_id: device.id, samples: [] },
    0,
    { interval: telemetryPollMs[readRange] },
  );
  // Keep the previous render while a new range loads: no flash, no jump.
  const [shown, setShown] = useState<TelemetryHistory | null>(null);
  const settled = !resource.loading && !resource.error;
  useEffect(() => {
    if (settled && resource.data.device_id === device.id)
      setShown(resource.data);
  }, [settled, resource.data, device.id]);
  useEffect(() => setHover(null), [chosen, device.id]);

  // What the device did, from its audit trail: the markers on the charts and
  // the baseline of the counters under the tiles. A read that fails leaves the
  // charts as they are.
  const changeKey = [
    device.apply_state,
    device.reported_generation,
    device.desired_generation,
    device.desired_version_id ?? "",
  ].join("|");
  const lastChangeKey = useRef(changeKey);
  const [changeReads, setChangeReads] = useState(0);
  useEffect(() => {
    if (lastChangeKey.current === changeKey) return;
    lastChangeKey.current = changeKey;
    setChangeReads((count) => count + 1);
  }, [changeKey]);
  const changes = useResource<AuditHistoryPage>(
    `/audit/history?device_id=${encodeURIComponent(device.id)}&page_size=50`,
    { items: [], total: 0, page: 1, page_size: 50 },
    changeReads,
    { interval: 60_000 },
  );
  const markers = useMemo(
    () =>
      applyMarkers(
        (changes.data.items as ChangeEvent[]).filter(
          (item) =>
            (item as { device_id?: string | null }).device_id?.toLowerCase() ===
            device.id.toLowerCase(),
        ),
      ),
    [changes.data, device.id],
  );

  const history =
    shown && shown.device_id === device.id
      ? shown
      : { device_id: device.id, samples: [] };
  const now = Date.now();
  const createdAt = Date.parse(device.created_at);
  // Slots from before the device existed are no gap in its reports; the slot
  // still collecting is no value yet.
  const all = timeline(history, 120, {
    now,
    notBefore: Number.isFinite(createdAt) ? createdAt : null,
  });
  const range: TelemetryRange =
    chosen ??
    (shown && shown.device_id === device.id
      ? defaultRange(all, now)
      : now - createdAt <= FIFTEEN_MINUTES
        ? "15m"
        : "1h");
  const windowMinutes = chartRanges.find((r) => r.value === range)!.minutes;
  const stepMinutes = history.step_seconds
    ? Math.max(1, Math.round(history.step_seconds / 60))
    : 1;
  const points = lastSlots(
    all,
    Math.max(1, Math.ceil(windowMinutes / stepMinutes)),
  );
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
      chart.series.some((series) => present(reading(point.sample, series.key))),
    ),
  );
  const hasValues =
    !!latest || visibleCharts.length > 0 || components.length > 0;
  // Lines cross empty slots shorter than one check-in: not a missed report.
  const bridge = bridgeSlots(heartbeat, history.step_seconds ?? 60);
  const runtime = device.host_runtime;
  const disabled = device.effective_policy?.telemetry_enabled === false;
  const slotMs = stepMinutes * 60_000;
  const windowStart = points[0] ? Date.parse(points[0].at) : 0;
  const windowEnd = points.at(-1) ? Date.parse(points.at(-1)!.at) + slotMs : 0;
  const inRange = markers.filter((marker) => {
    const time = Date.parse(marker.at);
    return time >= windowStart && time < windowEnd;
  });
  // Only the newest events are read: say so when the range reaches back past them.
  const readSince = markedSince(changes.data);
  const unmarkedBefore =
    readSince && Date.parse(readSince) > windowStart ? readSince : null;
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
            options={chartRanges}
            value={range}
            onChange={setChosen}
          />
          <RefreshButton
            onClick={() => {
              void resource.reload();
              void changes.reload();
            }}
            busy={resource.loading}
          >
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
          {latest && (
            <StatTiles
              sample={latest}
              history={history.samples}
              change={lastVersionChange(markers)}
            />
          )}
          {visibleCharts.length > 0 ? (
            <>
              <ChangeList
                markers={inRange}
                deviceId={device.id}
                unmarkedBefore={unmarkedBefore}
              />
              <div className="telemetry-charts">
                {visibleCharts.map((chart) => (
                  <MetricChart
                    key={chart.id}
                    chart={chart}
                    points={points}
                    stepMinutes={stepMinutes}
                    windowMinutes={windowMinutes}
                    bridge={bridge}
                    hover={hover}
                    onHover={setHover}
                    markers={inRange}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="telemetry-note">
              No history in this range yet. Charts appear once the agent has
              reported successive samples.
            </p>
          )}
          {visibleCharts.length > 0 && (
            <p className="telemetry-note">
              A gap means the device sent no metrics for longer than one
              check-in. A dot marks a change on the device. Move over a chart or
              focus it and use the arrow keys to read values.
            </p>
          )}
          <ProcessStats sample={latest} runtime={runtime} />
          {withComponents && components.length > 0 && (
            <div className="telemetry-components">
              <ComponentMetrics
                components={components}
                sampledAt={device.telemetry?.sampled_at}
              />
            </div>
          )}
          {(points.some((point) => point.sample) || inRange.length > 0) && (
            <SampleTable points={points} markers={inRange} />
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

/**
 * Whether an agent of this version finds the running pipeline's exporter by
 * itself and reports how it reads metrics: every agent from 0.1 on does.
 * Null when the version doesn't say (not reported, or not a release number).
 */
export function agentFindsExporter(version?: string | null): boolean | null {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version || "");
  if (!match) return null;
  return Number(match[1]) > 0 || Number(match[2]) >= 1;
}

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
  // A missing report is not an old agent: only its version says that.
  if (!runtime)
    checks.push(
      agentFindsExporter(device.agent_version) === false
        ? {
            ok: null,
            label:
              "This agent version reads metrics only from a URL configured on the host",
            detail:
              "Update the agent so it finds the pipeline's exporter automatically, or run vectory configure-metrics on the device.",
          }
        : {
            ok: null,
            label: "The agent hasn't reported how it reads metrics yet",
            detail: `It reports that with its next check-in while it runs (every ${heartbeat} seconds).`,
          },
    );
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

function StatTiles({
  sample,
  history,
  change,
}: {
  sample: TelemetrySample;
  /** Readings of the cumulative counters, oldest first. */
  history: TelemetrySample[];
  /** The newest version change: the counters count from just after it. */
  change: ApplyMarker | null;
}) {
  // Vector keeps its counters across a reload, so a total after a pipeline
  // switch holds the previous pipeline's events: count from the change.
  const note = (key: "errors" | "discarded_error" | "discarded_intentional") =>
    counterNote(
      counterSince({
        total: sample[key],
        latestAt: sample.sampled_at,
        uptimeSeconds: sample.uptime_seconds,
        changedAt: change?.at ?? null,
        readings: history.map((item) => ({
          at: item.sampled_at,
          value: item[key],
        })),
      }),
      change,
      formatNumber,
    );
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
      note: note("errors"),
    },
    {
      label: "Dropped due to errors",
      unit: "/ min",
      value: sample.dropped_per_minute,
      format: formatNumber,
      note: note("discarded_error"),
    },
    {
      label: "Filtered out (expected)",
      unit: "/ min",
      value: sample.filtered_per_minute,
      format: formatNumber,
      note: note("discarded_intentional"),
    },
    {
      label: "Buffer fill",
      unit: "",
      value: sample.buffer_utilization,
      format: formatPercent,
      note: present(sample.buffer_bytes)
        ? {
            text: `${formatBytes(sample.buffer_bytes)} buffered`,
            title: undefined,
          }
        : null,
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
          {tile.note && (
            <dd className="telemetry-tile-note" title={tile.note.title}>
              {tile.note.text}
            </dd>
          )}
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

/**
 * The charts as tables: every sample in the range and every change marked on
 * them, so what a line shows and a marker names is readable without a pointer.
 */
function SampleTable({
  points,
  markers,
}: {
  points: TimelinePoint[];
  markers: ApplyMarker[];
}) {
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
  const changeColumns: TableColumn<ApplyMarker>[] = [
    {
      id: "at",
      header: "Time",
      value: (marker) => marker.at,
      cell: (marker) => when(marker.at),
    },
    {
      id: "change",
      header: "Change",
      value: (marker) => marker.stateLabel,
      cell: (marker) => marker.stateLabel,
    },
    {
      id: "version",
      header: "Version",
      value: (marker) => marker.version ?? "",
      cell: (marker) =>
        marker.version ?? <span className="device-muted">Not recorded</span>,
    },
  ];
  return (
    <details className="telemetry-samples">
      <summary>
        {markers.length
          ? "View samples and changes as tables"
          : "View samples as a table"}
      </summary>
      {markers.length > 0 && (
        <div className="telemetry-change-table">
          <DataTable
            data={[...markers].reverse()}
            columns={changeColumns}
            rowKey={(marker) => marker.id}
            label="Changes on this device"
            className="fleet-table"
            defaultSort={{ column: "at", direction: "desc" }}
            empty="No changes in this range."
          />
        </div>
      )}
      {rows.length > 0 && (
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
      )}
    </details>
  );
}
