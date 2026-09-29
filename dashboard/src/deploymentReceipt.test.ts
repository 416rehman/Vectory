import { describe, expect, it } from "vitest";
import {
  assertDeploymentLookup,
  assertDeploymentLookupById,
  assertDeploymentReceipt,
} from "./deploymentReceipt";
import type { DeploymentOperation } from "./deploymentRequests";

const id = (n: number) =>
  `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, "0")}`;
const selector = { device_ids: [id(3)], group_ids: [], exclude_ids: [] };
const rollout = {
  kind: "all" as const,
  canary_size: 1,
  batch_size: 10,
  observation_seconds: 0,
  failure_threshold: 0,
};
const operation = (kind: "create" | "rollback"): DeploymentOperation => {
  const base = {
    actor_id: "synthetic-operator",
    id: id(1),
    label: "Synthetic request",
    recorded_at: "2026-09-27T12:00:00Z",
    retry_supported: true,
  };
  return kind === "create"
    ? {
        ...base,
        kind,
        request: {
          version_id: id(2),
          selector,
          expected_device_ids: [id(3)],
          priority: 100,
          target_mode: "persistent",
          scheduled_at: null,
          rollout,
          request_id: base.id,
        },
      }
    : {
        ...base,
        kind,
        deployment_id: id(4),
        request: { request_id: base.id, review_token: "a".repeat(64) },
        review: {
          version_id: id(2),
          version_number: 1,
          configuration_name: "Synthetic prior pipeline",
          device_ids: [id(3)],
          excluded_count: 0,
        },
      };
};
const receipt = (kind: "create" | "rollback" = "create") => ({
  id: id(5),
  name: "Synthetic current deployment",
  version_id: id(2),
  selector,
  priority: 100,
  target_mode: "persistent",
  status: "active",
  scheduled_at: null,
  created_at: "2026-09-27T12:00:01Z",
  targets: [
    {
      device_id: id(3),
      state: "desired",
      generation: 1,
      error: null,
      original: true,
    },
  ],
  rollout,
  rollback_review: true,
  rollback_idempotency: true,
  request_correlation: true,
  request_id: id(1),
  operation: kind,
  source_deployment_id: kind === "rollback" ? id(4) : null,
});
const lookup = (kind: "create" | "rollback" = "create") => ({
  found: true,
  request_id: id(1),
  operation: kind,
  source_deployment_id: kind === "rollback" ? id(4) : null,
  deployment: receipt(kind),
});

describe("status-only deployment lookup for unreadable intent", () => {
  it.each(["create", "rollback"] as const)(
    "accepts a correlated %s result using only the trusted key",
    (kind) => {
      expect(
        assertDeploymentLookupById(id(1).toUpperCase(), lookup(kind)),
      ).toEqual(lookup(kind));
    },
  );
  it("permits an exact absent result without inventing a retry payload", () => {
    expect(
      assertDeploymentLookupById(id(1), { found: false, request_id: id(1) }),
    ).toEqual({ found: false, request_id: id(1) });
  });
  it.each([
    { found: false },
    { found: false, request_id: id(9) },
    { ...lookup(), request_id: id(9) },
    { ...lookup(), deployment: { ...receipt(), request_id: id(9) } },
    {
      ...lookup("rollback"),
      deployment: { ...receipt("rollback"), id: id(4) },
    },
  ])("rejects unverifiable status without a trusted payload: %j", (value) => {
    expect(() => assertDeploymentLookupById(id(1), value)).toThrow(
      /identity|request/,
    );
  });
});

describe("deployment receipt identity", () => {
  it("accepts current create state without treating original selectors or status as identity", () => {
    const current = {
      ...receipt(),
      status: "paused",
      priority: 200,
      selector: { ...selector, device_ids: [id(7)] },
      targets: [
        { ...receipt().targets[0], state: "removed" },
        { ...receipt().targets[0], device_id: id(7), original: false },
      ],
    };
    expect(assertDeploymentReceipt(operation("create"), current)).toMatchObject(
      current,
    );
  });

  it("binds rollback to its original source, without using current target contents as identity", () => {
    const current = {
      ...receipt("rollback"),
      status: "cancelled",
      targets: [],
    };
    expect(
      assertDeploymentReceipt(operation("rollback"), current),
    ).toMatchObject(current);
  });

  it.each(["create", "rollback"] as const)(
    "accepts normalized UUID spellings for %s",
    (kind) => {
      const saved = operation(kind);
      saved.id = saved.id.toUpperCase();
      if (saved.kind === "rollback")
        saved.deployment_id = saved.deployment_id.toUpperCase();
      expect(() => assertDeploymentReceipt(saved, receipt(kind))).not.toThrow();
    },
  );

  it.each([
    { request_id: id(9) },
    { operation: "rollback", source_deployment_id: id(4) },
    { source_deployment_id: id(4) },
    { request_id: undefined },
    { operation: undefined },
    { source_deployment_id: undefined },
    { id: "not-a-deployment" },
  ])("rejects unrelated or missing create identity: %j", (change) => {
    expect(() =>
      assertDeploymentReceipt(operation("create"), { ...receipt(), ...change }),
    ).toThrow(/request|identity/);
  });

  it.each([
    { source_deployment_id: id(9) },
    { source_deployment_id: null },
    { operation: "create", source_deployment_id: null },
    { id: id(4) },
  ])("rejects the wrong rollback source/result: %j", (change) => {
    expect(() =>
      assertDeploymentReceipt(operation("rollback"), {
        ...receipt("rollback"),
        ...change,
      }),
    ).toThrow(/request|identity/);
  });

  it("does not accept a well-shaped identity around a malformed deployment", () => {
    expect(() =>
      assertDeploymentReceipt(operation("create"), {
        request_id: id(1),
        operation: "create",
        source_deployment_id: null,
        id: id(5),
      }),
    ).toThrow(/identity/);
  });
});

describe("deployment request lookup identity", () => {
  it.each(["create", "rollback"] as const)(
    "accepts matching outer and inner %s identities",
    (kind) => {
      expect(
        assertDeploymentLookup(operation(kind), lookup(kind)),
      ).toMatchObject(lookup(kind));
    },
  );

  it("accepts only the exact echoed missing-result key, including UUID normalization", () => {
    expect(
      assertDeploymentLookup(operation("create"), {
        request_id: id(1).toUpperCase(),
        found: false,
      }),
    ).toEqual({ request_id: id(1).toUpperCase(), found: false });
  });

  it.each([
    { found: false },
    { request_id: id(9), found: false },
    { request_id: id(1), found: "false" },
    { request_id: id(1), found: false, deployment: receipt() },
    { request_id: id(1), found: true },
  ])("rejects malformed, legacy or unrelated missing results: %j", (value) => {
    expect(() => assertDeploymentLookup(operation("create"), value)).toThrow(
      /request|identity/,
    );
  });

  it.each([
    { request_id: id(9) },
    { operation: "create", source_deployment_id: null },
    { source_deployment_id: id(9) },
    { deployment: { ...receipt("rollback"), request_id: id(9) } },
    { deployment: { ...receipt("rollback"), source_deployment_id: id(9) } },
    { deployment: receipt("create") },
    { deployment: { ...receipt("rollback"), id: id(4) } },
  ])("rejects substituted lookup identities: %j", (change) => {
    expect(() =>
      assertDeploymentLookup(operation("rollback"), {
        ...lookup("rollback"),
        ...change,
      }),
    ).toThrow(/request|identity/);
  });
});
