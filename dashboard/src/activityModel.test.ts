import { describe, expect, it } from "vitest";
import {
  activityGlyph,
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
  it("says who released the next stage early, and of what", () => {
    const early = item({
      action: "deployment.stage_released_early",
      target_kind: "deployment",
      target_name: "Edge syslog",
    });
    expect(sentence(describeActivity(early))).toContain(
      "released the next stage of",
    );
    expect(sentence(describeActivity(early))).toMatch(/ early$/);
    expect(activityGlyph(early)).toBe("deploy");
  });
  it("never reads a refused enrollment as an item that enrolled", () => {
    const refused = item({
      action: "device.enroll",
      actor_kind: "device",
      target_kind: "device",
      target_id: null,
      target_name: null,
      target_exists: false,
      outcome: "failure",
    });
    expect(sentence(describeActivity(refused))).toBe("Enrollment refused");
    expect(
      sentence(describeActivity({ ...refused, target_name: "lab-neg-again" })),
    ).toBe("Enrollment refused: lab-neg-again");
    expect(links(describeActivity(refused))).toEqual([]);
    expect(activityTone(refused)).toBe("danger");
    expect(
      sentence(
        describeActivity(
          item({
            action: "device.enroll",
            target_kind: "device",
            target_name: "edge-01",
          }),
        ),
      ),
    ).toBe("edge-01 enrolled");
  });

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

  it("says what was rolled back, where, and what those devices run now", () => {
    const rollback = (extra: Partial<ActivityItem> = {}) =>
      describeActivity(
        item({
          action: "deployment.rollback",
          actor: "Demo operator",
          target_kind: "deployment",
          target_id: uuid(5),
          target_name: "web-demo v1",
          device_names: ["edge-nyc-02"],
          deployment: {
            configuration_name: "web-demo",
            version_number: 1,
            policy: false,
            rollout_kind: "canary",
            priority: 100,
            target_count: 3,
            rolled_back_to_configuration_name: "Edge syslog processing",
            rolled_back_to_version_number: 1,
            rolled_back_device_count: 1,
            rollback_of_configuration_name: null,
            rollback_of_version_number: null,
          },
          ...extra,
        }),
      );
    expect(sentence(rollback())).toBe(
      "Demo operator rolled back web-demo v1 on edge-nyc-02 (now Edge syslog processing v1)",
    );
    expect(links(rollback())).toEqual([
      ["web-demo v1", `#/deployments/${uuid(5)}`],
    ]);
    // Older servers name only the rolled-back deployment: never "to" it.
    expect(
      sentence(
        rollback({
          device_names: undefined,
          deployment: {
            configuration_name: "web-demo",
            version_number: 1,
            policy: false,
            rollout_kind: "canary",
            priority: 100,
            target_count: 3,
          },
        }),
      ),
    ).toBe("Demo operator rolled back web-demo v1");
    // The rollback's own deployment says what it rolled back.
    expect(
      sentence(
        describeActivity(
          item({
            action: "deployment.create",
            actor: "Demo operator",
            target_kind: "deployment",
            target_id: uuid(6),
            target_name: null,
            deployment: {
              configuration_name: "Edge syslog processing",
              version_number: 1,
              policy: false,
              rollout_kind: "all",
              priority: 101,
              target_count: 1,
              rollback_of_configuration_name: "web-demo",
              rollback_of_version_number: 1,
            },
          }),
        ),
      ),
    ).toBe(
      "Demo operator deployed Edge syslog processing v1 to 1 device (rollback of web-demo v1)",
    );
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

  it("says what a device's agent update came to, from its own state", () => {
    const update = (outcome: string) =>
      sentence(
        describeActivity(
          item({
            action: "device.agent_update",
            actor: "edge-02",
            actor_kind: "device",
            target_kind: "device",
            target_name: "edge-02",
            outcome,
          }),
        ),
      );
    expect(update("verified")).toBe("edge-02 updated its agent");
    expect(update("rolled_back")).toBe("edge-02 rolled back an agent update");
    expect(update("failed")).toBe("edge-02 couldn't update its agent");
    expect(update("refused")).toBe("edge-02 refused an agent update");
    expect(update("something_new")).toBe(
      "edge-02 reported an agent update result",
    );
  });

  it("names who turned agent updates on, off or stopped them", () => {
    const action = (name: string) =>
      sentence(
        describeActivity(
          item({ action: name, target_kind: "server", target_name: null }),
        ),
      );
    expect(action("agent_update.enable")).toBe(
      "Morgan Lee turned on agent updates",
    );
    expect(action("agent_update.disable")).toBe(
      "Morgan Lee turned off agent updates",
    );
    expect(action("agent_update.stop")).toBe(
      "Morgan Lee stopped all agent updates",
    );
    expect(action("agent_update.stop_clear")).toBe(
      "Morgan Lee cleared the stop on agent updates",
    );
  });

  it("keeps the other update events readable without a sentence of their own", () => {
    expect(
      sentence(
        describeActivity(
          item({
            action: "agent_update_rollout.pause",
            target_kind: "agent_update_rollout",
            target_name: null,
          }),
        ),
      ),
    ).toBe("Morgan Lee · Agent update rollout paused");
    expect(
      links(
        describeActivity(
          item({
            action: "agent_update_rollout.create",
            target_kind: "agent_update_rollout",
            target_id: uuid(9),
            target_name: "Agent 0.1.1",
          }),
        ),
      ),
    ).toEqual([["Agent 0.1.1", `#/agent-updates/${uuid(9)}`]]);
  });
});

describe("activity glyphs", () => {
  it("picks an icon per kind of change", () => {
    expect(activityGlyph(item({ action: "configuration.publish" }))).toBe(
      "publish",
    );
    expect(activityGlyph(item({ action: "deployment.create" }))).toBe("deploy");
    expect(
      activityGlyph(
        item({ action: "device.apply_state", outcome: "verified_applied" }),
      ),
    ).toBe("applied");
    expect(
      activityGlyph(item({ action: "device.apply_state", outcome: "failed" })),
    ).toBe("failed");
    expect(activityGlyph(item({ action: "device.recovery_complete" }))).toBe(
      "recovery",
    );
    expect(activityGlyph(item({ action: "something.new" }))).toBe("other");
  });

  it("reads a device's agent update by its result", () => {
    const glyph = (outcome: string) =>
      activityGlyph(item({ action: "device.agent_update", outcome }));
    expect(glyph("verified")).toBe("applied");
    expect(glyph("rolled_back")).toBe("rollback");
    expect(glyph("failed")).toBe("failed");
    expect(glyph("refused")).toBe("check");
    expect(activityGlyph(item({ action: "agent_update.stop" }))).toBe(
      "settings",
    );
    expect(activityGlyph(item({ action: "agent_update_rollout.create" }))).toBe(
      "deploy",
    );
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
    expect(activityTone(item({ outcome: "refused" }))).toBe("warning");
    expect(activityTone(item({}))).toBe("neutral");
  });
});
