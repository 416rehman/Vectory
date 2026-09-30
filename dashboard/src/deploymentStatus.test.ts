import { describe, expect, it } from "vitest";
import {
  applyStepTable,
  countdown,
  degradedInLanes,
  describeDeployment,
  explainError,
  failedApplyStep,
  failureStagePhrase,
  failureText,
  lineageLabel,
  pipelineFixable,
  progressLine,
  progressParts,
  progressSegments,
  releasePlan,
  requestRollbackReview,
  rolloutProgress,
  takeRollbackReview,
  targetLabel,
  timelineSteps,
  withDegraded,
  appliedText,
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

describe("one rollout reads the same on every surface", () => {
  // Three devices took the rollout and all three applied it; one of them
  // isn't delivering. The Overview and the deployment list get the server's
  // `degraded` count; the rollout page counts the delivery failures its lanes
  // list. One state_counts and one degraded count go through both.
  const stateCounts = { verified_applied: 3 };
  const lanes = [
    { state: "degraded", count: 1 },
    { state: "failed", count: 4 },
  ];
  const lanesDegraded = degradedInLanes(lanes.slice(0, 1));

  it("counts devices that aren't delivering out of the applied ones", () => {
    const overview = rolloutProgress(stateCounts, 1);
    const page = rolloutProgress(stateCounts, lanesDegraded);
    expect(page).toEqual(overview);
    expect(overview).toMatchObject({
      total: 3,
      applied: 2,
      notDelivering: 1,
      failed: 0,
      needsCheck: 0,
    });
    expect(progressLine(overview)).toBe(
      "2 of 3 devices applied · 1 not delivering",
    );
    expect(progressParts(page)).toEqual({
      figure: "2 of 3",
      noun: "devices",
      notes: ["1 not delivering"],
    });
    expect(
      appliedText({
        target_count: 3,
        verified_count: 3,
        state_counts: stateCounts,
        rolled_back_by: null,
        degraded: 1,
      }),
    ).toBe("2 of 3 applied · 1 not delivering");
  });

  it("draws the bar from the same numbers", () => {
    const { counts } = rolloutProgress(stateCounts, 1);
    const bar = Object.fromEntries(
      progressSegments(counts).map((s) => [s.key, s.count]),
    );
    expect(bar).toMatchObject({ verified: 2, failed: 1 });
    // The recorded counts are never changed.
    expect(stateCounts).toEqual({ verified_applied: 3 });
  });

  it("keeps not delivering apart from failed applies and devices to check", () => {
    const progress = rolloutProgress(
      { verified_applied: 2, failed: 1, verification_unknown: 2, pending: 1 },
      1,
    );
    expect(progress).toMatchObject({
      total: 6,
      applied: 1,
      notDelivering: 1,
      failed: 1,
      needsCheck: 2,
    });
    expect(progressLine(progress)).toBe(
      "1 of 6 devices applied · 1 not delivering · 1 failed · 2 need a check",
    );
  });

  it("reads a rollout with nothing wrong plainly, in the singular for one device", () => {
    expect(progressLine(rolloutProgress({ verified_applied: 1 }))).toBe(
      "1 of 1 device applied",
    );
    expect(
      progressLine(rolloutProgress({ verification_unknown: 1, pending: 1 })),
    ).toBe("0 of 2 devices applied · 1 needs a check");
    expect(rolloutProgress({}, 3)).toMatchObject({
      total: 0,
      notDelivering: 0,
    });
  });

  it("only counts lane failures that are delivery failures", () => {
    expect(degradedInLanes(lanes)).toBe(1);
    expect(degradedInLanes([])).toBe(0);
    expect(
      degradedInLanes([
        { state: "degraded", count: 2 },
        { state: "degraded", count: 1 },
        { count: 5 },
      ]),
    ).toBe(3);
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
      ["written", "done", null],
      ["reloaded", "done", null],
      ["verified", "done", "2026-09-29T02:01:10Z"],
    ]);
    expect(steps.map((s) => s.label)).toEqual([
      "Released",
      "Downloaded",
      "Validated",
      "Written",
      "Loaded in Vector",
      "Applied",
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
      "waiting",
    ]);
    expect(
      timelineSteps({
        state: "pending",
        released_at: null,
        verified_at: null,
      }).map((s) => s.state),
    ).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
      "waiting",
      "waiting",
    ]);
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
      ["written", "done"],
      ["reloaded", "failed"],
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
    ).toEqual(["done", "done", "failed", "waiting", "waiting", "waiting"]);
  });
  it("marks Loaded in Vector, not Written, when the reload fails (a port clash)", () => {
    const steps = timelineSteps({
      state: "rolled_back",
      failure_stage: "reload",
      released_at: "2026-09-29T16:54:04Z",
      verified_at: null,
      timeline: [
        { state: "desired", at: "2026-09-29T16:54:05Z" },
        { state: "written", at: "2026-09-29T16:54:07Z" },
        { state: "rolled_back", at: "2026-09-29T16:54:09Z" },
      ],
    });
    expect(steps.find((s) => s.state === "failed")?.label).toBe(
      "Loaded in Vector",
    );
    expect(steps.find((s) => s.key === "written")).toMatchObject({
      state: "done",
      at: "2026-09-29T16:54:07Z",
    });
  });
  it("places a rollback without a reported stage at Loaded in Vector", () => {
    expect(
      timelineSteps({
        state: "rolled_back",
        released_at: "2026-09-29T08:13:00Z",
        verified_at: null,
        timeline: [],
      }).map((s) => s.state),
    ).toEqual(["done", "done", "done", "done", "failed", "waiting"]);
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
    expect(appliedText(counts(3, 2))).toBe("2 of 3 applied");
    expect(appliedText(counts(4, 2, 1))).toBe("2 of 3 applied");
  });
  it("says so when nothing follows it, or it was rolled back", () => {
    expect(appliedText(counts(2, 0, 2))).toBe("No devices follow this now");
    expect(appliedText(counts(0, 0))).toBe("No devices");
    expect(appliedText(counts(3, 3, 0, "id"))).toBe(
      "3 of 3 applied, then rolled back",
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
  it("prints the reason once: the diagnostic, then what happened if it differs", () => {
    // A port clash: the diagnostic is the cause, the code says what happened.
    expect(
      failureText(
        "Another process is already listening on this component's address.",
        "APPLY_ROLLED_BACK (reload)",
      ),
    ).toEqual({
      reason:
        "Another process is already listening on this component's address.",
      effect:
        "Vector didn't come up healthy with this version, so the agent restored the last working config.",
      code: "APPLY_ROLLED_BACK (reload)",
    });
    // The error repeats the diagnostic: one sentence, not two.
    expect(failureText("Port 9598 is in use", "Port 9598 is in use.")).toEqual({
      reason: "Port 9598 is in use",
      effect: null,
      code: null,
    });
    // Without a diagnostic, the code's explanation is the reason.
    expect(failureText(null, "WRITE_FAILED")).toEqual({
      reason: "The agent couldn't write the configuration file.",
      effect: null,
      code: "WRITE_FAILED",
    });
    expect(failureText("  ", null)).toEqual({
      reason: null,
      effect: null,
      code: null,
    });
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

describe("lineage names the pipeline whenever it crosses to another", () => {
  it("prints the version alone within the page's own pipeline", () => {
    expect(
      lineageLabel(
        { configuration_name: "r15-demo", version_number: 3 },
        "r15-demo",
      ),
    ).toBe("v3");
    expect(
      lineageLabel(
        { configuration_name: "Edge syslog processing", version_number: 1 },
        "r15-demo",
      ),
    ).toBe("Edge syslog processing v1");
    // Older servers send only the number: it stays a number.
    expect(lineageLabel({ version_number: 2 }, "r15-demo")).toBe("v2");
    expect(lineageLabel({}, "r15-demo")).toBe("another version");
    expect(lineageLabel({}, "r15-demo", "an earlier rollout")).toBe(
      "an earlier rollout",
    );
  });
  it("says where a rolled-back rollout returned its devices, by name", () => {
    const rolledBack = {
      ...base,
      status: "cancelled",
      status_before_rollback: "active",
      rolled_back_by: "00000000-0000-4000-8000-000000000001",
      rolled_back_to_version: 1,
      configuration_name: "r15-demo",
      rolled_back_to_configuration_name: "Edge syslog processing",
    };
    expect(describeDeployment(rolledBack).note).toBe(
      "To Edge syslog processing v1",
    );
    expect(
      describeDeployment({
        ...rolledBack,
        rolled_back_to_configuration_name: "r15-demo",
        status_before_rollback: "failed",
      }).note,
    ).toBe("To v1 after failing");
  });
  it("names the replacing pipeline when it differs", () => {
    expect(
      describeDeployment({
        ...base,
        status: "unassigned",
        status_before_removal: "completed",
        configuration_name: "Edge syslog processing",
        replaced_by: [
          {
            deployment_id: "00000000-0000-4000-8000-000000000002",
            device_count: 1,
            at: "2026-09-29T02:00:00Z",
            version_number: 3,
            configuration_name: "r15-demo",
          },
        ],
      }).note,
    ).toBe("By r15-demo v3");
  });
});

describe("failures only a pipeline change can clear", () => {
  it("recognises a port in use, VRL errors and invalid options", () => {
    for (const code of [
      "ADDRESS_IN_USE",
      "VRL_E100",
      "INVALID_ADDRESS",
      "UNKNOWN_FIELD",
      "INPUT_NOT_FOUND",
    ])
      expect(pipelineFixable(code), code).toBe(true);
    for (const code of [
      "DATA_DIR_MISSING",
      "PERMISSION_DENIED",
      "DATA_PLANE_SINK_ERRORS",
      "",
      null,
      undefined,
    ])
      expect(pipelineFixable(code), String(code)).toBe(false);
  });
});

describe("opening the rollback review from elsewhere", () => {
  it("opens once, for the named rollout, and only soon after the request", () => {
    const id = "00000000-0000-4000-8000-00000000000A";
    requestRollbackReview(id, 1000);
    expect(takeRollbackReview(id.toLowerCase(), 2000)).toBe(true);
    expect(takeRollbackReview(id, 2001)).toBe(false);
    requestRollbackReview(id, 1000);
    expect(
      takeRollbackReview("00000000-0000-4000-8000-00000000000b", 1001),
    ).toBe(false);
    expect(takeRollbackReview(id, 1002)).toBe(false);
    requestRollbackReview(id, 1000);
    expect(takeRollbackReview(id, 31_001)).toBe(false);
  });
});

describe("one apply table for the device page and the rollout page", () => {
  it("lists six steps with the state that reaches each", () => {
    expect(applyStepTable.map((step) => [step.label, step.state])).toEqual([
      ["Released", "desired"],
      ["Downloaded", "downloaded"],
      ["Validated", "validated"],
      ["Written", "written"],
      ["Loaded in Vector", "reload_requested"],
      ["Applied", "verified_applied"],
    ]);
  });
});
