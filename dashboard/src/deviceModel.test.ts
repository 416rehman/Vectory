import { describe, expect, it } from "vitest";
import {
  deviceViews,
  freshFlow,
  freshRate,
  isDeviceView,
  runsDesired,
  versionLabel,
  versionMarker,
  type ListDevice,
} from "./deviceModel";

const now = Date.parse("2026-09-29T03:00:00.000Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const device = (extra: Partial<ListDevice>): ListDevice => ({
  id: "d1",
  name: "edge-01",
  status: "verified",
  last_seen: ago(5),
  apply_state: "verified_applied",
  desired_version_id: "v1",
  desired_generation: 2,
  reported_generation: 2,
  desired_version: {
    number: 3,
    configuration_id: "c1",
    configuration_name: "Orders",
  },
  telemetry: { sampled_at: ago(10), events_per_second: 12.5 },
  ...extra,
});

describe("running vs desired", () => {
  it("counts verified devices and offline devices whose last report matched", () => {
    expect(runsDesired(device({}))).toBe(true);
    expect(runsDesired(device({ status: "offline" }))).toBe(true);
    expect(
      runsDesired(device({ status: "offline", reported_generation: 1 })),
    ).toBe(false);
    expect(runsDesired(device({ status: "applying" }))).toBe(false);
    expect(runsDesired(device({ desired_version_id: null }))).toBe(false);
  });

  it("marks each state with a distinct, honest label", () => {
    expect(versionMarker(device({}))?.text).toBe("Running");
    expect(versionMarker(device({ status: "offline" }))?.text).toBe(
      "Running at last report",
    );
    expect(versionMarker(device({ status: "failed" }))).toMatchObject({
      tone: "danger",
      text: "Failed · previous version kept",
    });
    expect(
      versionMarker(device({ status: "verification_unknown" }))?.tone,
    ).toBe("warning");
    expect(
      versionMarker(device({ status: "applying", apply_state: "written" }))
        ?.text,
    ).toBe("Not running yet");
    expect(versionMarker(device({ desired_version_id: null }))).toBeNull();
  });

  it("labels versions by pipeline name and number", () => {
    expect(versionLabel(device({}))).toBe("Orders v3");
    expect(versionLabel(device({ desired_version: null }))).toBe(
      "Assigned version",
    );
    expect(versionLabel(device({ desired_version_id: null }))).toBeNull();
  });
});

describe("quick views", () => {
  it("names the views the address can carry", () => {
    // The server applies them; its own name for drift is not an address value.
    expect(deviceViews.map((view) => view.value)).toEqual([
      "failing",
      "drift",
      "offline",
      "paused",
      "no_telemetry",
    ]);
    expect(isDeviceView("drift")).toBe(true);
    expect(isDeviceView("not_on_desired")).toBe(false);
    expect(isDeviceView("")).toBe(false);
  });
});

describe("list helpers", () => {
  it("keeps stale rates out", () => {
    expect(freshRate(device({}), now)).toBe(12.5);
    expect(
      freshRate(
        device({ telemetry: { sampled_at: ago(400), events_per_second: 9 } }),
        now,
      ),
    ).toBeNull();
  });
});

describe("delivery health", () => {
  const degraded = device({
    telemetry: {
      sampled_at: ago(10),
      events_per_second: 5,
      events_out_per_second: 0,
    },
    data_plane: {
      version_id: "v1",
      issues: [{ code: "DATA_PLANE_SINK_ERRORS", title: "out can't deliver" }],
    },
  });
  it("reports events in and out, never inventing a missing delivery rate", () => {
    expect(freshFlow(degraded, now)).toEqual({ in: 5, out: 0 });
    expect(freshFlow(device({}), now)).toEqual({ in: 12.5, out: null });
    expect(
      freshFlow(device({ telemetry: { sampled_at: ago(600) } }), now),
    ).toBeNull();
  });
});
