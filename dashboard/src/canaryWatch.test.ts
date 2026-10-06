import { describe, expect, it } from "vitest";
import type { CanaryWatch, CanaryWatchDevice, RolloutLane } from "./api";
import type { CanaryGate } from "./canaryGateModel";
import {
  earlyRelease,
  gateHeadline,
  nameList,
  watchRows,
  watchWindow,
} from "./canaryWatch";

const reasons = {
  superseded: 0,
  stale: 0,
  paused: 0,
  unverified: 0,
  unavailable: 0,
  measuring: 0,
  degraded: 0,
};
const gate = (over: Partial<CanaryGate> = {}): CanaryGate => ({
  state: "waiting",
  released_count: 1,
  verified_count: 0,
  pending_count: 2,
  reasons,
  observation_started_at: null,
  observation_seconds: 3600,
  evaluated_at: "2026-09-27T12:00:00Z",
  ...over,
});
const reading = {
  sampled_at: "2026-09-27T12:00:00Z",
  events_in_per_second: 5,
  events_out_per_second: 4.9,
  errors_per_minute: 0,
  buffer_utilization: 0.02,
};
const device = (
  name: string | null,
  over: Partial<CanaryWatchDevice> = {},
): CanaryWatchDevice => ({
  device_id: `00000000-0000-4000-8000-00000000000${name?.slice(-1) ?? "0"}`,
  device_name: name,
  released_at: "2026-09-27T11:50:00Z",
  gate_reason: null,
  now: reading,
  baseline: { ...reading, minutes: 10, events_in_per_second: 5.5 },
  samples: { measured: 3, needed: 3 },
  ...over,
});
const watch = (...devices: CanaryWatchDevice[]): CanaryWatch => ({
  window_seconds: 600,
  evaluated_at: "2026-09-27T12:00:00Z",
  devices,
  more: 0,
});
const measuring = (name: string, measured: number) =>
  device(name, { gate_reason: "measuring", samples: { measured, needed: 3 } });

describe("naming devices in a sentence", () => {
  it("names one, two, or one and the rest, and counts unnamed ones", () => {
    expect(nameList(["edge-nyc-02"], 1)).toBe("edge-nyc-02");
    expect(nameList(["edge-nyc-02", "edge-nyc-03"], 2)).toBe(
      "edge-nyc-02 and edge-nyc-03",
    );
    expect(nameList(["edge-nyc-02", "edge-nyc-03"], 5)).toBe(
      "edge-nyc-02 and 4 more",
    );
    expect(nameList([], 1, "released device")).toBe("1 released device");
    expect(nameList([], 3, "released device")).toBe("3 released devices");
    expect(nameList(["edge-nyc-02"], 0)).toBe("");
  });
});

describe("the canary gate headline", () => {
  it("says what is measured, on which device and how far along", () => {
    const one = gateHeadline(
      gate({ reasons: { ...reasons, measuring: 1 } }),
      watch(measuring("edge-nyc-02", 2)),
    );
    expect(one.title).toBe(
      "Measuring delivery on edge-nyc-02 (2 of 3 samples)",
    );
    expect(one.detail).toContain("telemetry samples");
    expect(one.listed).toEqual([]);
    // Several devices: the one furthest behind sets the count.
    const two = gateHeadline(
      gate({ released_count: 2, reasons: { ...reasons, measuring: 2 } }),
      watch(measuring("edge-nyc-02", 2), measuring("edge-nyc-03", 1)),
    );
    expect(two.title).toBe(
      "Measuring delivery on edge-nyc-02 and edge-nyc-03 (1 of 3 samples)",
    );
  });
  it("counts devices when the lanes have not named them, and never invents samples", () => {
    expect(
      gateHeadline(gate({ reasons: { ...reasons, measuring: 1 } })).title,
    ).toBe("Measuring delivery on 1 released device");
    // A named device with no sample count (metrics off) adds no fraction.
    expect(
      gateHeadline(
        gate({ reasons: { ...reasons, measuring: 1 } }),
        watch(
          device("edge-nyc-02", { gate_reason: "measuring", samples: null }),
        ),
      ).title,
    ).toBe("Measuring delivery on edge-nyc-02");
  });
  it("names the device for every other reason and lists reasons only when several apply", () => {
    const named = (reason: string) =>
      watch(device("edge-nyc-02", { gate_reason: reason }));
    const title = (reason: keyof typeof reasons) =>
      gateHeadline(
        gate({ reasons: { ...reasons, [reason]: 1 } }),
        named(reason),
      ).title;
    expect(title("unverified")).toBe("Waiting for edge-nyc-02 to apply");
    expect(title("stale")).toBe("Waiting for edge-nyc-02 to check in");
    expect(title("paused")).toBe("Sync is paused on edge-nyc-02");
    expect(title("degraded")).toBe("edge-nyc-02 applied but isn't delivering");
    expect(title("superseded")).toBe(
      "Another assignment is effective on edge-nyc-02",
    );
    expect(title("unavailable")).toBe("edge-nyc-02 was revoked or replaced");
    const both = gateHeadline(
      gate({
        released_count: 2,
        reasons: { ...reasons, unverified: 1, measuring: 1 },
      }),
      watch(
        device("edge-nyc-02", { gate_reason: "unverified" }),
        measuring("edge-nyc-03", 1),
      ),
    );
    // What must happen first leads; both are listed with their counts.
    expect(both.title).toBe("Waiting for edge-nyc-02 to apply");
    expect(both.listed).toEqual(["unverified", "measuring"]);
    expect(
      gateHeadline(
        gate({ released_count: 3, reasons: { ...reasons, degraded: 2 } }),
      ).title,
    ).toBe("2 released devices applied but aren't delivering");
  });
  it("keeps observing, paused and first-release states short and consistent with the lanes", () => {
    const observing = gateHeadline(
      gate({
        state: "observing",
        verified_count: 1,
        observation_started_at: "2026-09-27T11:59:00Z",
      }),
    );
    expect(observing.title).toBe("Observation in progress");
    // The gate reports what it checked; it promises no release time.
    expect(observing.detail).toContain("keeps checking");
    expect(observing.detail).not.toMatch(/will be released|complete[sd]? in/i);
    expect(gateHeadline(gate({ state: "paused" })).title).toBe(
      "Rollout paused",
    );
    expect(
      gateHeadline(gate({ released_count: 0, pending_count: 3 })).detail,
    ).toBe("3 devices are waiting for release.");
    // Applied everywhere, observation not started: the next server check.
    expect(gateHeadline(gate({ verified_count: 1 })).title).toBe(
      "Waiting for the next rollout check",
    );
  });
  it("never words an applied device as unverified: no headline mentions verification", () => {
    for (const reason of Object.keys(reasons) as (keyof typeof reasons)[]) {
      const { title, detail } = gateHeadline(
        gate({ reasons: { ...reasons, [reason]: 1 } }),
      );
      expect(`${title} ${detail}`).not.toMatch(/currently verified/i);
    }
  });
});

describe("the canary's delivery beside its baseline", () => {
  it("shows now and before for each metric, per device", () => {
    const [row] = watchRows(
      watch(
        device("edge-nyc-02", {
          baseline: {
            minutes: 10,
            events_in_per_second: 5.5,
            events_out_per_second: 5.4,
            errors_per_minute: 0,
            buffer_utilization: 0.01,
          },
        }),
      ),
    );
    expect(row.name).toBe("edge-nyc-02");
    expect(row.events.now).toBe("5.0 → 4.9");
    expect(row.events.before).toBe("5.5 → 5.4");
    expect(row.errors.now).toBe("0");
    expect(row.errors.before).toBe("0");
    expect(row.buffer.now).toBe("2.0%");
    expect(row.buffer.before).toBe("1.0%");
    expect(row.noBaseline).toBe(false);
    expect(row.noReading).toBeNull();
    expect(row.events.speech).toBe(
      "5.0 in and 4.9 out events per second now, 5.5 in and 5.4 out events per second before release",
    );
  });
  it("says there is no baseline yet instead of showing a zero", () => {
    const [row] = watchRows(watch(device("edge-nyc-02", { baseline: null })));
    expect(row.noBaseline).toBe(true);
    expect(row.events.before).toBeNull();
    expect(row.errors.before).toBeNull();
    expect(row.buffer.before).toBeNull();
    expect(row.events.speech).toContain("no baseline yet");
    expect(row.events.before).not.toBe("0");
  });
  it("says why there is no current reading, and never a zero", () => {
    const [stale] = watchRows(watch(device("edge-nyc-02", { now: null })));
    expect(stale.noReading).toBe("No recent reading");
    expect(stale.events.now).toBe("—");
    expect(stale.events.speech).toContain("no current reading");
    const [off] = watchRows(
      watch(device("edge-nyc-02", { now: null, samples: null })),
    );
    expect(off.noReading).toBe("Metrics are off");
    // A sample whose values are all missing shows dashes, not zeros.
    const [empty] = watchRows(
      watch(
        device("edge-nyc-02", {
          now: {
            sampled_at: "2026-09-27T12:00:00Z",
            events_in_per_second: null,
            events_out_per_second: null,
            errors_per_minute: null,
            buffer_utilization: null,
          },
        }),
      ),
    );
    expect(empty.events.now).toBe("— → —");
    expect(empty.errors.now).toBe("—");
    expect(empty.buffer.now).toBe("—");
  });
  it("notes what the gate makes of each device, and the baseline window", () => {
    const rows = watchRows(
      watch(
        measuring("edge-nyc-02", 2),
        device("edge-nyc-03", { gate_reason: "unverified" }),
        device("edge-nyc-04", { gate_reason: "degraded" }),
        device("edge-nyc-05"),
      ),
    );
    expect(rows.map((row) => row.note)).toEqual([
      "Measuring delivery · 2 of 3 samples",
      "Waiting to apply",
      "Not delivering",
      null,
    ]);
    expect(watchWindow(watch())).toBe("10 minutes");
    expect(watchRows(null)).toEqual([]);
  });
});

const lane = (over: Partial<RolloutLane> = {}): RolloutLane => ({
  kind: "canary",
  index: 0,
  state: "in_progress",
  released_at: "2026-09-27T11:50:00Z",
  verified_at: null,
  size: 1,
  counts: { verified_applied: 1 },
  devices: [
    { device_id: "a", device_name: "edge-nyc-02", state: "verified_applied" },
  ],
  more: 0,
  ...over,
});
const queued = (size: number, index = 1): RolloutLane =>
  lane({
    kind: "batch",
    index,
    state: "queued",
    released_at: null,
    size,
    counts: { pending: size },
    devices: [],
  });

describe("releasing the next stage early", () => {
  it("is offered while the delivery check is still measuring, naming who", () => {
    const early = earlyRelease({
      status: "active",
      gate: gate({ reasons: { ...reasons, measuring: 1 } }),
      lanes: [lane(), queued(2)],
      watch: watch(measuring("edge-nyc-02", 2)),
    });
    expect(early).toEqual({
      next: 2,
      waiting: 2,
      skipping: "measuring",
      subject: "edge-nyc-02",
    });
  });
  it("is offered during observation, and says how many wait beyond the next stage", () => {
    const early = earlyRelease({
      status: "active",
      gate: gate({
        state: "observing",
        verified_count: 1,
        observation_started_at: "2026-09-27T11:59:00Z",
      }),
      lanes: [lane(), queued(10), queued(4, 2)],
    });
    expect(early).toEqual({
      next: 10,
      waiting: 14,
      skipping: "observing",
      subject: "edge-nyc-02",
    });
  });
  it("is not offered unless the released devices have applied and are delivering", () => {
    const lanes = [lane(), queued(2)];
    const offered = (state: Partial<CanaryGate>, status = "active") =>
      earlyRelease({ status, gate: gate(state), lanes }) !== null;
    expect(offered({ reasons: { ...reasons, measuring: 1 } })).toBe(true);
    for (const reason of [
      "unverified",
      "stale",
      "paused",
      "superseded",
      "unavailable",
      "degraded",
    ] as const)
      expect(offered({ reasons: { ...reasons, [reason]: 1 } })).toBe(false);
    // A device still measuring does not excuse one that has not applied.
    expect(
      offered({
        released_count: 2,
        reasons: { ...reasons, measuring: 1, unverified: 1 },
      }),
    ).toBe(false);
    expect(offered({ state: "paused" })).toBe(false);
    expect(offered({ released_count: 0 })).toBe(false);
    expect(offered({ reasons: { ...reasons, measuring: 1 } }, "paused")).toBe(
      false,
    );
    for (const status of ["failed", "completed", "cancelled", "scheduled"])
      expect(offered({ reasons: { ...reasons, measuring: 1 } }, status)).toBe(
        false,
      );
    expect(earlyRelease({ status: "active", gate: null, lanes })).toBeNull();
  });
  it("is not offered when no stage is waiting", () => {
    expect(
      earlyRelease({
        status: "active",
        gate: gate({ reasons: { ...reasons, measuring: 1 } }),
        lanes: [lane()],
      }),
    ).toBeNull();
  });
});
