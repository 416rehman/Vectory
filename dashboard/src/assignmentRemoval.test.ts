import { describe, expect, it } from "vitest";
import {
  AssignmentRemovalPreviewSchema,
  assertAssignmentRemovalPreview,
  assertAssignmentRemovalReceipt,
  assertAssignmentRemovalStatus,
  isAssignmentRemovalUncertain,
  setAssignmentRemovalUncertain,
  removalEffectLabel,
  removalStateLabel,
  type AssignmentRemovalPreview,
  type RemovalState,
} from "./assignmentRemovalModel";

const id = (n: number) =>
  `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, "0")}`;
const state = (overrides: Partial<RemovalState> = {}): RemovalState => ({
  assignment_id: id(1),
  assignment_name: "Current rollout",
  version_id: id(3),
  configuration_name: "Log delivery",
  version_number: 2,
  generation: 7,
  policy: null,
  ...overrides,
});
const review = (): AssignmentRemovalPreview => ({
  removal_review: true,
  source_deployment_id: id(1),
  source_status: "active",
  resource: "configuration",
  ready: true,
  review_token: "a".repeat(64),
  blockers: [],
  devices: [
    {
      device_id: id(2),
      device_name: "Edge A",
      effect: "fallback",
      before: state(),
      after: state({
        assignment_id: id(4),
        assignment_name: "Fallback",
        version_id: id(5),
        version_number: 1,
        generation: 8,
      }),
      pending_assignment_id: null,
      pending_assignment_name: null,
    },
  ],
});

describe("reviewed assignment removal", () => {
  it("retains uncertain removal across callers without sharing another actor or source", () => {
    setAssignmentRemovalUncertain("reviewer-A", id(1), true);
    expect(
      isAssignmentRemovalUncertain("reviewer-A", id(1).toUpperCase()),
    ).toBe(true);
    expect(isAssignmentRemovalUncertain("reviewer-B", id(1))).toBe(false);
    expect(isAssignmentRemovalUncertain("reviewer-A", id(2))).toBe(false);
    setAssignmentRemovalUncertain("reviewer-A", id(1), false);
    expect(isAssignmentRemovalUncertain("reviewer-A", id(1))).toBe(false);
  });
  it("correlates the exact source and keeps reviewed before/after generations", () => {
    const value = review();
    expect(assertAssignmentRemovalPreview(id(1).toUpperCase(), value)).toEqual(
      value,
    );
    expect(value.devices[0].after?.generation).toBe(8);
    expect(() => assertAssignmentRemovalPreview(id(9), value)).toThrow(
      /matching/,
    );
  });
  it("allows removing an unused assignment with an empty reviewed scope", () => {
    const value = { ...review(), devices: [] };
    expect(assertAssignmentRemovalPreview(id(1), value).ready).toBe(true);
  });
  it("rejects the old unbound device-list preview without permitting a token", () => {
    expect(
      AssignmentRemovalPreviewSchema.safeParse({
        devices: [],
        conflicts: [],
        warnings: [],
      }).success,
    ).toBe(false);
    expect(() =>
      assertAssignmentRemovalPreview(id(1), {
        ...review(),
        removal_review: undefined,
      }),
    ).toThrow();
  });
  it.each(["", "a".repeat(63), "A".repeat(64), "z".repeat(64)])(
    "rejects invalid review token %s",
    (token) => {
      expect(
        AssignmentRemovalPreviewSchema.safeParse({
          ...review(),
          review_token: token,
        }).success,
      ).toBe(false);
    },
  );
  it("rejects duplicate device identities even with different casing", () => {
    const value = review();
    value.devices.push({
      ...value.devices[0],
      device_id: value.devices[0].device_id.toUpperCase(),
    });
    expect(AssignmentRemovalPreviewSchema.safeParse(value).success).toBe(false);
  });
  it("requires readiness to reflect blockers, including a zero-device blocker", () => {
    const blocked = {
      ...review(),
      devices: [],
      blockers: [{ code: "CONFLICT", reason: "Resolve assignment conflict." }],
    };
    expect(AssignmentRemovalPreviewSchema.safeParse(blocked).success).toBe(
      false,
    );
    expect(
      AssignmentRemovalPreviewSchema.safeParse({ ...blocked, ready: false })
        .success,
    ).toBe(true);
    expect(
      AssignmentRemovalPreviewSchema.safeParse({ ...review(), ready: false })
        .success,
    ).toBe(false);
  });
  it("keeps a not-yet-admitted winner separate from retained current state", () => {
    const value = review();
    value.devices[0] = {
      ...value.devices[0],
      effect: "retained_pending",
      after: state(),
      pending_assignment_id: id(4),
      pending_assignment_name: "Next canary",
    };
    const parsed = assertAssignmentRemovalPreview(id(1), value);
    expect(parsed.devices[0].after).toEqual(parsed.devices[0].before);
    expect(removalEffectLabel(parsed.devices[0])).toMatch(
      /^Keeps .+ until the next rollout reaches it$/,
    );
    value.devices[0].after!.assignment_name = "Friendly renamed assignment";
    expect(AssignmentRemovalPreviewSchema.safeParse(value).success).toBe(true);
  });
  it.each([
    "configuration_with_policy",
    "policy_with_version",
    "policy_without_policy",
    "fallback_without_assignment",
    "unmanaged_with_assignment",
    "unmanaged_with_version",
    "default_policy_for_config",
    "pending_without_identity",
    "pending_changed_generation",
    "missing_with_state",
  ])("rejects contradictory reviewed effects: %s", (kind) => {
    const value = review(),
      device = value.devices[0];
    const actualPolicy = {
      heartbeat_seconds: 30,
      sync_paused: false,
      telemetry_enabled: true,
    };
    if (kind === "configuration_with_policy")
      device.after!.policy = actualPolicy;
    if (kind === "policy_with_version") {
      value.resource = "policy";
      device.before!.policy = actualPolicy;
      device.after!.policy = actualPolicy;
    }
    if (kind === "policy_without_policy") {
      value.resource = "policy";
      for (const s of [device.before!, device.after!]) {
        s.version_id = null;
        s.configuration_name = null;
        s.version_number = null;
      }
    }
    if (kind === "fallback_without_assignment")
      device.after!.assignment_id = null;
    if (kind === "unmanaged_with_assignment") {
      device.effect = "unmanaged";
      device.after!.version_id = null;
    }
    if (kind === "unmanaged_with_version") {
      device.effect = "unmanaged";
      device.after!.assignment_id = null;
    }
    if (kind === "default_policy_for_config") {
      device.effect = "default_policy";
      device.after!.assignment_id = null;
    }
    if (kind === "pending_without_identity") {
      device.effect = "retained_pending";
      device.after = state();
    }
    if (kind === "pending_changed_generation") {
      device.effect = "retained_pending";
      device.after = state({ generation: 8 });
      device.pending_assignment_id = id(4);
    }
    if (kind === "missing_with_state") device.effect = "missing";
    expect(AssignmentRemovalPreviewSchema.safeParse(value).success).toBe(false);
  });
  it("distinguishes unmanaged configuration from default policy", () => {
    const value = review();
    const unmanaged = {
      ...value.devices[0],
      effect: "unmanaged" as const,
      after: state({
        assignment_id: null,
        assignment_name: null,
        version_id: null,
        configuration_name: null,
        version_number: null,
        generation: 8,
      }),
    };
    expect(removalEffectLabel(unmanaged)).toBe(
      "Keeps its last working config, unmanaged",
    );
    expect(removalStateLabel(unmanaged.after, "configuration")).toBe(
      "No managed configuration",
    );
    const policyState = state({
      assignment_id: null,
      assignment_name: null,
      version_id: null,
      configuration_name: null,
      version_number: null,
      policy: {
        heartbeat_seconds: 30,
        sync_paused: false,
        telemetry_enabled: true,
      },
    });
    const policyReview = {
      ...value,
      resource: "policy",
      devices: [
        {
          ...value.devices[0],
          effect: "default_policy",
          before: policyState,
          after: policyState,
        },
      ],
    };
    expect(AssignmentRemovalPreviewSchema.safeParse(policyReview).success).toBe(
      true,
    );
    expect(removalStateLabel(policyState, "policy")).toBe(
      "Default agent policy",
    );
  });
  // Round-2 operator review P3: say what each device runs afterwards.
  it("says what each device keeps or switches to, by name", () => {
    const [device] = review().devices;
    expect(removalEffectLabel(device)).toBe("Switches to Log delivery v1");
    const kept = {
      ...device,
      effect: "unchanged" as const,
      before: state({
        configuration_name: "Edge syslog processing",
        version_number: 1,
      }),
      after: state({
        configuration_name: "Edge syslog processing",
        version_number: 1,
      }),
    };
    expect(removalEffectLabel(kept)).toBe(
      "Keeps Edge syslog processing v1 (no change)",
    );
    expect(removalEffectLabel({ ...kept, effect: "not_targeted" })).toBe(
      "Keeps Edge syslog processing v1 (no change)",
    );
    expect(removalStateLabel(kept.after, "configuration")).toBe(
      "Edge syslog processing v1",
    );
  });
  it("retains missing and revoked identities without inventing state", () => {
    const value = review();
    value.devices = ["missing", "revoked"].map((effect, n) => ({
      ...value.devices[0],
      device_id: id(n + 6),
      effect: effect as "missing" | "revoked",
      before: effect === "missing" ? null : state(),
      after: effect === "missing" ? null : state(),
    }));
    expect(assertAssignmentRemovalPreview(id(1), value).devices).toHaveLength(
      2,
    );
    expect(removalStateLabel(null, "configuration")).toBe("Unavailable");
  });
  it("rejects missing state on an extant device without inventing its outcome", () => {
    const value = review();
    value.devices[0] = {
      ...value.devices[0],
      effect: "unchanged",
      before: null,
      after: null,
    };
    expect(AssignmentRemovalPreviewSchema.safeParse(value).success).toBe(false);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects inexact or invalid generation %s",
    (generation) => {
      const value = review();
      value.devices[0].after!.generation = generation;
      expect(AssignmentRemovalPreviewSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );
  it("enforces bounded scope and rejects unexpected raw fields", () => {
    const value = review();
    expect(
      AssignmentRemovalPreviewSchema.safeParse({
        ...value,
        devices: Array.from({ length: 10001 }, (_, n) => ({
          ...value.devices[0],
          device_id: id(n + 1),
        })),
      }).success,
    ).toBe(false);
    expect(
      AssignmentRemovalPreviewSchema.safeParse({
        ...value,
        raw_config: { secret: "not accepted" },
      }).success,
    ).toBe(false);
  });
  it("accepts Unicode metadata bounds and preserves absent friendly metadata", () => {
    const value = review();
    value.devices[0].device_name = "😀".repeat(240);
    value.devices[0].after = state({
      assignment_name: null,
      configuration_name: null,
      version_number: null,
    });
    expect(
      assertAssignmentRemovalPreview(id(1), value).devices[0].after?.version_id,
    ).toBe(id(3));
    value.devices[0].device_name += "x";
    expect(AssignmentRemovalPreviewSchema.safeParse(value).success).toBe(false);
  });
  it("requires exact terminal removal for a successful POST receipt", () => {
    expect(
      assertAssignmentRemovalReceipt(id(1), {
        id: id(1),
        status: "unassigned",
        targets: [],
      }),
    ).toEqual({ id: id(1), status: "unassigned" });
    for (const response of [
      { ok: true },
      { id: id(2), status: "unassigned" },
      { id: id(1), status: "active" },
      { id: id(1) },
    ])
      expect(() => assertAssignmentRemovalReceipt(id(1), response)).toThrow();
  });
  it("status checks accept another known current state without calling it removal", () => {
    expect(
      assertAssignmentRemovalStatus(id(1), { id: id(1), status: "paused" })
        .status,
    ).toBe("paused");
    expect(() =>
      assertAssignmentRemovalStatus(id(1), { id: id(1), status: "unknown" }),
    ).toThrow();
    expect(() =>
      assertAssignmentRemovalStatus(id(1), { id: id(2), status: "unassigned" }),
    ).toThrow();
  });
});
