import { describe, expect, it } from "vitest";
import {
  completeSeries,
  checklist,
  countLabel,
  fleetTelemetry,
  formatRate,
  niceCeiling,
  healthBucket,
  healthCounts,
  rolloutProgress,
} from "./overviewModel";

const now = Date.parse("2026-09-29T03:00:00.000Z");
const at = (secondsAgo: number) =>
  new Date(now - secondsAgo * 1000).toISOString();

describe("fleet health buckets", () => {
  it("places every device in one bucket and leaves revoked identities out", () => {
    const devices = [
      { status: "verified" },
      { status: "verified" },
      { status: "applying" },
      { status: "failed" },
      { status: "rolled_back" },
      { status: "verification_unknown" },
      { status: "offline" },
      { status: "paused", sync_paused: true, pause_acknowledged: false },
      { status: "unmanaged" },
      { status: "revoked" },
    ];
    const { counts, total } = healthCounts(devices);
    expect(total).toBe(9);
    expect(counts).toEqual({
      applied: 2,
      updating: 1,
      check: 1,
      failed: 2,
      offline: 1,
      paused: 1,
      unmanaged: 1,
    });
    expect(healthBucket({ status: "revoked" })).toBeNull();
  });

  it("never reads a new, unknown state as healthy", () => {
    expect(healthBucket({ status: "adopted_elsewhere" })).toBe("updating");
  });

  it("counts a device that never checked in as not connected", () => {
    expect(healthBucket({ status: "awaiting_first_check_in" })).toBe("offline");
  });
});

describe("fleet telemetry", () => {
  const device = (
    id: string,
    secondsAgo: number | null,
    events?: number | null,
    errors?: number | null,
    status = "verified",
  ) => ({
    id,
    name: id,
    status,
    telemetry:
      secondsAgo === null
        ? undefined
        : { sampled_at: at(secondsAgo), events_per_second: events, errors },
  });

  it("sums only fresh samples and reports coverage", () => {
    const summary = fleetTelemetry(
      [
        device("a", 10, 120.5, 2),
        device("b", 30, 80, 0),
        device("c", 600, 999, 50),
        device("d", null),
        device("e", 5, null, null),
        device("f", 5, 1000, 1, "revoked"),
      ],
      now,
    );
    expect(summary).toMatchObject({
      eligible: 5,
      reporting: 3,
      stale: 1,
      eventsPerSecond: 200.5,
      rateDevices: 2,
      errors: 2,
      // Older agents report neither delivery nor error rates.
      eventsOutPerSecond: null,
      errorsPerMinute: null,
    });
    expect(summary.top.map((item) => item.id)).toEqual(["a", "b"]);
    expect(summary.freshest).toBe(at(5));
  });

  it("adds delivery and error rates when agents report them", () => {
    const summary = fleetTelemetry(
      [
        {
          id: "a",
          name: "a",
          status: "verified",
          telemetry: {
            sampled_at: at(3),
            events_per_second: 10,
            events_out_per_second: 9.5,
            errors_per_minute: 1.5,
          },
        },
        {
          id: "b",
          name: "b",
          status: "verified",
          effective_policy: { telemetry_enabled: false },
        },
      ],
      now,
    );
    expect(summary).toMatchObject({
      eventsOutPerSecond: 9.5,
      outDevices: 1,
      errorsPerMinute: 1.5,
      disabled: 1,
    });
  });

  it("keeps missing telemetry missing instead of zero", () => {
    const summary = fleetTelemetry(
      [device("a", null), device("b", 900, 5)],
      now,
    );
    expect(summary.reporting).toBe(0);
    expect(summary.eventsPerSecond).toBeNull();
    expect(summary.errors).toBeNull();
    // A real zero from a reporting device stays zero.
    expect(fleetTelemetry([device("z", 1, 0, 0)], now).eventsPerSecond).toBe(0);
  });
});

describe("rollout progress", () => {
  it("splits target states into verified, in flight, waiting and problems", () => {
    expect(
      rolloutProgress({
        verified_applied: 3,
        desired: 1,
        written: 1,
        pending: 2,
        failed: 1,
        rolled_back: 1,
        verification_unknown: 1,
        removed: 4,
      }),
    ).toEqual({
      total: 10,
      verified: 3,
      inFlight: 2,
      waiting: 2,
      attention: 1,
      failed: 2,
    });
    expect(rolloutProgress({}).total).toBe(0);
  });
});

describe("first-run checklist", () => {
  it("is driven by real state and completes step by step", () => {
    const empty = checklist({
      releases: 0,
      devices: 0,
      checkedIn: 0,
      pipelines: 0,
      versions: 0,
      applied: 0,
    });
    expect(empty.every((step) => !step.done)).toBe(true);
    const connected = checklist({
      releases: null,
      devices: 1,
      checkedIn: 1,
      pipelines: 1,
      versions: 0,
      applied: 0,
    });
    expect(connected.map((step) => step.done)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("number formatting", () => {
  it("keeps small rates precise and large ones compact", () => {
    expect(formatRate(0)).toBe("0");
    expect(formatRate(0.395)).toBe("0.40");
    expect(formatRate(4.943)).toBe("4.9");
    expect(formatRate(1284.4)).toBe("1,284");
    expect(formatRate(12345)).toBe("12.3K");
    expect(countLabel(1, "device")).toBe("1 device");
    expect(countLabel(3, "device")).toBe("3 devices");
  });

  it("rounds axis maxima up to a readable step", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(4.2)).toBe(5);
    expect(niceCeiling(12)).toBe(20);
    expect(niceCeiling(2400)).toBe(2500);
  });
});

describe("fleet series", () => {
  const minute = (m: number, devices: number | null = 4) => ({
    at: new Date(Date.UTC(2026, 8, 29, 8, m)).toISOString(),
    devices,
  });
  const at = (m: number, s = 0) => Date.UTC(2026, 8, 29, 8, m, s);

  it("leaves out the bucket that is still collecting", () => {
    const series = [minute(24), minute(25), minute(26, 1)];
    // 08:26:06: the 08:26 bucket has heard from one device of four.
    expect(completeSeries(series, at(26, 6))).toEqual(series.slice(0, 2));
  });

  it("keeps a complete newest bucket", () => {
    const series = [minute(24), minute(25), minute(26)];
    expect(completeSeries(series, at(27, 1))).toEqual(series);
  });

  it("waits briefly for late devices, then shows a real drop", () => {
    const series = [minute(24), minute(25), minute(26, 2)];
    expect(completeSeries(series, at(27, 10))).toHaveLength(2);
    // A device that stays silent is a real drop once the grace passes.
    expect(completeSeries(series, at(28, 1))).toHaveLength(3);
  });

  it("does not mistake a gap in the data for a bucket still collecting", () => {
    // 08:20, then nothing until 08:26: the 08:26 bucket ended at 08:27.
    const series = [minute(20), minute(26)];
    expect(completeSeries(series, at(28))).toEqual(series);
    expect(completeSeries(series, at(26, 30))).toEqual(series.slice(0, 1));
    // A wider bucket stays open until it has ended.
    expect(completeSeries(series, at(28), 5 * 60_000)).toHaveLength(1);
  });

  it("keeps short or malformed series as they are", () => {
    expect(completeSeries([minute(26, 1)], at(26, 6))).toHaveLength(1);
    const bad = [
      { at: "x", devices: 1 },
      { at: "y", devices: 1 },
    ];
    expect(completeSeries(bad, at(26))).toEqual(bad);
  });
});
