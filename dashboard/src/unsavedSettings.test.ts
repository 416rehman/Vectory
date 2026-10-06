import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "./api";
import { unsavedSettings } from "./Control";

const settings = (
  overrides: Partial<DeploymentSummary> = {},
): DeploymentSummary =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    name: null,
    version_id: null,
    policy: {
      heartbeat_seconds: 15,
      sync_paused: false,
      telemetry_enabled: true,
    },
    policy_id: null,
    status: "completed",
    target_count: 4,
    verified_count: 4,
    state_counts: { verified_applied: 4 },
    created_at: "2026-09-29T08:00:00Z",
    ...overrides,
  }) as DeploymentSummary;

describe("agent settings applied without saving", () => {
  it("lists settings deployments that have no saved record and still reach devices", () => {
    const rows = unsavedSettings([settings()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deployments.map((d) => d.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
  });
  it("skips saved settings, pipelines, rollbacks, removals and empty rollouts", () => {
    expect(
      unsavedSettings([
        settings({ policy_id: "00000000-0000-4000-8000-000000000009" }),
        settings({ policy: null, version_id: "v" }),
        settings({ rolled_back_by: "00000000-0000-4000-8000-000000000008" }),
        settings({ status: "unassigned" }),
        settings({ status: "failed" }),
        settings({ target_count: 2, state_counts: { removed: 2 } }),
      ]),
    ).toEqual([]);
  });
  it("shows each distinct set of values once, newest first", () => {
    const newest = settings({ id: "00000000-0000-4000-8000-000000000002" });
    const rows = unsavedSettings([
      newest,
      settings({
        id: "00000000-0000-4000-8000-000000000004",
        policy: {
          heartbeat_seconds: 60,
          sync_paused: true,
          telemetry_enabled: true,
        },
      }),
    ]);
    expect(rows.map((row) => row.deployments[0].id)).toEqual([
      newest.id,
      "00000000-0000-4000-8000-000000000004",
    ]);
  });
  it("keeps every deployment that applies the same values, so no device goes uncounted", () => {
    // Three devices run the values: one through the newer deployment and two
    // through the older one. One entry must still account for all three.
    const newer = settings({
      id: "00000000-0000-4000-8000-000000000002",
      target_count: 1,
      state_counts: { verified_applied: 1 },
    });
    const older = settings({
      id: "00000000-0000-4000-8000-000000000003",
      target_count: 2,
      state_counts: { verified_applied: 2 },
    });
    const rows = unsavedSettings([newer, older]);
    expect(rows).toHaveLength(1);
    expect(rows[0].policy).toEqual(newer.policy);
    expect(rows[0].deployments.map((d) => d.id)).toEqual([newer.id, older.id]);
    expect(rows[0].deployments.map((d) => d.target_count)).toEqual([1, 2]);
  });
  it("leaves a deployment out of its entry once its devices have all left", () => {
    const older = settings({
      id: "00000000-0000-4000-8000-000000000003",
      target_count: 2,
      state_counts: { removed: 2 },
    });
    const rows = unsavedSettings([
      settings({ id: "00000000-0000-4000-8000-000000000002" }),
      older,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deployments.map((d) => d.id)).toEqual([
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
});
