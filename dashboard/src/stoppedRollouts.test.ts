import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "./api";
import { stoppedRollouts } from "./stoppedRollouts";

const now = Date.parse("2026-09-29T09:00:00Z");
const summary = (
  overrides: Partial<DeploymentSummary> = {},
): DeploymentSummary =>
  ({
    id: "00000000-0000-4000-8000-000000000021",
    name: null,
    version_id: "00000000-0000-4000-8000-000000000031",
    policy: null,
    scheduled_at: null,
    configuration_id: "00000000-0000-4000-8000-000000000041",
    configuration_name: "Edge syslog processing",
    version_number: 3,
    status: "failed",
    failure_reason: "threshold",
    failed_at: "2026-09-29T08:13:40Z",
    created_at: "2026-09-29T08:13:00Z",
    target_count: 3,
    verified_count: 0,
    state_counts: { rolled_back: 1, pending: 2 },
    ...overrides,
  }) as DeploymentSummary;

describe("stopped rollouts on the Overview", () => {
  it("lists a rollout that stopped at its canary with what it left behind", () => {
    const [item] = stoppedRollouts([summary()], [], now);
    expect(item.kind).toBe("stopped");
    expect(item.title).toBe(
      "Edge syslog processing v3 stopped after a failure",
    );
    expect(item.detail).toBe("1 failed · 2 not released");
  });
  it("drops failures that recovered, were replaced or are older than a day", () => {
    expect(
      stoppedRollouts(
        [
          summary({
            verified_count: 3,
            state_counts: { verified_applied: 3 },
          }),
          summary({ target_count: 3, state_counts: { removed: 3 } }),
          summary({ failed_at: "2026-09-27T08:00:00Z" }),
        ],
        [],
        now,
      ),
    ).toEqual([]);
  });
  it("keeps a recent rollback, newest first, with the version it restored", () => {
    const items = stoppedRollouts(
      [summary({ failed_at: "2026-09-29T08:00:00Z" })],
      [
        summary({
          id: "00000000-0000-4000-8000-000000000022",
          status: "cancelled",
          rolled_back_by: "00000000-0000-4000-8000-000000000023",
          rolled_back_at: "2026-09-29T08:16:05Z",
          rolled_back_to_version: 2,
        }),
      ],
      now,
    );
    expect(items.map((item) => item.kind)).toEqual(["rolled_back", "stopped"]);
    expect(items[0].title).toBe(
      "Edge syslog processing v3 was rolled back to v2",
    );
  });
});
