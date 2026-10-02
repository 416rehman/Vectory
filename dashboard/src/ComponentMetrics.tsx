import { DataTable, type TableColumn } from "./DataTable";
import {
  componentFacts,
  componentKind,
  componentRows,
  errorsCell,
  meterText,
  meterTone,
  meterWidth,
  outCell,
  readingSpeech,
  readingText,
} from "./componentMetrics";
import type { ComponentTelemetry } from "./runtimeModel";
import { formatNumber, formatPercent, present } from "./telemetryChart";
import { TimeAgo } from "./ui";
import "./component-metrics.css";

/** A reading the component didn't report is a dash, never a zero. */
const Missing = () => (
  <span className="component-missing" title="Not reported">
    —<span className="sr-only">Not reported</span>
  </span>
);

const number = (value: number | null | undefined) =>
  present(value) ? formatNumber(value) : <Missing />;

/**
 * A 40 px bar for a ratio. The number is in the tooltip and in the cell for
 * screen readers; a fill that is a problem (a buffer nearly full) also writes
 * it, so colour never carries that alone.
 */
function Meter({
  label,
  ratio,
  kind,
}: {
  label: string;
  ratio: number | null | undefined;
  kind: "buffer" | "busy";
}) {
  if (!present(ratio)) return <Missing />;
  const tone = meterTone(ratio, kind);
  const text = meterText(label, ratio);
  return (
    <span className="component-meter-cell" title={text}>
      <span className="component-meter" data-tone={tone} aria-hidden="true">
        <span style={{ width: `${meterWidth(ratio) * 100}%` }} />
      </span>
      {tone !== "normal" && (
        <span className="component-meter-value" data-tone={tone}>
          {formatPercent(ratio)}
        </span>
      )}
      <span className="sr-only">{text}</span>
    </span>
  );
}

function Outputs({ component }: { component: ComponentTelemetry }) {
  const outputs = component.sent_by_output;
  if (!outputs || Object.keys(outputs).length < 2) return null;
  return (
    <small className="component-outputs">
      {Object.entries(outputs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, rate]) => `${name} ${formatNumber(rate)}/s`)
        .join(" · ")}
    </small>
  );
}

/** The latest sample's components: what each took in, sent, lost and holds. */
export default function ComponentMetrics({
  components,
  sampledAt,
  level = 3,
}: {
  components: ComponentTelemetry[];
  /** When the sample was taken, so a card of its own still says how old it is. */
  sampledAt?: string | null;
  /** The heading's level: 2 when it stands in a card of its own, else 3. */
  level?: 2 | 3;
}) {
  const rows = componentRows(components);
  const Heading = `h${level}` as "h2" | "h3";
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
          {componentKind(component) && (
            <small className="component-kind">{componentKind(component)}</small>
          )}
          <Outputs component={component} />
        </>
      ),
    },
    {
      id: "in",
      header: "In / s",
      value: (component) => component.received_events_per_second ?? null,
      className: "component-number",
      cell: (component) => number(component.received_events_per_second),
    },
    {
      id: "out",
      header: "Out / s",
      value: (component) => outCell(component).value,
      className: "component-number",
      cell: (component) => {
        const out = outCell(component);
        return (
          <>
            {number(out.value)}
            {out.filtered !== null && out.filtered > 0 && (
              <small className="component-subline">
                {formatNumber(out.filtered)}/min filtered
              </small>
            )}
          </>
        );
      },
    },
    {
      id: "errors",
      header: "Errors / min",
      value: (component) => errorsCell(component).sort,
      className: "component-number",
      cell: (component) => {
        const { errors, dropped, bad } = errorsCell(component);
        if (!errors && !dropped) return <Missing />;
        return (
          <span className="component-errors" data-bad={bad || undefined}>
            {errors ? (
              errors.per === "total" ? (
                <>
                  {formatNumber(errors.value)}
                  <small className="component-unit"> total</small>
                </>
              ) : (
                formatNumber(errors.value)
              )
            ) : (
              <Missing />
            )}
            {dropped && dropped.value > 0 && (
              <small className="component-subline" data-bad="">
                {readingText(dropped).replace(" / min", "/min")} dropped
              </small>
            )}
            <span className="sr-only">
              {[
                errors && `${readingSpeech(errors)} errors`,
                dropped && `${readingSpeech(dropped)} dropped`,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          </span>
        );
      },
    },
    {
      id: "buffer",
      header: "Buffer fill",
      value: (component) => component.buffer_utilization ?? null,
      className: "component-meter-column",
      cell: (component) => (
        <Meter
          label="Buffer fill"
          ratio={component.buffer_utilization}
          kind="buffer"
        />
      ),
    },
    {
      id: "busy",
      header: "Busy",
      value: (component) => component.utilization ?? null,
      className: "component-meter-column",
      cell: (component) => (
        <Meter label="Busy" ratio={component.utilization} kind="busy" />
      ),
    },
  ];
  return (
    <section className="component-metrics" aria-labelledby="component-metrics">
      <div className="component-heading">
        <Heading id="component-metrics">Components</Heading>
        <span>
          {components.length} reporting
          {sampledAt ? (
            <>
              {" · sample "}
              <TimeAgo value={sampledAt} />
            </>
          ) : (
            " · latest sample"
          )}
        </span>
      </div>
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(component) => component.id}
        label="Component metrics"
        className="component-table"
        scrollClassName="component-scroll"
        empty="No matching components."
        mobileCard={(component) => ({
          title: component.id,
          status: component.kind ? (
            <span className="component-kind-chip">{component.kind}</span>
          ) : undefined,
          meta: [
            component.type?.replaceAll("_", " ") || null,
            <dl key="facts" className="component-facts">
              {componentFacts(component).map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.text}</dd>
                </div>
              ))}
            </dl>,
            <Outputs key="outputs" component={component} />,
          ],
        })}
      />
      <p className="component-scroll-cue">
        Scroll sideways to see every column.
      </p>
      <p className="component-note">
        Filtered events were dropped on purpose by a filter or sample transform.
        Dropped events were lost to errors. A dash means the component
        didn&apos;t report that value.
      </p>
    </section>
  );
}
