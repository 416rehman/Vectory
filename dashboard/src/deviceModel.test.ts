import { describe, expect, it } from "vitest";
import {
  freshRate,
  groupsByDevice,
  matchesStatus,
  matchesView,
  runsDesired,
  searchText,
  statusRank,
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
  it("selects failing, drifting, offline, paused and silent devices", () => {
    expect(matchesView(device({ status: "rolled_back" }), "failing", now)).toBe(
      true,
    );
    expect(matchesView(device({ status: "applying" }), "drift", now)).toBe(
      true,
    );
    expect(matchesView(device({}), "drift", now)).toBe(false);
    expect(
      matchesView(
        device({ status: "offline", last_seen: ago(900) }),
        "offline",
        now,
      ),
    ).toBe(true);
    expect(matchesView(device({ last_seen: null }), "offline", now)).toBe(true);
    expect(matchesView(device({ sync_paused: true }), "paused", now)).toBe(
      true,
    );
    expect(
      matchesView(
        device({ telemetry: { sampled_at: ago(600), events_per_second: 1 } }),
        "no_telemetry",
        now,
      ),
    ).toBe(true);
    expect(matchesView(device({}), "no_telemetry", now)).toBe(false);
    // Revoked identities never appear in operational views.
    expect(
      matchesView(device({ status: "revoked" }), "no_telemetry", now),
    ).toBe(false);
  });

  it("filters by health bucket or revoked", () => {
    expect(matchesStatus(device({ status: "rolled_back" }), "failed")).toBe(
      true,
    );
    expect(matchesStatus(device({ status: "revoked" }), "revoked")).toBe(true);
    expect(matchesStatus(device({}), "")).toBe(true);
    expect(matchesStatus(device({}), "offline")).toBe(false);
  });
});

describe("list helpers", () => {
  it("keeps stale rates out and sorts problems first", () => {
    expect(freshRate(device({}), now)).toBe(12.5);
    expect(
      freshRate(
        device({ telemetry: { sampled_at: ago(400), events_per_second: 9 } }),
        now,
      ),
    ).toBeNull();
    expect(statusRank(device({ status: "failed" }))).toBeLessThan(
      statusRank(device({})),
    );
    expect(statusRank(device({ status: "revoked" }))).toBeGreaterThan(
      statusRank(device({})),
    );
  });

  it("searches names, labels, versions and groups", () => {
    const text = searchText(
      device({ labels: { region: "eu-west" }, vector_version: "0.58.0" }),
      ["Web tier"],
    );
    for (const term of [
      "edge-01",
      "eu-west",
      "orders v3",
      "0.58.0",
      "web tier",
    ])
      expect(text).toContain(term);
    const groups = groupsByDevice([
      { id: "g2", name: "Web tier", device_ids: ["d1"] },
      { id: "g1", name: "Edge", device_ids: ["d1", "d2"] },
    ]);
    expect(groups.get("d1")?.map((group) => group.name)).toEqual([
      "Edge",
      "Web tier",
    ]);
    expect(groups.get("d3")).toBeUndefined();
  });
});
