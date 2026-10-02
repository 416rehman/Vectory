import { describe, expect, it } from "vitest";
import {
  bridgeSlots,
  bridgedSlots,
  defaultRange,
  fitAxis,
  formatBytes,
  formatTick,
  formatNumber,
  formatPercent,
  isolatedPoints,
  lastSlots,
  niceMax,
  readableSlot,
  seriesPath,
  spanLabel,
  telemetryPollMs,
  timeline,
  wholeNumbers,
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
    // The same steps for the device charts and the Overview's.
    expect([2.2, 4.2, 2400, Number.NaN].map(niceMax)).toEqual([
      2.5, 5, 2500, 1,
    ]);
    expect(
      [0, 0.5, 1.25, 12, 123456].map((value) => formatTick(value)),
    ).toEqual(["0", "0.5", "1.25", "12", "123.5K"]);
    expect(formatTick(1 / 3)).toBe("0.33");
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
    // A finding that already names its component says it once.
    expect(
      describeDiagnostic({
        severity: "error",
        code: "NETWORK_DESTINATION_DENIED",
        component_id: "out",
        message:
          'Sink "out" (http) sends to 127.0.0.1:8239, which this host hasn\'t approved.',
        hint: "Allow it on the host, with the agent stopped: vectory allow --network 127.0.0.1:8239. Or deploy to a full-mode device.",
      }),
    ).toBe(
      'Sink "out" (http) sends to 127.0.0.1:8239, which this host hasn\'t approved. Allow it on the host, with the agent stopped: vectory allow --network 127.0.0.1:8239. Or deploy to a full-mode device.',
    );
  });
});

describe("a young device's charts", () => {
  const start = 29_849_420; // minutes
  const minute = 60_000;
  const history = (reported: number[], from = start, to = start + 60) => ({
    step_seconds: 60,
    from: at(from),
    to: at(to),
    samples: reported.map((bucket) => ({
      bucket,
      sampled_at: at(bucket),
      events_per_second: 5,
    })),
  });

  it("leaves out the slot that is still collecting", () => {
    // Twenty-five seconds into the minute that holds the newest report.
    const now = (start + 59) * minute + 25_000;
    const all = timeline(history([start + 55, start + 56, start + 59]));
    expect(all.at(-1)?.bucket).toBe(start + 59);
    const complete = timeline(
      history([start + 55, start + 56, start + 59]),
      120,
      { now },
    );
    expect(complete.at(-1)?.bucket).toBe(start + 58);
    // A late check-in still has a few seconds to land in the slot it belongs to.
    expect(
      timeline(history([start + 58]), 120, {
        now: (start + 59) * minute + 5_000,
      }).at(-1)?.bucket,
    ).toBe(start + 57);
    // Five-minute slots stay open for the whole slot.
    const slow = {
      step_seconds: 300,
      from: at(start),
      to: at(start + 30),
      samples: [{ bucket: start + 25, sampled_at: at(start + 27) }],
    };
    expect(
      timeline(slow, 120, { now: (start + 28) * minute }).at(-1)?.bucket,
    ).toBe(start + 20);
  });

  it("starts a young device's chart when the device did", () => {
    const enrolled = (start + 52) * minute + 20_000;
    const points = timeline(history([start + 53, start + 54]), 120, {
      notBefore: enrolled,
      now: (start + 58) * minute,
    });
    // The slot the device enrolled in is the first one that could report.
    expect(points[0].bucket).toBe(start + 52);
    expect(points.at(-1)?.bucket).toBe(start + 56);
    expect(points.filter((point) => point.sample)).toHaveLength(2);
    // Without a creation time, the whole window stays.
    expect(timeline(history([]), 120, { notBefore: null })).toHaveLength(60);
  });

  it("keeps the newest slots of a longer read", () => {
    const points = timeline(history([start + 59]));
    expect(lastSlots(points, 15)).toHaveLength(15);
    expect(lastSlots(points, 15).at(-1)).toBe(points.at(-1));
    expect(lastSlots(points.slice(0, 5), 15)).toHaveLength(5);
  });

  it("opens on 15 minutes until 15 minutes of history exist, then on an hour", () => {
    const now = (start + 60) * minute;
    const first = (offset: number) => [
      { bucket: start + offset, sample: {} as never },
    ];
    expect(defaultRange(first(53), now)).toBe("15m");
    expect(defaultRange(first(45), now)).toBe("15m");
    expect(defaultRange(first(44), now)).toBe("1h");
    expect(defaultRange(first(0), now)).toBe("1h");
    // Nothing reported yet: the shortest window, and the empty state explains.
    expect(defaultRange([{ bucket: start, sample: undefined }], now)).toBe(
      "15m",
    );
  });

  it("names the span the data covers", () => {
    expect(spanLabel(0, 40_000)).toBe("Last minute");
    expect(spanLabel(0, 4 * minute)).toBe("Last 4 minutes");
    expect(spanLabel(0, 40 * minute)).toBe("Last 40 minutes");
    // A window that is the range asked for reads as the range.
    expect(spanLabel(0, 58 * minute)).toBe("Last hour");
    expect(spanLabel(0, 60 * minute)).toBe("Last hour");
    expect(spanLabel(0, 75 * minute)).toBe("Last 75 minutes");
    expect(spanLabel(0, 90 * minute)).toBe("Last 2 hours");
    expect(spanLabel(0, 6 * 60 * minute)).toBe("Last 6 hours");
    expect(spanLabel(0, 3 * 24 * 60 * minute)).toBe("Last 3 days");
  });

  it("fits whole-number counts to whole-number ticks", () => {
    expect(fitAxis(0, true)).toEqual({ max: 2, ticks: [0, 1, 2] });
    expect(fitAxis(1, true).ticks).toEqual([0, 1, 2]);
    expect(fitAxis(3, true).ticks).toEqual([0, 2, 4]);
    expect(fitAxis(7, true).max).toBe(8);
    expect(fitAxis(10, true).ticks).toEqual([0, 5, 10]);
    expect(fitAxis(11, true).ticks).toEqual([0, 10, 20]);
    expect(fitAxis(30, true).ticks).toEqual([0, 25, 50]);
    // 25 would leave 12.5 in the middle.
    expect(fitAxis(21, true).ticks).toEqual([0, 25, 50]);
    expect(fitAxis(240, true).ticks).toEqual([0, 125, 250]);
    // Rates keep the round maxima.
    expect(fitAxis(0.3, false).ticks).toEqual([0, 0.25, 0.5]);
    expect(fitAxis(0, false).max).toBe(1);
    expect(fitAxis(Number.NaN, false).max).toBe(1);
    expect(fitAxis(4.9, false).ticks).toEqual([0, 2.5, 5]);
    expect(wholeNumbers([0, 3, null, undefined, 12])).toBe(true);
    expect(wholeNumbers([0, 0.5])).toBe(false);
    expect(wholeNumbers([])).toBe(true);
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
