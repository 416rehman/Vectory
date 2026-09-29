import { describe, expect, it } from "vitest";
import {
  countdown,
  describeDeployment,
  explainError,
  failedApplyStep,
  failureStagePhrase,
  progressSegments,
  releasePlan,
  targetLabel,
  timelineSteps,
  withDegraded,
  verifiedText,
} from "./deploymentStatus";

const base = {
  status: "completed",
  status_before_removal: null,
  status_before_rollback: null,
  rolled_back_by: null,
  rolled_back_to_version: null,
  replaced_by: [],
  failure_reason: null,
};

describe("rollout status keeps outcome separate from assignment changes", () => {
  it("labels a rolled-back completed rollout as rolled back, never cancelled", () => {
    expect(
      describeDeployment({
        ...base,
        status: "cancelled",
        status_before_rollback: "completed",
        rolled_back_by: "00000000-0000-4000-8000-000000000001",
        rolled_back_to_version: 2,
      }),
    ).toEqual({
      state: "rolled_back",
      label: "Rolled back",
      tone: "warning",
      note: "To v2 after completing",
    });
  });
  it("doesn't call a rollout failed once every device verified", () => {
    expect(
      describeDeployment({
        ...base,
        status: "failed",
        failure_reason: "threshold",
        target_count: 1,
        verified_count: 1,
        state_counts: { verified_applied: 1 },
      }),
    ).toEqual({
      state: "recovered",
      label: "Recovered",
      tone: "success",
      note: "Stopped after a failure; every device verified since",
    });
    expect(
      describeDeployment({
        ...base,
        status: "failed",
        failure_reason: "threshold",
        target_count: 3,
        verified_count: 1,
        state_counts: { verified_applied: 1, pending: 2 },
      }).label,
    ).toBe("Failed");
  });
  it("keeps the rollout outcome when its assignment is removed", () => {
    expect(
      describeDeployment({
        ...base,
        status: "unassigned",
        status_before_removal: "failed",
      }),
    ).toEqual({
      state: "failed",
      label: "Failed",
      tone: "danger",
      note: "Assignment removed",
    });
    expect(describeDeployment({ ...base, status: "unassigned" }).label).toBe(
      "Removed",
    );
  });
  it("names the replacing version", () => {
    const replaced = [
      {
        deployment_id: "00000000-0000-4000-8000-000000000002",
        device_count: 3,
        at: "2026-09-29T02:00:00Z",
        version_number: 3,
      },
    ];
    expect(
      describeDeployment({
        ...base,
        status: "unassigned",
        status_before_removal: "completed",
        replaced_by: replaced,
      }),
    ).toEqual({
      state: "replaced",
      label: "Replaced",
      tone: "neutral",
      note: "By v3",
    });
    expect(
      describeDeployment({ ...base, status: "active", replaced_by: replaced })
        .note,
    ).toBe("Replaced on 3 devices by v3");
  });
  it("uses one label for failed rollouts and explains why they stopped", () => {
    expect(
      describeDeployment({
        ...base,
        status: "failed",
        failure_reason: "threshold",
      }),
    ).toEqual({
      state: "failed",
      label: "Failed",
      tone: "danger",
      note: "Stopped after device failures",
    });
  });
  it("reads failed targets as failed (not needs attention)", () => {
    expect(targetLabel("failed")).toBe("Failed");
    expect(targetLabel("pending")).toBe("Queued");
    expect(targetLabel("pending", { stopped: true })).toBe("Not released");
    expect(targetLabel("removed", { replaced: true })).toBe("Replaced");
    expect(targetLabel("desired")).toBe("Waiting for agent");
  });
});

describe("progress segments", () => {
  it("counts only verified_applied as verified and keeps removed rows out", () => {
    const segments = progressSegments({
      verified_applied: 3,
      written: 1,
      downloaded: 1,
      desired: 2,
      failed: 1,
      rolled_back: 1,
      verification_unknown: 1,
      pending: 4,
      removed: 9,
      some_future_state: 1,
    });
    expect(Object.fromEntries(segments.map((s) => [s.key, s.count]))).toEqual({
      verified: 3,
      applying: 3,
      waiting: 2,
      attention: 1,
      failed: 2,
      queued: 4,
    });
    expect(
      progressSegments({}, { stopped: true }).find((s) => s.key === "queued")
        ?.label,
    ).toBe("Not released");
  });
});

describe("devices that verified but aren't delivering", () => {
  it("moves them from verified to failed so the bar agrees with the stages", () => {
    const recorded = { verified_applied: 2, pending: 1 };
    const { counts, moved } = withDegraded(recorded, 1);
    expect(moved).toBe(1);
    expect(counts).toEqual({ verified_applied: 1, pending: 1, degraded: 1 });
    const bar = Object.fromEntries(
      progressSegments(counts).map((s) => [s.key, s.count]),
    );
    expect(bar).toMatchObject({ verified: 1, failed: 1, queued: 1 });
    // The recorded counts are never changed.
    expect(recorded).toEqual({ verified_applied: 2, pending: 1 });
  });
  it("never moves more than were verified and ignores nonsense", () => {
    expect(withDegraded({ verified_applied: 1 }, 5).moved).toBe(1);
    expect(withDegraded({ pending: 3 }, 2).moved).toBe(0);
    for (const bad of [0, -1, Number.NaN])
      expect(withDegraded({ verified_applied: 2 }, bad).moved).toBe(0);
  });
  it("labels and explains a failed rollout stopped by delivery", () => {
    expect(targetLabel("degraded")).toBe("Not delivering");
    expect(
      describeDeployment({
        ...base,
        status: "failed",
        failure_reason: "data_plane",
      }).note,
    ).toBe("Stopped: a device isn't delivering");
  });
});

describe("release plan", () => {
  it("summarizes canary waves with an estimate", () => {
    expect(
      releasePlan({
        kind: "canary",
        devices: 3,
        canarySize: 1,
        batchSize: 1,
        observeSeconds: 0,
        checkInSeconds: 60,
      }),
    ).toEqual({
      waves: [1, 1, 1],
      seconds: 360,
      sentence:
        "1 canary device → 2 batches of 1 · about 6 min at 1 min check-ins",
    });
    expect(
      releasePlan({
        kind: "canary",
        devices: 12,
        canarySize: 2,
        batchSize: 4,
        observeSeconds: 60,
        checkInSeconds: 15,
      }).sentence,
    ).toBe(
      "2 canary devices → 3 batches of up to 4 · about 6 min at 15 s check-ins",
    );
    expect(
      releasePlan({
        kind: "all",
        devices: 3,
        canarySize: 1,
        batchSize: 1,
        observeSeconds: 60,
        checkInSeconds: 60,
      }).sentence,
    ).toBe("All 3 devices at once · about 2 min at 1 min check-ins");
    expect(
      releasePlan({
        kind: "canary",
        devices: 0,
        canarySize: 1,
        batchSize: 1,
        observeSeconds: 0,
        checkInSeconds: 60,
      }).sentence,
    ).toBe("No devices selected");
  });
});

describe("device timeline", () => {
  it("marks reached steps with their times and never invents skipped times", () => {
    const steps = timelineSteps({
      state: "verified_applied",
      released_at: "2026-09-29T02:00:00Z",
      verified_at: "2026-09-29T02:01:10Z",
      timeline: [
        { state: "desired", at: "2026-09-29T02:00:05Z" },
        { state: "validated", at: "2026-09-29T02:00:40Z" },
        { state: "verified_applied", at: "2026-09-29T02:01:10Z" },
      ],
    });
    expect(steps.map((s) => [s.key, s.state, s.at])).toEqual([
      ["released", "done", "2026-09-29T02:00:00Z"],
      ["downloaded", "done", null],
      ["validated", "done", "2026-09-29T02:00:40Z"],
      ["applied", "done", null],
      ["verified", "done", "2026-09-29T02:01:10Z"],
    ]);
  });
  it("marks the step after the last reached one as failed", () => {
    const steps = timelineSteps({
      state: "failed",
      released_at: "2026-09-29T02:00:00Z",
      verified_at: null,
      timeline: [
        { state: "desired", at: "2026-09-29T02:00:05Z" },
        { state: "downloaded", at: "2026-09-29T02:00:20Z" },
        { state: "failed", at: "2026-09-29T02:00:30Z" },
      ],
    });
    expect(steps.map((s) => s.state)).toEqual([
      "done",
      "done",
      "failed",
      "waiting",
      "waiting",
    ]);
  });
  it("starts over after a retry and waits for unreleased devices", () => {
    const retried = timelineSteps({
      state: "desired",
      released_at: "2026-09-29T02:00:00Z",
      verified_at: null,
      timeline: [
        { state: "desired", at: "2026-09-29T02:00:05Z" },
        { state: "validated", at: "2026-09-29T02:00:20Z" },
        { state: "failed", at: "2026-09-29T02:00:30Z" },
        { state: "desired", at: "2026-09-29T02:05:00Z" },
      ],
    });
    expect(retried.map((s) => s.state)).toEqual([
      "done",
      "current",
      "waiting",
      "waiting",
      "waiting",
    ]);
    expect(
      timelineSteps({
        state: "pending",
        released_at: null,
        verified_at: null,
      }).map((s) => s.state),
    ).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
  });
  it("blames the stage the agent reported, not the step after the last check-in", () => {
    // A 15 s heartbeat recorded nothing between release and the rollback.
    const steps = timelineSteps({
      state: "rolled_back",
      failure_stage: "rollback",
      released_at: "2026-09-29T08:13:00Z",
      verified_at: null,
      timeline: [{ state: "desired", at: "2026-09-29T08:13:02Z" }],
    });
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ["released", "done"],
      ["downloaded", "done"],
      ["validated", "done"],
      ["applied", "failed"],
      ["verified", "waiting"],
    ]);
    expect(
      timelineSteps({
        state: "failed",
        failure_stage: "validation",
        released_at: "2026-09-29T08:13:00Z",
        verified_at: null,
        timeline: [{ state: "desired", at: "2026-09-29T08:13:02Z" }],
      }).map((s) => s.state),
    ).toEqual(["done", "done", "failed", "waiting", "waiting"]);
  });
  it("places a rollback without a reported stage at Applied", () => {
    expect(
      timelineSteps({
        state: "rolled_back",
        released_at: "2026-09-29T08:13:00Z",
        verified_at: null,
        timeline: [],
      }).map((s) => s.state),
    ).toEqual(["done", "done", "done", "failed", "waiting"]);
  });
  it("maps agent stages to one apply step shared with the device page", () => {
    expect(failedApplyStep("validation")).toBe("validated");
    expect(failedApplyStep("rollback")).toBe("reloaded");
    expect(failedApplyStep("download")).toBe("downloaded");
    expect(failedApplyStep("apply")).toBeNull();
    expect(failureStagePhrase("rollback")).toBe("while restarting Vector");
    expect(failureStagePhrase("apply")).toBe("");
  });
});

describe("device counts on rollouts", () => {
  const counts = (
    target_count: number,
    verified_count: number,
    removed = 0,
    rolled_back_by: string | null = null,
  ) => ({
    target_count,
    verified_count,
    state_counts: (removed ? { removed } : {}) as Record<string, number>,
    rolled_back_by,
  });
  it("counts only the devices a rollout still follows", () => {
    expect(verifiedText(counts(3, 2))).toBe("2 of 3 verified");
    expect(verifiedText(counts(4, 2, 1))).toBe("2 of 3 verified");
  });
  it("says so when nothing follows it, or it was rolled back", () => {
    expect(verifiedText(counts(2, 0, 2))).toBe("No devices follow this now");
    expect(verifiedText(counts(0, 0))).toBe("No devices");
    expect(verifiedText(counts(3, 3, 0, "id"))).toBe(
      "3 of 3 verified, then rolled back",
    );
  });
});

describe("failure reasons", () => {
  it("explains known agent codes and keeps the code for support", () => {
    expect(explainError("APPLY_ROLLED_BACK (rollback)")).toEqual({
      summary:
        "Vector didn't come up healthy with this version, so the agent restored the last working config.",
      code: "APPLY_ROLLED_BACK (rollback)",
    });
    expect(explainError("Something else went wrong")).toEqual({
      summary: "Something else went wrong",
      code: null,
    });
    expect(explainError("UNKNOWN_CODE (apply)")?.code).toBeNull();
    expect(explainError(null)).toBeNull();
  });
});

describe("time formatting", () => {
  it("counts down and describes elapsed time", () => {
    expect(countdown(21_000)).toBe("0:21");
    expect(countdown(185_400)).toBe("3:06");
    expect(countdown(3_723_000)).toBe("1:02:03");
    expect(countdown(-5)).toBe("0:00");
  });
});
