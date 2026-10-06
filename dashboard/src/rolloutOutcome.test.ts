import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "./api";
import { outcomeText, rolloutOutcome } from "./rolloutOutcome";

const pipeline = "00000000-0000-4000-8000-000000000041";
const rollout = (overrides: Partial<DeploymentSummary>): DeploymentSummary =>
  ({
    id: "00000000-0000-4000-8000-000000000021",
    name: null,
    version_id: "00000000-0000-4000-8000-000000000031",
    policy: null,
    scheduled_at: null,
    configuration_id: pipeline,
    configuration_name: "Edge syslog processing",
    version_number: 4,
    status: "failed",
    created_at: "2026-10-02T18:57:14Z",
    failed_at: "2026-10-02T18:57:21Z",
    target_count: 3,
    verified_count: 0,
    state_counts: { rolled_back: 1, pending: 2 },
    ...overrides,
  }) as DeploymentSummary;

describe("how a pipeline version's last rollout ended", () => {
  it("reads a failed rollout by the devices it reached, not the ones it held back", () => {
    const outcome = rolloutOutcome([rollout({})], pipeline, 4);
    expect(outcome).toEqual({
      kind: "failed",
      deploymentId: "00000000-0000-4000-8000-000000000021",
      at: "2026-10-02T18:57:21Z",
      devices: 1,
    });
    expect(outcomeText(outcome!, 4)).toBe("v4 failed on 1 device");
  });

  it("reads a rolled-back rollout from when it was rolled back", () => {
    const outcome = rolloutOutcome(
      [
        rollout({
          status: "cancelled",
          failed_at: "2026-10-02T18:57:09Z",
          rolled_back_by: "00000000-0000-4000-8000-000000000022",
          rolled_back_at: "2026-10-02T18:57:41Z",
          target_count: 2,
          state_counts: { failed: 1, verified_applied: 1 },
        }),
      ],
      pipeline,
      4,
    );
    expect(outcome).toMatchObject({
      kind: "rolled_back",
      at: "2026-10-02T18:57:41Z",
      devices: 2,
    });
    expect(outcomeText(outcome!, 4)).toBe("v4 rolled back on 2 devices");
  });

  it("takes the newest of several endings of that version", () => {
    const older = rollout({
      id: "older",
      failed_at: "2026-10-01T10:00:00Z",
    });
    const newer = rollout({
      id: "newer",
      status: "cancelled",
      rolled_back_by: "x",
      rolled_back_at: "2026-10-02T09:00:00Z",
    });
    expect(rolloutOutcome([older, newer], pipeline, 4)?.deploymentId).toBe(
      "newer",
    );
    expect(rolloutOutcome([newer, older], pipeline, 4)?.deploymentId).toBe(
      "newer",
    );
  });

  it("ignores other versions, other pipelines and agent settings", () => {
    const rollouts = [
      rollout({ id: "other-version", version_number: 3 }),
      rollout({ id: "other-pipeline", configuration_id: "elsewhere" }),
      rollout({
        id: "settings",
        policy: { heartbeat_seconds: 15, sync_paused: false },
      } as Partial<DeploymentSummary>),
    ];
    expect(rolloutOutcome(rollouts, pipeline, 4)).toBeNull();
    expect(rolloutOutcome(rollouts, pipeline, 3)?.deploymentId).toBe(
      "other-version",
    );
  });

  it("says nothing about a rollout that did not end badly", () => {
    expect(
      rolloutOutcome(
        [
          rollout({ status: "completed", failed_at: null }),
          rollout({ status: "active", failed_at: null }),
        ],
        pipeline,
        4,
      ),
    ).toBeNull();
    expect(rolloutOutcome([], pipeline, 4)).toBeNull();
  });

  it("names no device count when none of its targets are still its own", () => {
    const outcome = rolloutOutcome(
      [rollout({ target_count: 1, state_counts: { removed: 1 } })],
      pipeline,
      4,
    );
    expect(outcome?.devices).toBeNull();
    expect(outcomeText(outcome!, 4)).toBe("v4 failed");
  });
});
