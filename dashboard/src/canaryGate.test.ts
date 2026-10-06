import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanaryWatch, DeploymentSummary } from "./api";
import CanaryGate from "./CanaryGate";
import {
  readCanaryGate,
  readGateReason,
  type CanaryGate as Gate,
} from "./canaryGateModel";

const gate: Gate = {
  state: "waiting",
  released_count: 1,
  verified_count: 0,
  pending_count: 1,
  reasons: {
    superseded: 1,
    stale: 0,
    paused: 0,
    unverified: 0,
    unavailable: 0,
    measuring: 0,
    degraded: 0,
  },
  observation_started_at: null,
  observation_seconds: 60,
  evaluated_at: "2026-09-27T12:00:00Z",
};
const deployment = (
  value: unknown = gate,
  change: Partial<DeploymentSummary> = {},
) =>
  ({
    status: "active",
    rollout: { kind: "canary", observation_seconds: 60 },
    target_count: 2,
    verified_count: 1,
    canary_gate: value,
    ...change,
  }) as DeploymentSummary;
const render = (
  value: DeploymentSummary,
  readError = false,
  watch?: CanaryWatch,
) =>
  renderToStaticMarkup(
    createElement(CanaryGate, { deployment: value, readError, watch }),
  );
const observing: Gate = {
  ...gate,
  state: "observing",
  verified_count: 1,
  reasons: { ...gate.reasons, superseded: 0 },
  observation_started_at: "2026-09-27T11:59:00Z",
};

describe("current canary gate evidence", () => {
  it("does not use historical successes as current verification", () => {
    expect(readCanaryGate(deployment())?.verified_count).toBe(0);
    const html = render(deployment());
    expect(html).toContain(
      "Another assignment is effective on 1 released device",
    );
    expect(html).not.toContain("currently verified");
    expect(html).not.toContain("Observation in progress");
  });
  it("rejects malformed or contradictory gate evidence instead of showing a pass", () => {
    for (const invalid of [
      undefined,
      null,
      {},
      { ...observing, verified_count: 2 },
      { ...observing, released_count: 0 },
      { ...observing, reasons: gate.reasons },
      { ...observing, observation_started_at: null },
      { ...gate, observation_started_at: observing.observation_started_at },
      { ...observing, observation_started_at: "2026-09-27T12:00:01Z" },
      { ...gate, reasons: { ...gate.reasons, unknown: 1 } },
      { ...gate, released_count: Number.MAX_SAFE_INTEGER + 1 },
      { ...gate, pending_count: 2 },
      { ...gate, observation_seconds: 61 },
      { ...gate, evaluated_at: "not a timestamp" },
      { ...gate, state: "paused" },
    ]) {
      const input = { ...deployment(), canary_gate: invalid };
      expect(readCanaryGate(input)).toBeNull();
      expect(render(input)).toContain("Current gate details unavailable");
    }
  });
  it("keeps observation as a server snapshot, never a client release countdown", () => {
    expect(readCanaryGate(deployment(observing))?.state).toBe("observing");
    const html = render(deployment(observing));
    expect(html).toContain("Observation in progress");
    // One countdown, in the stage lane, and one refresh control, in the page
    // header: the gate carries neither.
    expect(html).not.toMatch(
      /remaining|releases in|complete in|next batch|role="timer"|role="progressbar"|Refresh/i,
    );
    expect(render(deployment(observing), true)).not.toContain(
      "Observation in progress",
    );
    expect(render(deployment(observing), true)).toContain(
      "Current gate details unavailable",
    );
  });
  it("separates a paused rollout from device pause and hides inactive or all-at-once gates", () => {
    expect(
      readCanaryGate(
        deployment({ ...gate, state: "paused" }, { status: "paused" }),
      )?.state,
    ).toBe("paused");
    expect(
      readCanaryGate(deployment(observing, { status: "paused" })),
    ).toBeNull();
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "scheduled",
      "missed",
      "unassigned",
    ])
      expect(render(deployment(observing, { status }))).toBe("");
    expect(
      render(
        deployment(observing, {
          rollout: { ...deployment().rollout, kind: "all" },
        }),
      ),
    ).toBe("");
  });
  it("explains devices still measuring delivery or not delivering", () => {
    const html = render(
      deployment({
        ...gate,
        reasons: { ...gate.reasons, superseded: 0, degraded: 1 },
      }),
    );
    expect(html).toContain("applied but isn&#x27;t delivering");
    expect(html).toContain("counts as a failure");
    expect(
      render(
        deployment({
          ...gate,
          reasons: { ...gate.reasons, superseded: 0, measuring: 1 },
        }),
      ),
    ).toContain("Measuring delivery");
    expect(readGateReason("degraded")).toBe("degraded");
  });
  it("names the device the gate waits on, in words the lanes agree with", () => {
    const measuring = deployment({
      ...gate,
      reasons: { ...gate.reasons, superseded: 0, measuring: 1 },
    });
    const watch: CanaryWatch = {
      window_seconds: 600,
      evaluated_at: "2026-09-27T12:00:00Z",
      more: 0,
      devices: [
        {
          device_id: "00000000-0000-4000-8000-000000000001",
          device_name: "edge-nyc-02",
          released_at: "2026-09-27T11:50:00Z",
          gate_reason: "measuring",
          now: null,
          baseline: null,
          samples: { measured: 2, needed: 3 },
        },
      ],
    };
    const html = render(measuring, false, watch);
    expect(html).toContain(
      "Measuring delivery on edge-nyc-02 (2 of 3 samples)",
    );
    // Without the lanes' names the gate still says something true.
    expect(render(measuring)).toContain(
      "Measuring delivery on 1 released device",
    );
    // The gate has nothing to press: refreshing is the page's one control.
    expect(html).not.toContain("<button");
  });
  it("reads gates from servers without data-plane health", () => {
    const { measuring: _m, degraded: _d, ...legacy } = gate.reasons;
    expect(
      readCanaryGate(deployment({ ...gate, reasons: legacy }))?.reasons
        .degraded,
    ).toBe(0);
  });
  it("never treats null or unknown per-device reasons as current verification", () => {
    for (const value of [undefined, null, "verified", "__proto__", {}, []])
      expect(readGateReason(value)).toBeNull();
    expect(readGateReason("stale")).toBe("stale");
  });
});
