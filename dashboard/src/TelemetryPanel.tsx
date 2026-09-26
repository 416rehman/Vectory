import { useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { when, type Device } from "./api";
import { Button, Empty, ErrorBox, Panel, useResource } from "./ui";
type ComponentMetric = {
  id: string;
  type?: string;
  events_per_second?: number;
  errors?: number;
  discarded_events?: number;
  buffer_bytes?: number;
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
const number = (value?: number | null) =>
  typeof value === "number"
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "Unavailable";
export default function TelemetryPanel({ device }: { device: Device }) {
  const { data, error, reload } = useResource<{
    device_id: string;
    samples: TelemetrySample[];
  }>(`/devices/${device.id}/telemetry`, { device_id: device.id, samples: [] });
  const [selected, setSelected] = useState<number | null>(null);
  const history = data.device_id === device.id ? data.samples : [],
    latest = device.telemetry as TelemetrySample | undefined;
  const bucket = (sample: TelemetrySample) =>
    sample.bucket ?? Math.floor(new Date(sample.sampled_at).getTime() / 60000);
  const end = history.length ? bucket(history.at(-1)!) : 0;
  const first = history.length ? bucket(history[0]) : 0;
  const start = Math.max(first, end - 119),
    byMinute = new Map(history.map((s) => [bucket(s), s]));
  const samples: TelemetrySample[] = history.length
    ? Array.from(
        { length: end - start + 1 },
        (_, i) =>
          byMinute.get(start + i) || {
            bucket: start + i,
            sampled_at: new Date((start + i) * 60000).toISOString(),
          },
      )
    : [];
  const peak = Math.max(1, ...samples.map((s) => s.events_per_second ?? 0));
  return (
    <Panel title="Operational metrics">
      <div className="panel-body">
        <div className="telemetry-heading">
          <p className="muted">
            Last 120 minute buckets. Missing samples stay empty; no pipeline
            events are collected.
          </p>
          <Button variant="secondary compact" icon={RefreshCw} onClick={reload}>
            Refresh metrics
          </Button>
        </div>
        {error && <ErrorBox message={error} retry={reload} />}
        {samples.some((s) => typeof s.events_per_second === "number") ? (
          <>
            <div
              className="telemetry-chart"
              aria-label="Source event throughput over time"
            >
              {samples.map((s, i) => (
                <button
                  key={s.bucket ?? s.sampled_at}
                  title={`${when(s.sampled_at)}: ${number(s.events_per_second)} events / second`}
                  aria-label={`${when(s.sampled_at)}: ${number(s.events_per_second)} events per second`}
                  onFocus={() => setSelected(i)}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => setSelected(i)}
                  style={{
                    height:
                      s.events_per_second == null
                        ? "3px"
                        : `${Math.max(2, (s.events_per_second / peak) * 100)}%`,
                  }}
                  className={s.events_per_second == null ? "missing" : ""}
                />
              ))}
            </div>
            <p className="muted" aria-live="polite">
              {selected !== null && samples[selected]
                ? `${when(samples[selected].sampled_at)} · ${number(samples[selected].events_per_second)} events / second · ${number(samples[selected].errors)} cumulative errors`
                : "Focus or hover a sample to inspect its timestamp."}
            </p>
          </>
        ) : (
          <Empty icon={Activity} title="No throughput history yet">
            Enable explicitly configured local telemetry to see reported samples
            here.
          </Empty>
        )}
        <dl className="metric-summary">
          <div>
            <dt>Process uptime (s)</dt>
            <dd>{number(latest?.uptime_seconds)}</dd>
          </div>
          <div>
            <dt>Memory (bytes)</dt>
            <dd>{number(latest?.memory_bytes)}</dd>
          </div>
          <div>
            <dt>CPU time (s)</dt>
            <dd>{number(latest?.cpu_seconds)}</dd>
          </div>
          <div>
            <dt>Discarded events</dt>
            <dd>{number(latest?.discarded_events)}</dd>
          </div>
          <div>
            <dt>Buffered (bytes)</dt>
            <dd>{number(latest?.buffer_bytes)}</dd>
          </div>
        </dl>
        {latest?.components?.length ? (
          <div className="table-scroll">
            <table>
              <caption>
                Reported component metrics · {when(latest.sampled_at)}
              </caption>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Events / s</th>
                  <th>Errors</th>
                  <th>Discarded</th>
                  <th>Buffer bytes</th>
                </tr>
              </thead>
              <tbody>
                {latest.components.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.id}</strong>
                      {c.type && <small className="muted"> · {c.type}</small>}
                    </td>
                    <td>{number(c.events_per_second)}</td>
                    <td>{number(c.errors)}</td>
                    <td>{number(c.discarded_events)}</td>
                    <td>{number(c.buffer_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Per-component metrics have not been reported.</p>
        )}
        {samples.length > 0 && (
          <details>
            <summary>Inspect reported history</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Sample time</th>
                    <th>Events / second</th>
                    <th>Cumulative errors</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((s) => (
                    <tr key={s.bucket ?? s.sampled_at}>
                      <td>{when(s.sampled_at)}</td>
                      <td>{number(s.events_per_second)}</td>
                      <td>{number(s.errors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </Panel>
  );
}
