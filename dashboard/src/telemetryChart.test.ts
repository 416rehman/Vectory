import { describe, expect, it } from "vitest";
import {
  bridgeSlots,
  bridgedSlots,
  formatBytes,
  formatNumber,
  formatPercent,
  isolatedPoints,
  niceMax,
  readableSlot,
  seriesPath,
  telemetryPollMs,
  timeline,
} from "./telemetryChart";
import {
  TELEMETRY_RANGES,
  TelemetryHistorySchema,
  TelemetrySummarySchema,
  describeDiagnostic,
  leadingDiagnostic,
} from "./runtimeModel";

const at = (minute: number) => new Date(minute * 60000).toISOString();

describe("telemetry timeline", () => {
  it("lays a range response on its step grid and keeps missing steps as gaps", () => {
    const start = 29_000_000; // aligned to 5-minute steps
    const points = timeline({
      step_seconds: 300,
      from: at(start),
      to: at(start + 30),
      samples: [
        { bucket: start, sampled_at: at(start + 4), events_per_second: 10 },
        {
          bucket: start + 15,
          sampled_at: at(start + 19),
          events_per_second: 0,
        },
      ],
    });
    expect(points.map((point) => point.bucket - start)).toEqual([
      0, 5, 10, 15, 20, 25,
    ]);
    expect(points.map((point) => point.sample?.events_per_second)).toEqual([
      10,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
    ]);
  });
  it("keeps the legacy raw-minute shape to at most 120 minutes", () => {
    const samples = [0, 1, 200, 202].map((offset) => ({
      bucket: 1000 + offset,
      sampled_at: at(1000 + offset),
      events_per_second: offset,
    }));
    const points = timeline({ samples });
    expect(points).toHaveLength(120);
    expect(points.at(-1)?.bucket).toBe(1202);
    expect(points.filter((point) => point.sample)).toHaveLength(2);
  });
  it("returns no points without samples or a window", () => {
    expect(timeline({ samples: [] })).toEqual([]);
  });
  it("breaks lines at gaps instead of drawing zeros", () => {
    const path = seriesPath(
      [1, 2, undefined, null, 4],
      (index) => index * 10,
      (value) => value,
    );
    expect(path).toBe("M0.00,1.00 L10.00,2.00 M40.00,4.00");
    expect(isolatedPoints([1, 2, undefined, null, 4])).toEqual([4]);
  });
  it("crosses empty slots shorter than one check-in, never longer ones", () => {
    // A 60 s heartbeat with jitter can skip one 1-minute slot, not two.
    expect(bridgeSlots(60, 60)).toBe(1);
    expect(bridgeSlots(10, 60)).toBe(0);
    expect(bridgeSlots(300, 60)).toBe(6);
    expect(bridgeSlots(60, 300)).toBe(0);
    expect(bridgeSlots(Number.NaN, 60)).toBe(0);
    const values = [1, undefined, 3, undefined, undefined, 6, 7];
    const x = (index: number) => index * 10,
      y = (value: number) => value;
    expect(seriesPath(values, x, y, 1)).toBe(
      "M0.00,1.00 L20.00,3.00 M50.00,6.00 L60.00,7.00",
    );
    expect(seriesPath(values, x, y, 2)).toBe(
      "M0.00,1.00 L20.00,3.00 L50.00,6.00 L60.00,7.00",
    );
    expect(isolatedPoints([5, undefined, undefined, 8], 1)).toEqual([0, 3]);
    expect(isolatedPoints([5, undefined, 8], 1)).toEqual([]);
  });
  it("reads a bridged slot from its nearest report and skips it by key", () => {
    const reported = [true, false, false, true, false, false, false, true];
    const bridged = bridgedSlots(reported, 2);
    expect(bridged).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(readableSlot(1, reported, bridged)).toBe(0);
    expect(readableSlot(2, reported, bridged)).toBe(3);
    expect(readableSlot(2, reported, bridged, -1)).toBe(0);
    expect(readableSlot(1, reported, bridged, 1)).toBe(3);
    // A real gap stays readable as "no report".
    expect(readableSlot(5, reported, bridged)).toBe(5);
  });
  it("scales axes to clean maxima and formats readings", () => {
    expect([0, 0.3, 1, 1.2, 3, 7, 12, 480].map(niceMax)).toEqual([
      1, 0.5, 1, 2, 5, 10, 20, 500,
    ]);
    expect(formatPercent(0.0042)).toBe("0.4%");
    expect(formatPercent(0.0001)).toBe("<0.1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.87)).toBe("87%");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatNumber(12.345)).toBe((12.35).toLocaleString());
  });
});

describe("runtime contract shapes", () => {
  it("accepts ranged history up to 360 points and rejects more", () => {
    const samples = Array.from({ length: 360 }, (_, index) => ({
      bucket: index,
      sampled_at: at(index),
      samples: 1,
      events_per_second: 1,
      buffer_utilization: 0.5,
    }));
    expect(
      TelemetryHistorySchema.safeParse({
        device_id: "d",
        range: "6h",
        step_seconds: 60,
        from: at(0),
        to: at(360),
        samples,
      }).success,
    ).toBe(true);
    expect(
      TelemetryHistorySchema.safeParse({
        device_id: "d",
        samples: [...samples, samples[0]],
      }).success,
    ).toBe(false);
    expect(
      TelemetryHistorySchema.safeParse({
        device_id: "d",
        samples: [{ sampled_at: at(0), buffer_utilization: 2 }],
      }).success,
    ).toBe(false);
  });
  it("keeps missing fleet totals null rather than zero", () => {
    const summary = TelemetrySummarySchema.parse({
      generated_at: at(10),
      range: "1h",
      step_seconds: 60,
      from: at(0),
      devices_total: 3,
      devices_reporting: 0,
      devices_metrics_disabled: 1,
      devices_without_metrics_endpoint: 2,
      fresh_seconds: 180,
      newest_sample_at: null,
      events_in_per_second: null,
      events_out_per_second: null,
      bytes_in_per_second: null,
      bytes_out_per_second: null,
      errors_per_minute: null,
      filtered_per_minute: null,
      dropped_per_minute: null,
      buffer_utilization_max: null,
      coverage: { events_in_per_second: 0 },
      series: [],
    });
    expect(summary.events_in_per_second).toBeNull();
  });
  it("explains the leading error finding with its location and fix", () => {
    const warning = {
      severity: "warning" as const,
      code: "OUTPUT_UNUSED",
      message: "Nothing reads the output of app.",
    };
    const error = {
      severity: "error" as const,
      code: "VRL_E103",
      component_id: "tag",
      line: 2,
      column: 16,
      message: "Unhandled fallible assignment",
      hint: "Try: .status_code, err = to_int(.status)",
    };
    expect(leadingDiagnostic([warning, error])).toBe(error);
    expect(leadingDiagnostic([warning])).toBe(warning);
    expect(describeDiagnostic(error)).toBe(
      "Unhandled fallible assignment (tag, line 2, column 16). Try: .status_code, err = to_int(.status).",
    );
    expect(describeDiagnostic({ ...warning, message: "Cut short…" })).toBe(
      "Cut short…",
    );
  });
});

describe("how often a range's history is read", () => {
  it("polls an hour quickly, a day every minute and a week every five", () => {
    expect(telemetryPollMs["1h"]).toBe(15_000);
    expect(telemetryPollMs["24h"]).toBe(60_000);
    expect(telemetryPollMs["7d"]).toBe(300_000);
  });
  it("never polls a longer range faster, and covers every range", () => {
    const every = TELEMETRY_RANGES.map((range) => telemetryPollMs[range]);
    expect(every.every((ms) => Number.isInteger(ms) && ms >= 15_000)).toBe(
      true,
    );
    expect(every).toEqual([...every].sort((a, b) => a - b));
  });
});
