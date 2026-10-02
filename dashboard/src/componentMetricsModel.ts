/**
 * What the device page's Components table says about each component, as
 * values and words: the merged Errors cell, the Out cell that carries what a
 * filter or sample dropped on purpose, and the fill meters. Pure functions
 * over the latest sample, so every claim is testable: a value a component
 * didn't report is absent, never zero.
 */
import type { ComponentTelemetry } from "./runtimeModel";
import { formatNumber, formatPercent, present } from "./telemetryChart";

const kindOrder = { source: 0, transform: 1, sink: 2 };

/** Sources, then transforms, then sinks, each by ID: the order of the graph. */
export function componentRows(components: ComponentTelemetry[]) {
  return [...components].sort(
    (a, b) =>
      (kindOrder[a.kind ?? "transform"] ?? 1) -
        (kindOrder[b.kind ?? "transform"] ?? 1) || a.id.localeCompare(b.id),
  );
}

/** "source · demo logs": what a component is, in the words the graph uses. */
export function componentKind(component: ComponentTelemetry) {
  return [component.kind, component.type?.replaceAll("_", " ")]
    .filter(Boolean)
    .join(" · ");
}

/** One reading and what it counts: a rate, or a total since Vector started. */
export type Reading = { value: number; per: "minute" | "total" };

/**
 * Errors and dropped events in one cell. Agents that report rates give
 * "per minute"; older agents report only totals since Vector started, and the
 * cell says so rather than showing one as the other.
 */
export function errorsCell(component: ComponentTelemetry) {
  const errors: Reading | null = present(component.errors_per_minute)
    ? { value: component.errors_per_minute, per: "minute" }
    : present(component.errors)
      ? { value: component.errors, per: "total" }
      : null;
  const dropped: Reading | null = present(component.dropped_per_minute)
    ? { value: component.dropped_per_minute, per: "minute" }
    : present(component.discarded_error)
      ? { value: component.discarded_error, per: "total" }
      : present(component.discarded_events) &&
          !present(component.filtered_per_minute)
        ? { value: component.discarded_events, per: "total" }
        : null;
  return {
    errors,
    dropped,
    /** Lost events or errors make the cell a problem; zeros stay quiet. */
    bad: (errors?.value ?? 0) > 0 || (dropped?.value ?? 0) > 0,
    /** What the column sorts by: errors and dropped together. */
    sort:
      errors || dropped ? (errors?.value ?? 0) + (dropped?.value ?? 0) : null,
  };
}

/** "3 / min" or "1.2K total": a reading with its unit. */
export function readingText(reading: Reading) {
  return reading.per === "minute"
    ? `${formatNumber(reading.value)} / min`
    : `${formatNumber(reading.value)} total`;
}

/** The same reading as a screen reader should hear it. */
export function readingSpeech(reading: Reading) {
  return reading.per === "minute"
    ? `${formatNumber(reading.value)} per minute`
    : `${formatNumber(reading.value)} in total`;
}

/** Events the component dropped on purpose (a filter, a sample), per minute. */
export function filteredPerMinute(component: ComponentTelemetry) {
  return present(component.filtered_per_minute)
    ? component.filtered_per_minute
    : null;
}

/** Events out per second, with what was filtered out beside it. */
export function outCell(component: ComponentTelemetry) {
  return {
    value: present(component.events_per_second)
      ? component.events_per_second
      : null,
    filtered: filteredPerMinute(component),
  };
}

export type MeterTone = "normal" | "warning" | "danger";
/**
 * How full a buffer is, or how busy a component: the fill carries severity.
 * A full buffer is the problem (it backs the pipeline up); a busy component is
 * a warning at most.
 */
export function meterTone(
  ratio: number,
  kind: "buffer" | "busy" = "buffer",
): MeterTone {
  if (kind === "buffer")
    return ratio >= 0.9 ? "danger" : ratio >= 0.7 ? "warning" : "normal";
  return ratio >= 0.8 ? "warning" : "normal";
}

/** The width of a meter's fill, never less than a sliver for a non-zero ratio. */
export function meterWidth(ratio: number) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return clamped > 0 ? Math.max(clamped, 0.04) : 0;
}

/** "Buffer fill 12%": what a meter says to a pointer and a screen reader. */
export function meterText(label: string, ratio: number) {
  return `${label} ${formatPercent(ratio)}`;
}

/** The facts of one component for a screen reader or a phone card, in order. */
export function componentFacts(component: ComponentTelemetry) {
  const out = outCell(component);
  const { errors, dropped } = errorsCell(component);
  const facts: { label: string; text: string }[] = [];
  const add = (label: string, text: string | null) => {
    if (text !== null) facts.push({ label, text });
  };
  add(
    "In",
    present(component.received_events_per_second)
      ? `${formatNumber(component.received_events_per_second)} / s`
      : null,
  );
  add("Out", out.value === null ? null : `${formatNumber(out.value)} / s`);
  add("Errors", errors && readingText(errors));
  add("Dropped", dropped && readingText(dropped));
  add(
    "Filtered",
    out.filtered === null ? null : `${formatNumber(out.filtered)} / min`,
  );
  add(
    "Buffer fill",
    present(component.buffer_utilization)
      ? formatPercent(component.buffer_utilization)
      : null,
  );
  add(
    "Busy",
    present(component.utilization)
      ? formatPercent(component.utilization)
      : null,
  );
  return facts;
}
