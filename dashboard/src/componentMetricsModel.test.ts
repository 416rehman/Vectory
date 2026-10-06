import { describe, expect, it } from "vitest";
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
} from "./componentMetricsModel";
import type { ComponentTelemetry } from "./runtimeModel";

const component = (overrides: Partial<ComponentTelemetry>) =>
  ({ id: "c", ...overrides }) as ComponentTelemetry;

describe("component rows", () => {
  it("orders sources, transforms and sinks, each by name", () => {
    const rows = componentRows([
      component({ id: "out", kind: "sink" }),
      component({ id: "tag", kind: "transform" }),
      component({ id: "b_in", kind: "source" }),
      component({ id: "a_in", kind: "source" }),
      component({ id: "mystery" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "a_in",
      "b_in",
      "mystery",
      "tag",
      "out",
    ]);
  });
  it("names what a component is as the graph does", () => {
    expect(
      componentKind(component({ kind: "sink", type: "prometheus_exporter" })),
    ).toBe("sink · prometheus exporter");
    expect(componentKind(component({ kind: "source" }))).toBe("source");
    expect(componentKind(component({}))).toBe("");
  });
});

describe("the Errors cell", () => {
  it("merges errors and dropped events, per minute", () => {
    const cell = errorsCell(
      component({ errors_per_minute: 3, dropped_per_minute: 2 }),
    );
    expect(cell.errors).toEqual({ value: 3, per: "minute" });
    expect(cell.dropped).toEqual({ value: 2, per: "minute" });
    expect(cell.bad).toBe(true);
    expect(cell.sort).toBe(5);
  });
  it("stays quiet when nothing was lost", () => {
    const cell = errorsCell(
      component({ errors_per_minute: 0, dropped_per_minute: 0 }),
    );
    expect(cell.bad).toBe(false);
    expect(cell.sort).toBe(0);
  });
  it("says totals are totals when an older agent reports only those", () => {
    const cell = errorsCell(component({ errors: 12, discarded_events: 4 }));
    expect(cell.errors).toEqual({ value: 12, per: "total" });
    expect(cell.dropped).toEqual({ value: 4, per: "total" });
    // Filtered events are not drops: a component that reports a filtered rate
    // has no dropped total to show from discarded_events.
    expect(
      errorsCell(
        component({
          errors_per_minute: 0,
          discarded_events: 9,
          filtered_per_minute: 9,
        }),
      ).dropped,
    ).toBeNull();
    expect(
      errorsCell(component({ discarded_error: 7, errors: 0 })).dropped,
    ).toEqual({ value: 7, per: "total" });
  });
  it("never turns a missing report into zero", () => {
    const cell = errorsCell(component({}));
    expect(cell).toEqual({
      errors: null,
      dropped: null,
      bad: false,
      sort: null,
    });
    expect(
      errorsCell(component({ errors_per_minute: null })).errors,
    ).toBeNull();
  });
  it("words a reading for the eye and for a screen reader", () => {
    expect(readingText({ value: 1234, per: "minute" })).toBe("1.2K / min");
    expect(readingText({ value: 12, per: "total" })).toBe("12 total");
    expect(readingSpeech({ value: 3, per: "minute" })).toBe("3 per minute");
    expect(readingSpeech({ value: 12, per: "total" })).toBe("12 in total");
  });
});

describe("the Out cell", () => {
  it("carries what a filter or sample dropped on purpose", () => {
    expect(
      outCell(component({ events_per_second: 0.4, filtered_per_minute: 247 })),
    ).toEqual({ value: 0.4, filtered: 247 });
    expect(outCell(component({ events_per_second: 5 }))).toEqual({
      value: 5,
      filtered: null,
    });
    expect(outCell(component({}))).toEqual({ value: null, filtered: null });
  });
});

describe("the fill meters", () => {
  it("lets the fill carry severity: a full buffer is the problem", () => {
    expect(meterTone(0.1)).toBe("normal");
    expect(meterTone(0.7)).toBe("warning");
    expect(meterTone(0.95)).toBe("danger");
    // A busy component is a warning at most.
    expect(meterTone(0.5, "busy")).toBe("normal");
    expect(meterTone(0.85, "busy")).toBe("warning");
    expect(meterTone(1, "busy")).toBe("warning");
  });
  it("keeps a sliver of fill for a ratio that isn't zero", () => {
    expect(meterWidth(0)).toBe(0);
    expect(meterWidth(0.001)).toBe(0.04);
    expect(meterWidth(0.5)).toBe(0.5);
    expect(meterWidth(3)).toBe(1);
    expect(meterWidth(-1)).toBe(0);
  });
  it("says the number the bar leaves out", () => {
    expect(meterText("Buffer fill", 0.126)).toBe("Buffer fill 13%");
    expect(meterText("Busy", 0.0004)).toBe("Busy <0.1%");
  });
});

describe("the facts of a phone card", () => {
  it("keeps every fact the table has, and only those reported", () => {
    const facts = componentFacts(
      component({
        received_events_per_second: 4,
        events_per_second: 0.4,
        errors_per_minute: 0,
        dropped_per_minute: 1,
        filtered_per_minute: 247,
        buffer_utilization: 0.12,
        utilization: 0.003,
      }),
    );
    expect(facts.map((fact) => [fact.label, fact.text])).toEqual([
      ["In", "4 / s"],
      ["Out", "0.4 / s"],
      ["Errors", "0 / min"],
      ["Dropped", "1 / min"],
      ["Filtered", "247 / min"],
      ["Buffer fill", "12%"],
      ["Busy", "0.3%"],
    ]);
    expect(componentFacts(component({ events_per_second: 2 }))).toEqual([
      { label: "Out", text: "2 / s" },
    ]);
    expect(componentFacts(component({}))).toEqual([]);
  });
});
