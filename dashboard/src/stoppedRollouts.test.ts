import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentSummary } from "./api";
import {
  dismissStoppedRollout,
  readDismissed,
  stoppedRollouts,
} from "./stoppedRollouts";
import { needsYouRows } from "./overviewModel";

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
    const [item] = stoppedRollouts([summary()], now);
    expect(item.title).toBe(
      "Edge syslog processing v3 stopped after a failure",
    );
    expect(item.detail).toBe("1 failed · 2 not released");
    expect(item.consequence).toBe(
      "The rollout stopped; 2 devices never received v3.",
    );
    expect(item.released).toBe(1);
    expect(item.key).toBe(
      "00000000-0000-4000-8000-000000000021:failed:2026-09-29T08:13:40Z",
    );
  });
  it("says a delivery stop the way the rollout page does", () => {
    const [item] = stoppedRollouts(
      [
        summary({
          failure_reason: "data_plane",
          verified_count: 1,
          state_counts: { verified_applied: 1, pending: 2 },
        }),
      ],
      now,
    );
    expect(item.title).toBe(
      "Edge syslog processing v3 stopped: a device isn't delivering",
    );
  });
  it("drops failures that recovered, were replaced, rolled back or are older than a day", () => {
    expect(
      stoppedRollouts(
        [
          summary({
            verified_count: 3,
            state_counts: { verified_applied: 3 },
          }),
          summary({ target_count: 3, state_counts: { removed: 3 } }),
          summary({ failed_at: "2026-09-27T08:00:00Z" }),
          // Rolled back: resolved; its rollback shows under Rollouts.
          summary({
            rolled_back_by: "00000000-0000-4000-8000-000000000023",
            rolled_back_at: "2026-09-29T08:16:05Z",
          }),
          summary({ status: "cancelled" }),
        ],
        now,
      ),
    ).toEqual([]);
  });
});

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}
describe("dismissing a stopped rollout", () => {
  beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());
  it("remembers it per person and brings a new failure back", () => {
    const [item] = stoppedRollouts([summary()], now);
    const kept = dismissStoppedRollout("user-a", item.key, new Set());
    expect(kept.has(item.key)).toBe(true);
    expect(readDismissed("user-a").has(item.key)).toBe(true);
    expect(readDismissed("user-b").size).toBe(0);
    // The same rollout failing again later is a new stop.
    const [again] = stoppedRollouts(
      [summary({ failed_at: "2026-09-29T08:40:00Z" })],
      now,
    );
    expect(readDismissed("user-a").has(again.key)).toBe(false);
  });
  it("reads nothing from storage it can't parse or reach", () => {
    localStorage.setItem(
      `vectory-needs-you-dismissed:${JSON.stringify("user-a")}`,
      "{not json",
    );
    expect(readDismissed("user-a").size).toBe(0);
    localStorage.setItem(
      `vectory-needs-you-dismissed:${JSON.stringify("user-a")}`,
      JSON.stringify([1, "x".repeat(300), "kept"]),
    );
    expect([...readDismissed("user-a")]).toEqual(["kept"]);
    // Blocked storage: nothing is remembered, and dismissing still hides it
    // for this view.
    vi.stubGlobal("localStorage", {
      getItem() {
        throw Error("blocked");
      },
      setItem() {
        throw Error("blocked");
      },
    });
    expect(readDismissed("user-a").size).toBe(0);
    expect(dismissStoppedRollout("user-a", "k", new Set()).has("k")).toBe(true);
  });
});

describe("Needs you order", () => {
  const group = (
    cause: string,
    deployment_id: string | null = null,
  ): { cause: string; deployment_id: string | null } => ({
    cause,
    deployment_id,
  });
  it("puts data loss first, then failed applies, stopped rollouts, then the rest", () => {
    const stopped = stoppedRollouts(
      [
        summary(),
        summary({
          id: "00000000-0000-4000-8000-000000000022",
          failed_at: "2026-09-29T08:30:00Z",
        }),
      ],
      now,
    );
    const rows = needsYouRows(
      [
        group("offline"),
        group("failed", "00000000-0000-4000-8000-000000000099"),
        // The same rollout as the first stopped one, in capitals.
        group("degraded", "00000000-0000-4000-8000-000000000021".toUpperCase()),
        group("paused"),
      ],
      stopped,
      new Set(),
    );
    expect(
      rows.map((row) =>
        row.kind === "group"
          ? `${row.group.cause}${row.rollout ? `+${row.rollout.deployment.id.slice(-2)}` : ""}`
          : `rollout ${row.rollout.deployment.id.slice(-2)}`,
      ),
    ).toEqual(["degraded+21", "failed", "rollout 22", "offline", "paused"]);
  });
  it("reads a held device and the rollout that stopped around it as one row", () => {
    const stopped = stoppedRollouts(
      [
        summary(),
        summary({
          id: "00000000-0000-4000-8000-000000000022",
          failed_at: "2026-09-29T08:30:00Z",
        }),
      ],
      now,
    );
    const id = stopped.find((row) => row.deployment.id.endsWith("21"))!
      .deployment.id;
    const rows = needsYouRows(
      [
        group("offline"),
        group("held", id),
        // No rollout stopped for this one: it stays with the rest.
        group("held", "00000000-0000-4000-8000-000000000098"),
        group("failed"),
      ],
      stopped,
      new Set(),
    );
    expect(
      rows.map((row) =>
        row.kind === "group"
          ? `${row.group.cause}${row.rollout ? `+${row.rollout.deployment.id.slice(-2)}` : ""}`
          : `rollout ${row.rollout.deployment.id.slice(-2)}`,
      ),
    ).toEqual(["failed", "held+21", "rollout 22", "offline", "held"]);
  });
  it("merges a rollout into one group only and leaves dismissed rollouts out", () => {
    const stopped = stoppedRollouts([summary()], now);
    const id = stopped[0].deployment.id;
    const rows = needsYouRows(
      [group("degraded", id), group("failed", id)],
      stopped,
      new Set(),
    );
    expect(rows.map((row) => row.kind === "group" && !!row.rollout)).toEqual([
      true,
      false,
    ]);
    expect(
      needsYouRows([group("offline")], stopped, new Set([stopped[0].key])),
    ).toEqual([{ kind: "group", group: group("offline"), rollout: null }]);
  });
});
