import { describe, expect, it } from "vitest";
import {
  completeSeries,
  checklist,
  countLabel,
  formatRate,
  healthLabels,
  healthOrder,
  healthStates,
  monitoringTarget,
  niceCeiling,
  quietSummary,
  runningGroups,
  runningNotes,
  runningRate,
  telemetryFromCounts,
  unmanagedDetail,
} from "./overviewModel";
import { deviceStatuses } from "./status";
import type { OverviewCounts, OverviewRunning } from "./api";

describe("fleet health buckets", () => {
  it("names every bucket and the device states it stands for", () => {
    // The server counts the buckets; these are the words and links for them.
    expect(healthOrder).toHaveLength(8);
    for (const bucket of healthOrder) {
      expect(healthLabels[bucket]).toBeTruthy();
      expect(healthStates[bucket].length).toBeGreaterThan(0);
      for (const state of healthStates[bucket])
        expect(Object.keys(deviceStatuses)).toContain(state);
    }
    // "Failing" stands for every way an apply can end badly.
    expect(healthStates.failed).toEqual(["failed", "rolled_back", "conflict"]);
    expect(healthStates.degraded).toEqual(["degraded"]);
  });
});

describe("fleet telemetry", () => {
  const telemetry = (
    extra: Partial<OverviewCounts["telemetry"]> = {},
  ): OverviewCounts["telemetry"] => ({
    eligible: 5,
    reporting: 3,
    stale: 1,
    disabled: 0,
    events_in_per_second: 200.5,
    events_in_devices: 2,
    events_out_per_second: null,
    events_out_devices: 0,
    errors: 2,
    errors_per_minute: null,
    newest_sample_at: "2026-09-29T02:59:55.000Z",
    ...extra,
  });

  it("reads what the server summed, with coverage and the busiest devices", () => {
    const summary = telemetryFromCounts(telemetry(), [
      {
        id: "a",
        name: "a",
        events_in_per_second: 120.5,
        events_out_per_second: null,
      },
      {
        id: "b",
        name: "b",
        events_in_per_second: 80,
        events_out_per_second: 79,
      },
    ]);
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
      freshest: "2026-09-29T02:59:55.000Z",
    });
    expect(summary.top).toEqual([
      { id: "a", name: "a", eventsPerSecond: 120.5, eventsOutPerSecond: null },
      { id: "b", name: "b", eventsPerSecond: 80, eventsOutPerSecond: 79 },
    ]);
  });

  it("keeps missing telemetry missing instead of zero", () => {
    const summary = telemetryFromCounts(
      telemetry({
        reporting: 0,
        events_in_per_second: null,
        events_in_devices: 0,
        errors: null,
        newest_sample_at: null,
      }),
      [],
    );
    expect(summary.reporting).toBe(0);
    expect(summary.eventsPerSecond).toBeNull();
    expect(summary.errors).toBeNull();
    expect(summary.freshest).toBeNull();
    // A real zero from a reporting device stays zero.
    expect(
      telemetryFromCounts(telemetry({ events_in_per_second: 0 }), [])
        .eventsPerSecond,
    ).toBe(0);
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

describe("delivery Vectory can and can't measure", () => {
  it("says so in the quiet summary only where delivery goes unmeasured", () => {
    expect(quietSummary(2)).toBe("Nothing is failing that Vectory can measure");
    expect(quietSummary(0)).toBe("Nothing is failing");
  });
  const row = (
    id: string,
    name: string | null,
    devices: number,
    reporting: number,
  ) => ({
    configuration_id: id,
    configuration_name: name,
    device_count: devices,
    devices_reporting: reporting,
  });
  it("offers monitoring for the pipeline most running devices have no metrics from", () => {
    expect(
      monitoringTarget([
        row("p1", "Orders", 4, 4),
        // Two versions of one pipeline: their silent devices add up.
        row("p2", "Web", 3, 1),
        row("p2", "Web", 2, 1),
        row("p3", "Audit", 2, 1),
      ]),
    ).toEqual({ id: "p2", name: "Web", count: 3 });
    // Every running device reports, or the silent ones run no named pipeline.
    expect(monitoringTarget([row("p1", "Orders", 2, 2)])).toBeNull();
    expect(monitoringTarget([row("p1", null, 2, 0)])).toBeNull();
    expect(monitoringTarget([])).toBeNull();
  });
  it("says what runs on devices without a pipeline", () => {
    expect(unmanagedDetail(1, 0)).toBe(
      "Vector starts on it when you deploy a pipeline.",
    );
    expect(unmanagedDetail(2, 0)).toBe(
      "Vector starts on them when you deploy a pipeline.",
    );
    expect(unmanagedDetail(1, 1)).toBe(
      "A local configuration adopted at setup keeps running until you deploy one.",
    );
    expect(unmanagedDetail(3, 3)).toBe(
      "Local configurations adopted at setup keep running until you deploy one.",
    );
    expect(unmanagedDetail(3, 1)).toBe(
      "1 runs a local configuration adopted at setup until you deploy one; Vector starts on the others when you deploy.",
    );
    expect(unmanagedDetail(4, 2)).toBe(
      "2 run a local configuration adopted at setup until you deploy one; Vector starts on the others when you deploy.",
    );
  });
});

describe("what runs where", () => {
  const running = (extra: Partial<OverviewRunning> = {}): OverviewRunning => ({
    configuration_id: "c1",
    configuration_name: "Edge syslog processing",
    version_id: "v1",
    version: 1,
    device_count: 3,
    devices_reporting: 3,
    groups: [{ id: "g1", name: "Edge collectors", device_count: 3 }],
    more_groups: 0,
    events_in_per_second: 14,
    events_out_per_second: 4.5,
    state: "running",
    not_delivering: 0,
    canary: null,
    ...extra,
  });

  it("lists the groups a version runs in, each leading to that version's devices there", () => {
    expect(runningGroups(running({ groups: [], more_groups: 0 }))).toEqual({
      chips: [],
      more: 0,
    });
    expect(
      runningGroups(
        running({
          version_id: "v 1",
          groups: [
            { id: "g1", name: "Edge collectors", device_count: 3 },
            { id: "g2", name: "Web tier", device_count: 1 },
          ],
          more_groups: 4,
        }),
      ),
    ).toEqual({
      chips: [
        {
          id: "g1",
          name: "Edge collectors",
          count: 3,
          href: "#/devices?running=v%201&group=g1",
        },
        {
          id: "g2",
          name: "Web tier",
          count: 1,
          href: "#/devices?running=v%201&group=g2",
        },
      ],
      more: 4,
    });
  });

  it("shows events in and out, never a zero for an unknown rate", () => {
    expect(runningRate(running())).toBe("14.0 → 4.5/s");
    expect(runningRate(running({ events_out_per_second: null }))).toBe(
      "14.0/s in",
    );
    expect(runningRate(running({ events_in_per_second: null }))).toBe(
      "4.5/s out",
    );
    expect(
      runningRate(
        running({ events_in_per_second: null, events_out_per_second: null }),
      ),
    ).toBeNull();
    // A real zero from reporting devices stays a zero.
    expect(
      runningRate(
        running({ events_in_per_second: 0, events_out_per_second: 0 }),
      ),
    ).toBe("0 → 0/s");
  });

  it("says nothing extra about a version that simply runs", () => {
    expect(runningNotes(running())).toEqual([]);
  });

  it("names devices that aren't delivering and the canary that is measuring", () => {
    expect(
      runningNotes(
        running({
          state: "not_delivering",
          not_delivering: 1,
          canary: {
            deployment_id: "d1",
            phase: "measuring",
            device_count: 1,
            device_names: ["edge-nyc-02"],
          },
        }),
      ),
    ).toEqual([
      {
        text: "1 not delivering",
        tone: "danger",
        href: "#/devices?running=v1&status=degraded",
      },
      {
        text: "canary on edge-nyc-02 · measuring delivery",
        tone: "info",
        href: "#/deployments/d1",
      },
    ]);
  });

  it("says where a canary runs however many devices it holds", () => {
    const canary = (count: number, names: string[]) =>
      runningNotes(
        running({
          state: "canary",
          canary: {
            deployment_id: "d1",
            phase: "observing",
            device_count: count,
            device_names: names,
          },
        }),
      )[0].text;
    expect(canary(2, ["edge-1", "edge-2"])).toBe(
      "canary on edge-1 and edge-2 · observing for problems",
    );
    expect(canary(7, ["edge-1", "edge-2", "edge-3"])).toBe(
      "canary on 7 devices · observing for problems",
    );
  });
});
