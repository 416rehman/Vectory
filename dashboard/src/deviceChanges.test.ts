import { describe, expect, it } from "vitest";
import {
  applyMarkers,
  clusterMarkers,
  counterNote,
  counterSince,
  lastVersionChange,
  markedSince,
  type ChangeEvent,
} from "./deviceChanges";

let counter = 0;
const event = (
  action: string,
  outcome: string,
  at: string,
  target_name: string | null = null,
): ChangeEvent => ({
  id: `event-${++counter}`,
  action,
  outcome,
  created_at: `2026-10-02T${at}Z`,
  target_name,
});
const release = (at: string, name: string) =>
  event("deployment.release", "success", at, name);
const apply = (at: string, outcome: string) =>
  event("device.apply_state", outcome, at);
/** The audit lists newest first. */
const listed = (...events: ChangeEvent[]) => [...events].reverse();

describe("apply markers", () => {
  it("pairs each release with the state the agent reported after it", () => {
    const markers = applyMarkers(
      listed(
        release("16:41:00", "Orders v1"),
        apply("16:41:02", "desired"),
        apply("16:41:09", "verified_applied"),
        release("16:47:00", "Orders v2"),
        apply("16:47:04", "desired"),
        apply("16:48:10", "rolled_back"),
      ),
    );
    expect(
      markers.map((marker) => [marker.stateLabel, marker.version, marker.tone]),
    ).toEqual([
      ["Applied", "Orders v1", "success"],
      ["Rolled back", "Orders v2", "danger"],
    ]);
    expect(markers.map((marker) => marker.versionNumber)).toEqual(["v1", "v2"]);
    expect(lastVersionChange(markers)?.state).toBe("rolled_back");
  });

  it("ignores intermediate states and settings releases", () => {
    const markers = applyMarkers(
      listed(
        release("10:00:00", "Agent settings"),
        apply("10:00:02", "desired"),
        apply("10:00:05", "verified_applied"),
        release("10:05:00", "Agent settings: Fast check-ins"),
        apply("10:05:04", "verified_applied"),
        release("10:10:00", "Orders v1"),
        apply("10:10:01", "downloaded"),
        apply("10:10:02", "validated"),
        apply("10:10:03", "reload_requested"),
      ),
    );
    // The settings releases name no pipeline version, and the version has not
    // reported an outcome yet.
    expect(markers).toEqual([]);
  });

  it("does not count an applied report that follows no release", () => {
    // A device resuming after a pause, or repairing a local edit, runs what it
    // ran before.
    expect(
      applyMarkers(
        listed(
          apply("09:00:00", "paused"),
          apply("09:30:00", "verified_applied"),
        ),
      ),
    ).toEqual([]);
  });

  it("marks a failure, and a retry's new outcome", () => {
    const markers = applyMarkers(
      listed(
        release("12:00:00", "Orders v3"),
        apply("12:00:30", "failed"),
        event("device.retry", "success", "12:05:00"),
        apply("12:05:30", "verified_applied"),
      ),
    );
    expect(markers.map((m) => [m.stateLabel, m.version])).toEqual([
      ["Failed", "Orders v3"],
      ["Applied", "Orders v3"],
    ]);
  });

  it("keeps an outcome whose release is older than the rows read", () => {
    const [marker] = applyMarkers(listed(apply("08:00:00", "rolled_back")));
    expect(marker).toMatchObject({
      state: "rolled_back",
      version: null,
      versionNumber: null,
    });
  });

  it("reads rows without a time as nothing", () => {
    expect(
      applyMarkers([
        {
          id: "x",
          action: "device.apply_state",
          outcome: "failed",
          created_at: null,
        },
      ]),
    ).toEqual([]);
  });
});

describe("how far back the markers can be read", () => {
  const rows = (...times: (string | null)[]) =>
    times.map((created_at) => ({ created_at }));
  it("names the oldest event read when the device has more", () => {
    expect(
      markedSince({
        total: 212,
        items: rows("2026-10-02T16:48:00Z", "2026-10-01T09:30:00Z"),
      }),
    ).toBe("2026-10-01T09:30:00Z");
  });
  it("says nothing when the read holds every event", () => {
    expect(
      markedSince({ total: 2, items: rows("2026-10-02T16:48:00Z", "x") }),
    ).toBeNull();
    expect(markedSince({ total: 0, items: [] })).toBeNull();
  });
  it("knows no limit it cannot read", () => {
    expect(
      markedSince({ total: 90, items: rows("2026-10-02T16:48:00Z", null) }),
    ).toBeNull();
    expect(markedSince({ total: 90, items: [] })).toBeNull();
  });
});

describe("marker clusters", () => {
  const minute = 60_000;
  const start = Date.parse("2026-10-02T10:00:00Z");
  const end = start + 14 * minute;
  const marker = (offsetMinutes: number, outcome = "verified_applied") =>
    applyMarkers(
      listed(
        release("09:00:00", "Orders v1"),
        event(
          "device.apply_state",
          outcome,
          new Date(start + offsetMinutes * minute).toISOString().slice(11, 19),
        ),
      ),
    )[0];
  it("places a marker where its time falls between the first and last slot", () => {
    const [cluster] = clusterMarkers([marker(7)], start, end, minute);
    expect(cluster.x).toBeCloseTo(0.5);
  });
  it("merges changes that would overlap and keeps the most severe tone", () => {
    const clusters = clusterMarkers(
      [marker(2), marker(2.1, "failed"), marker(10)],
      start,
      end,
      minute,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0].markers).toHaveLength(2);
    expect(clusters[0].tone).toBe("danger");
    expect(clusters[1].tone).toBe("success");
  });
  it("leaves out changes before the window and puts one in the open slot at the edge", () => {
    const clusters = clusterMarkers(
      [marker(-3), marker(14.5)],
      start,
      end,
      minute,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].x).toBe(1);
  });
  it("draws nothing on a plot with no width", () => {
    expect(clusterMarkers([marker(1)], start, start, minute)).toEqual([]);
  });
});

describe("counters since a version was applied", () => {
  const readings = [
    { at: "2026-10-02T18:38:43Z", value: 1485 },
    { at: "2026-10-02T18:39:56Z", value: 1700 },
    { at: "2026-10-02T18:40:25Z", value: 1795 },
    { at: "2026-10-02T18:41:20Z", value: 2010 },
  ];
  const base = {
    latestAt: "2026-10-02T18:41:20Z",
    uptimeSeconds: 560,
    changedAt: "2026-10-02T18:40:19Z",
    readings,
  };
  it("counts from the first sample after the apply, keeping the total", () => {
    expect(counterSince({ ...base, total: 2010 })).toEqual({
      value: 215,
      total: 2010,
      basis: "change",
    });
  });
  it("says nothing changed when the version predates Vector's process", () => {
    expect(
      counterSince({ ...base, total: 2010, uptimeSeconds: 30 }),
    ).toMatchObject({ value: 2010, basis: "start" });
    expect(
      counterSince({ ...base, total: 2010, changedAt: null }),
    ).toMatchObject({ value: 2010, basis: "start" });
  });
  it("counts the whole total after a restart, since it is all newer", () => {
    expect(counterSince({ ...base, total: 40 })).toMatchObject({
      value: 40,
      basis: "change",
    });
  });
  it("admits when no sample says where the counter stood", () => {
    expect(
      counterSince({ ...base, total: 2010, readings: readings.slice(0, 2) }),
    ).toMatchObject({ basis: "unknown", value: 2010 });
    expect(counterSince({ ...base, total: undefined })).toBeNull();
    expect(counterSince({ ...base, total: Number.NaN })).toBeNull();
  });
  it("skips readings that carry no value", () => {
    expect(
      counterSince({
        ...base,
        total: 2010,
        readings: [
          { at: "2026-10-02T18:40:25Z", value: null },
          { at: "2026-10-02T18:41:20Z", value: 2000 },
        ],
      }),
    ).toMatchObject({ value: 10, basis: "change" });
  });

  const format = (value: number) => value.toLocaleString("en-US");
  const applied = {
    state: "verified_applied" as const,
    version: "Orders v2",
    versionNumber: "v2",
    at: "2026-10-02T18:40:19Z",
  };
  it("words the note by what the count is", () => {
    const since = counterSince({ ...base, total: 2010 });
    const note = counterNote(since, applied, format);
    expect(note?.text).toBe("215 since v2 applied");
    // Vector's own total stays reachable.
    expect(note?.title).toContain("2,010 since it started");
    expect(note?.title).toContain("Orders v2 was applied at");
    expect(
      counterNote(since, { ...applied, state: "rolled_back" }, format)?.text,
    ).toBe("215 since the rollback");
    expect(
      counterNote(
        counterSince({ ...base, total: 2010, uptimeSeconds: 30 }),
        applied,
        format,
      ),
    ).toEqual({ text: "2,010 since Vector started", title: undefined });
    expect(
      counterNote(
        counterSince({ ...base, total: 2010, readings: [] }),
        applied,
        format,
      )?.text,
    ).toBe("2,010 since Vector started, including earlier versions");
    expect(counterNote(null, applied, format)).toBeNull();
  });
});
