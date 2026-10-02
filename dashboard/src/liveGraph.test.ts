import { afterEach, describe, expect, it, vi } from "vitest";
import {
  edgeRate,
  edgeWidth,
  EDGE_WIDTH_MAX,
  EDGE_WIDTH_MIN,
  formatRate,
  liveSummary,
  liveTable,
  nodeLive,
  nodeLiveSummary,
  readLivePreference,
  spokenRate,
  writeLivePreference,
  type PipelineTelemetry,
} from "./liveGraph";

const telemetry: PipelineTelemetry = {
  devices_running: 3,
  devices_reporting: 3,
  components: [
    {
      id: "app_logs",
      kind: "source",
      type: "demo_logs",
      devices_reporting: 3,
      sent_events_per_second: 15.5,
      sent_by_output: { _default: 15.5 },
    },
    {
      id: "by_severity",
      kind: "transform",
      type: "route",
      devices_reporting: 3,
      received_events_per_second: 15.5,
      sent_events_per_second: 15.5,
      sent_by_output: { errors: 1.1, _unmatched: 14.4 },
      errors_per_minute: 0,
    },
    {
      id: "archive",
      kind: "sink",
      type: "aws_s3",
      devices_reporting: 2,
      received_events_per_second: 14.4,
      errors_per_minute: 3,
      buffer_utilization_max: 0.42,
    },
  ],
  versions: [
    {
      version_id: "v2",
      version_number: 2,
      devices_running: 3,
      devices_reporting: 3,
    },
  ],
};

describe("live canvas numbers", () => {
  it("format rates compactly and never show missing data as zero", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("0/s");
    expect(formatRate(0.04)).toBe("<0.1/s");
    expect(formatRate(3.94)).toBe("3.9/s");
    expect(formatRate(631)).toBe("631/s");
    expect(formatRate(12_400)).toBe("12.4k/s");
    expect(formatRate(3, "/min")).toBe("3.0/min");
  });

  it("read each edge from the output it leaves", () => {
    expect(edgeRate(telemetry, "app_logs")).toBe(15.5);
    expect(edgeRate(telemetry, "by_severity", "errors")).toBe(1.1);
    expect(edgeRate(telemetry, "by_severity", "_unmatched")).toBe(14.4);
    expect(edgeRate(telemetry, "by_severity", "missing")).toBeNull();
    expect(edgeRate(telemetry, "unknown")).toBeNull();
  });

  it("draws a connection's width in proportion to the logarithm of its rate", () => {
    expect(edgeWidth(null)).toBe(1.5);
    expect(edgeWidth(0)).toBe(1.5);
    expect(edgeWidth(Number.NaN)).toBe(1.5);
    expect(edgeWidth(1_000_000)).toBe(5);
    expect(edgeWidth(10)).toBeGreaterThan(edgeWidth(1));
    // Each decade adds the same width, until the top.
    const step = (a: number, b: number) => edgeWidth(b) - edgeWidth(a);
    expect(step(9, 99)).toBeCloseTo(step(99, 999), 1);
    expect(step(99, 999)).toBeCloseTo(step(999, 9999), 1);
    for (const rate of [0.01, 0.5, 3, 40, 700, 12_000, 3e9]) {
      expect(edgeWidth(rate)).toBeGreaterThanOrEqual(EDGE_WIDTH_MIN);
      expect(edgeWidth(rate)).toBeLessThanOrEqual(EDGE_WIDTH_MAX);
    }
  });

  it("says rates the way a screen reader should read them", () => {
    expect(spokenRate(12_400)).toBe("12.4k events per second");
    expect(spokenRate(3, "minute", "errors")).toBe("3.0 errors per minute");
    expect(spokenRate(0)).toBe("0 events per second");
    expect(spokenRate(null)).toBe("no data");
    const reading = nodeLive(telemetry, "archive");
    expect(nodeLiveSummary("sinks", reading)).toBe(
      "in 14 events per second, 3.0 errors per minute, buffer 42 percent full",
    );
    expect(
      nodeLiveSummary("transforms", nodeLive(telemetry, "by_severity")),
    ).toBe("in 16 events per second, out 16 events per second");
    expect(nodeLiveSummary("sinks", null)).toBe("no device reports it");
  });

  it("lists every step and connection with its number, as a table", () => {
    const table = liveTable(
      [
        { id: "app_logs", title: "Demo logs", kind: "sources" },
        { id: "by_severity", title: "Route", kind: "transforms" },
        { id: "new_step", title: "Remap", kind: "transforms" },
      ],
      [
        { id: "a", source: "app_logs", target: "by_severity" },
        {
          id: "b",
          source: "by_severity",
          sourceHandle: "errors",
          target: "archive",
        },
        {
          id: "c",
          source: "by_severity",
          sourceHandle: "missing",
          target: "archive",
        },
      ],
      telemetry,
    );
    expect(table.steps.map((step) => step.reading?.devices ?? null)).toEqual([
      3,
      3,
      null,
    ]);
    expect(table.connections).toEqual([
      { id: "a", from: "app_logs", to: "by_severity", rate: 15.5 },
      { id: "b", from: "by_severity.errors", to: "archive", rate: 1.1 },
      { id: "c", from: "by_severity.missing", to: "archive", rate: null },
    ]);
  });

  it("describe a step, or nothing when no device reports it", () => {
    expect(nodeLive(telemetry, "archive")).toEqual({
      received: 14.4,
      sent: null,
      errors: 3,
      dropped: null,
      filtered: null,
      buffer: 0.42,
      devices: 2,
    });
    expect(nodeLive(telemetry, "new_step")).toBeNull();
  });

  it("say which version the numbers describe, or why there are none", () => {
    expect(liveSummary(telemetry, 2)).toMatchObject({
      tone: "live",
      message: "Live for v2 · 3 devices",
    });
    expect(liveSummary(telemetry, 3).message).toBe(
      "Live for v2 · 3 devices · v3 isn't running yet",
    );
    expect(liveSummary({ ...telemetry, devices_reporting: 1 }, 2).message).toBe(
      "Live for v2 · 1 of 3 devices reporting",
    );
    expect(
      liveSummary({ ...telemetry, devices_reporting: 0, components: [] }, 2),
    ).toEqual({
      tone: "empty",
      message: "No device reports metrics for v2 yet.",
      suggestMonitoring: true,
    });
    expect(
      liveSummary(
        { devices_running: 0, devices_reporting: 0, components: [] },
        3,
      ).message,
    ).toBe("No device runs this pipeline yet. Deploy v3 to see live numbers.");
  });
});

describe("the Live choice for a pipeline", () => {
  afterEach(() => vi.unstubAllGlobals());
  const storage = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  };

  it("is remembered for each pipeline and account on its own", () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    expect(readLivePreference("ada", "orders")).toBeNull();
    writeLivePreference("ada", "orders", false);
    writeLivePreference("ada", "syslog", true);
    expect(readLivePreference("ada", "orders")).toBe(false);
    expect(readLivePreference("ada", "syslog")).toBe(true);
    // Another account in the same browser has made no choice.
    expect(readLivePreference("grace", "orders")).toBeNull();
    // A damaged value is no choice.
    local.values.set("vectory.editor.live:ada:odd", "maybe");
    expect(readLivePreference("ada", "odd")).toBeNull();
  });

  it("reads as no choice, and never throws, when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLivePreference("ada", "orders")).toBeNull();
    expect(() => writeLivePreference("ada", "orders", true)).not.toThrow();
  });
});
