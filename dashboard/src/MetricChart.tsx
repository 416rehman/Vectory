import { type KeyboardEvent } from "react";
import { when } from "./api";
import { auditRoute, defaultAuditQuery } from "./auditModel";
import { clusterMarkers, markerTime, type ApplyMarker } from "./deviceChanges";
import type { TelemetrySample } from "./runtimeModel";
import {
  axisTime,
  bridgedSlots,
  fitAxis,
  isolatedPoints,
  present,
  readableSlot,
  seriesPath,
  spanLabel,
  wholeNumbers,
  type TimelinePoint,
} from "./telemetryChart";

export type ChartSeries = {
  key: keyof TelemetrySample;
  label: string;
  tone: "in" | "out" | "critical" | "muted";
};
export type ChartSpec = {
  id: string;
  title: string;
  unit: string;
  series: ChartSeries[];
  format: (value: number) => string;
  /** Fixed axis maximum (ratios), else a clean maximum from the data. */
  max?: number;
};

const chartWidth = 800,
  chartHeight = 120;

/** A reading the device made, or undefined when it reported none. */
export const reading = (
  sample: TelemetrySample | undefined,
  key: keyof TelemetrySample,
) => (sample && present(sample[key]) ? (sample[key] as number) : undefined);

function lastReported(points: TimelinePoint[], series: ChartSeries[]) {
  for (let index = points.length - 1; index >= 0; index--)
    if (series.some((item) => present(reading(points[index].sample, item.key))))
      return index;
  return null;
}

/** Changes that fall in one slot of the chart: what the readout names there. */
function markersIn(
  markers: ApplyMarker[],
  point: TimelinePoint | undefined,
  slotMs: number,
) {
  if (!point) return [];
  const start = Date.parse(point.at);
  return markers.filter((marker) => {
    const time = Date.parse(marker.at);
    return time >= start && time < start + slotMs;
  });
}

const markerLabel = (marker: ApplyMarker) =>
  [marker.stateLabel, marker.version].filter(Boolean).join(" ");

/**
 * One metric over time: its series as lines that break at gaps, the apply
 * events of the device as markers, and a readout (hover, or the arrow keys)
 * that names every series and any change in the slot it points at. The
 * markers are for sight and pointer; the same changes are in the list above
 * the charts and in the table view.
 */
export default function MetricChart({
  chart,
  points,
  stepMinutes,
  windowMinutes,
  bridge,
  hover,
  onHover,
  markers,
}: {
  chart: ChartSpec;
  points: TimelinePoint[];
  /** The width of one slot. */
  stepMinutes: number;
  /** The range asked for, which decides how the axis writes its times. */
  windowMinutes: number;
  /** Empty slots a line may cross (see bridgeSlots). */
  bridge: number;
  hover: number | null;
  onHover: (index: number | null) => void;
  markers: ApplyMarker[];
}) {
  const series = chart.series.filter((item) =>
    points.some((point) => present(reading(point.sample, item.key))),
  );
  const reported = points.map((point) =>
    series.some((item) => present(reading(point.sample, item.key))),
  );
  const bridged = bridgedSlots(reported, bridge);
  const values = points.flatMap((point) =>
    series.map((item) => reading(point.sample, item.key)),
  );
  const peak = Math.max(0, ...values.map((value) => value ?? 0));
  const axis =
    chart.max !== undefined
      ? { max: chart.max }
      : fitAxis(peak, wholeNumbers(values));
  const max = axis.max;
  const x = (index: number) =>
    points.length <= 1
      ? chartWidth / 2
      : (index / (points.length - 1)) * chartWidth;
  const y = (value: number) =>
    chartHeight - Math.min(1, value / max) * (chartHeight - 4);
  const selected =
    hover !== null && hover < points.length
      ? readableSlot(hover, reported, bridged)
      : null;
  const readoutIndex = selected ?? lastReported(points, series);
  const readoutPoint = readoutIndex === null ? undefined : points[readoutIndex];
  const slotMs = stepMinutes * 60_000;
  const first = points[0],
    last = points.at(-1);
  const startMs = first ? Date.parse(first.at) : 0;
  const endMs = last ? Date.parse(last.at) : 0;
  const clusters = clusterMarkers(markers, startMs, endMs, slotMs);
  // The legend names each kind of change the plot shows, once.
  const kinds = [
    ...new Map(
      clusters.flatMap((cluster) =>
        cluster.markers.map((marker) => [marker.state, marker] as const),
      ),
    ).values(),
  ];
  const nearby = markersIn(markers, readoutPoint, slotMs);
  // The window is the range asked for; the caption says so when the device has
  // reported less than that, since a short line is then no outage.
  const covers = last ? endMs + slotMs - startMs : 0;
  const short = covers > 0 && covers < windowMinutes * 60_000 * 0.9;
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const lastIndex = points.length - 1;
    const current = selected ?? readoutIndex ?? lastIndex;
    const step =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
    const next = step
      ? current + step
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : null;
    if (next === null) return;
    event.preventDefault();
    const slot = Math.max(0, Math.min(lastIndex, next));
    onHover(step ? readableSlot(slot, reported, bridged, step) : slot);
  }
  const label = `${chart.title}, ${chart.unit}, ${series.map((item) => item.label).join(" and ")}. Gaps mean no report.${clusters.length ? ` ${markers.length} ${markers.length === 1 ? "change is" : "changes are"} marked.` : ""}`;
  return (
    <figure className="telemetry-chart">
      <figcaption>
        <span className="telemetry-chart-title">{chart.title}</span>
        <span className="telemetry-chart-unit">{chart.unit}</span>
      </figcaption>
      {(series.length > 1 || kinds.length > 0) && (
        <ul className="telemetry-legend">
          {series.length > 1 &&
            series.map((item) => (
              <li key={String(item.key)}>
                <span
                  className={`telemetry-key ${item.tone}`}
                  aria-hidden="true"
                />
                {item.label}
              </li>
            ))}
          {kinds.map((marker) => (
            <li key={marker.state} data-tone={marker.tone}>
              <span className="telemetry-marker-key" aria-hidden="true" />
              {marker.stateLabel}
            </li>
          ))}
        </ul>
      )}
      <p className="telemetry-readout" aria-live="polite">
        {readoutPoint ? (
          <>
            <time dateTime={readoutPoint.at}>{when(readoutPoint.at)}</time>
            {series.map((item) => {
              const value = reading(readoutPoint.sample, item.key);
              return (
                <span key={String(item.key)}>
                  {series.length > 1 && (
                    <span
                      className={`telemetry-key ${item.tone}`}
                      aria-hidden="true"
                    />
                  )}
                  <strong>
                    {present(value) ? chart.format(value) : "No report"}
                  </strong>
                  {series.length > 1 && <> {item.label.toLowerCase()}</>}
                </span>
              );
            })}
            {nearby.map((marker) => (
              <span
                key={marker.id}
                className="telemetry-readout-change"
                data-tone={marker.tone}
              >
                <span className="telemetry-marker-key" aria-hidden="true" />
                {markerLabel(marker)} at {markerTime(marker.at)}
              </span>
            ))}
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
            const line = points.map((point) => reading(point.sample, item.key));
            return (
              <g
                key={String(item.key)}
                className={`telemetry-series ${item.tone}`}
              >
                <path d={seriesPath(line, x, y, bridge)} />
                {isolatedPoints(line, bridge).map((index) => (
                  <line
                    key={index}
                    x1={Math.max(0, x(index) - 4)}
                    x2={Math.min(chartWidth, x(index) + 4)}
                    y1={y(line[index]!)}
                    y2={y(line[index]!)}
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
        {clusters.length > 0 && (
          <div className="telemetry-markers" aria-hidden="true">
            {clusters.map((cluster) => (
              <span
                key={cluster.markers[0].id}
                className="telemetry-marker"
                data-tone={cluster.tone}
                data-edge={cluster.x > 0.55 ? "end" : "start"}
                data-many={cluster.markers.length > 1 || undefined}
                style={{ left: `${cluster.x * 100}%` }}
              >
                <span className="telemetry-marker-dot" />
                <span className="telemetry-marker-tip" role="presentation">
                  {cluster.markers.map((marker) => (
                    <span key={marker.id} data-tone={marker.tone}>
                      <span className="telemetry-marker-key" />
                      <strong>{markerLabel(marker)}</strong>
                      <small>{markerTime(marker.at)}</small>
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="telemetry-axis" aria-hidden="true">
        <span>{first ? axisTime(first.at, windowMinutes) : ""}</span>
        {short && (
          <span className="telemetry-span">
            {spanLabel(startMs, endMs + slotMs)}
          </span>
        )}
        <span>{last ? axisTime(last.at, windowMinutes) : ""}</span>
      </div>
    </figure>
  );
}

/**
 * The changes marked on the charts, newest first, each linking to its audit
 * event: what a marker's colour and position leave out. The same list serves
 * keyboard and screen-reader users, who read the charts through their readout.
 */
export function ChangeList({
  markers,
  deviceId,
  unmarkedBefore = null,
}: {
  markers: ApplyMarker[];
  deviceId: string;
  /** The device has more events than were read: nothing earlier is marked. */
  unmarkedBefore?: string | null;
}) {
  const note = unmarkedBefore
    ? `Changes before ${when(unmarkedBefore)} aren't marked.`
    : null;
  if (!markers.length)
    return note ? <p className="telemetry-note">{note}</p> : null;
  const ordered = [...markers].reverse();
  const item = (marker: ApplyMarker) => (
    <li key={marker.id} data-tone={marker.tone}>
      <span className="telemetry-marker-key" aria-hidden="true" />
      <a
        href={`#/${auditRoute(marker.id, { ...defaultAuditQuery, device_id: deviceId })}`}
        title="Open in the audit log"
      >
        {markerLabel(marker)}
      </a>
      <time dateTime={marker.at}>{when(marker.at)}</time>
    </li>
  );
  const shown = ordered.slice(0, 4),
    older = ordered.slice(4);
  return (
    <section className="telemetry-changes" aria-labelledby="telemetry-changes">
      <h3 id="telemetry-changes">Changes in this range</h3>
      <ul>{shown.map(item)}</ul>
      {older.length > 0 && (
        <details>
          <summary>{older.length} earlier</summary>
          <ul>{older.map(item)}</ul>
        </details>
      )}
      {note && <p className="telemetry-changes-note">{note}</p>}
    </section>
  );
}
