import { describe, expect, it } from "vitest";
import {
  activityTone,
  describeActivity,
  nameList,
  type ActivityItem,
  type Part,
} from "./activityModel";

const uuid = (n: number) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sentence = (parts: Part[]) => parts.map((part) => part.text).join("");
const links = (parts: Part[]) =>
  parts.filter((part) => part.href).map((part) => [part.text, part.href]);
const item = (extra: Partial<ActivityItem>): ActivityItem => ({
  id: uuid(1),
  action: "configuration.create",
  actor: "Morgan Lee",
  actor_id: uuid(2),
  actor_kind: "user",
  target: uuid(3),
  target_id: uuid(3),
  target_kind: "configuration",
  target_name: "Orders",
  target_exists: true,
  outcome: "success",
  created_at: "2026-09-29T03:00:00Z",
  ...extra,
});

describe("device name lists", () => {
  it("names up to two devices and counts the rest", () => {
    expect(nameList([], 3)).toBe("3 devices");
    expect(nameList(["edge-01"])).toBe("edge-01");
    expect(nameList(["edge-01", "edge-02"])).toBe("edge-01 and edge-02");
    expect(nameList(["edge-01", "edge-02", "edge-03"], 5)).toBe(
      "edge-01, edge-02 and 3 more",
    );
  });
});

describe("activity sentences", () => {
  it("names the pipeline, version and device count of a deployment", () => {
    const parts = describeActivity(
      item({
        action: "deployment.create",
        target_kind: "deployment",
        target_id: uuid(5),
        target_name: null,
        deployment: {
          configuration_name: "Web access logs",
          version_number: 3,
          policy: false,
          rollout_kind: "canary",
          priority: 100,
          target_count: 12,
        },
      }),
    );
    expect(sentence(parts)).toBe(
      "Morgan Lee deployed Web access logs v3 to 12 devices as a canary",
    );
    expect(links(parts)).toEqual([
      ["Web access logs v3", `#/deployments/${uuid(5)}`],
    ]);
  });

  it("describes settings rollouts as agent settings, not pipelines", () => {
    const parts = describeActivity(
      item({
        action: "deployment.create",
        target_kind: "deployment",
        target_id: uuid(5),
        deployment: {
          configuration_name: null,
          version_number: null,
          policy: true,
          rollout_kind: "all",
          priority: 100,
          target_count: 1,
        },
      }),
    );
    expect(sentence(parts)).toBe(
      "Morgan Lee applied agent settings to 1 device",
    );
  });

  it("collapses repeated apply results into one line without a single link", () => {
    const parts = describeActivity(
      item({
        action: "device.apply_state",
        actor_kind: "device",
        target_kind: "device",
        outcome: "verified_applied",
        repeat: 4,
        device_names: ["edge-fra-01", "edge-nyc-01", "web-ams-01"],
      }),
    );
    expect(sentence(parts)).toBe(
      "edge-fra-01, edge-nyc-01 and 2 more applied their pipeline",
    );
    expect(links(parts)).toEqual([]);
    const single = describeActivity(
      item({
        action: "device.apply_state",
        target_kind: "device",
        target_id: uuid(9),
        target_name: "edge-fra-01",
        outcome: "failed",
        repeat: 1,
        device_names: ["edge-fra-01"],
      }),
    );
    expect(sentence(single)).toBe("edge-fra-01 failed to apply its pipeline");
    expect(links(single)).toEqual([["edge-fra-01", `#/devices/${uuid(9)}`]]);
  });

  it("names intermediate apply steps instead of guessing a problem", () => {
    const step = (outcome: string) =>
      sentence(
        describeActivity(
          item({
            action: "device.apply_state",
            target_kind: "device",
            target_name: "edge-01",
            outcome,
          }),
        ),
      );
    expect(step("downloaded")).toBe("edge-01 downloaded its new version");
    expect(step("reload_requested")).toBe("edge-01 asked Vector to reload");
    expect(step("verification_unknown")).toBe(
      "edge-01 needs a check: Vector wasn't confirmed running",
    );
    expect(step("something_new")).toBe("edge-01 reported something new");
  });

  it("links published versions to their pipeline and names the number", () => {
    const parts = describeActivity(
      item({
        action: "configuration.publish",
        target: uuid(4),
        version_number: 7,
      }),
    );
    expect(sentence(parts)).toBe("Morgan Lee published Orders v7");
    expect(links(parts)).toEqual([
      ["Orders v7", `#/configurations/${uuid(3)}`],
    ]);
  });

  it("never links deleted, missing or malformed identities", () => {
    for (const extra of [
      { target_exists: false },
      { target_exists: undefined },
      { target_id: "javascript:alert(1)" },
      { target_id: `${uuid(3)}:${uuid(4)}` },
      { target_kind: "unknown" },
    ])
      expect(links(describeActivity(item(extra)))).toEqual([]);
  });

  it("attributes automatic work to Vectory and keeps unknown actions readable", () => {
    const released = describeActivity(
      item({
        action: "deployment.release",
        actor: "scheduler",
        actor_id: "scheduler",
        actor_kind: "system",
        target_kind: "deployment",
        target_id: uuid(5),
        repeat: 3,
        device_names: ["edge-01", "edge-02", "edge-03"],
        deployment: {
          configuration_name: "Orders",
          version_number: 2,
          policy: false,
          rollout_kind: "all",
          priority: 100,
          target_count: 3,
        },
      }),
    );
    expect(sentence(released)).toBe(
      "Vectory released Orders v2 to edge-01, edge-02 and 1 more",
    );
    expect(
      sentence(describeActivity(item({ action: "device.renew" }))),
    ).toContain("Device credentials renewed");
  });
});

describe("activity tone", () => {
  it("marks failures and uncertain results", () => {
    expect(activityTone(item({ outcome: "failed" }))).toBe("danger");
    expect(activityTone(item({ outcome: "rolled_back" }))).toBe("danger");
    expect(activityTone(item({ outcome: "verification_unknown" }))).toBe(
      "warning",
    );
    expect(activityTone(item({ action: "deployment.missed" }))).toBe("warning");
    expect(activityTone(item({}))).toBe("neutral");
  });
});
