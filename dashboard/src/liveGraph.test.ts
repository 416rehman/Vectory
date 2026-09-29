import { describe, expect, it } from "vitest";
import {
  edgeRate,
  edgeWidth,
  formatRate,
  liveSummary,
  nodeLive,
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
    expect(edgeWidth(null)).toBe(1.5);
    expect(edgeWidth(1_000_000)).toBe(4.5);
    expect(edgeWidth(10)).toBeGreaterThan(edgeWidth(1));
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
