import { describe, expect, it } from "vitest";
import {
  ScheduledAssignmentRefreshPreviewSchema,
  assertScheduledAssignmentRefreshPreview,
  assertScheduledAssignmentRefreshReceipt,
  assertScheduledAssignmentRefreshStatus,
  getScheduleRefreshUncertainty,
  setScheduleRefreshUncertainty,
  sameScheduleSelection,
  scheduleSelectionRows,
} from "./scheduledAssignmentRefreshModel";

const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const source = id(1),
  alpha = id(2),
  beta = id(3),
  gamma = id(4);
const device = (identity: string, name: string | null = "Device") => ({
  id: identity,
  name,
  status: "online",
});
const preview = () => ({
  refresh_review: true as const,
  source_deployment_id: source,
  source_status: "scheduled" as const,
  resource: "configuration" as const,
  scheduled_at: "2026-09-28T16:00:00Z",
  ready: true,
  review_token: "a".repeat(64),
  saved_devices: [device(alpha, "Alpha")],
  devices: [device(alpha, "Alpha"), device(beta, "Beta")],
  warnings: ["Activation checks priority separately."],
  blockers: [] as { code: string; reason: string }[],
});
const receipt = () => ({
  id: source,
  name: "Morning schedule",
  version_id: id(9),
  policy: null,
  selector: { device_ids: [], group_ids: [id(8)], exclude_ids: [] },
  priority: 0,
  target_mode: "snapshot",
  status: "scheduled",
  scheduled_at: "2026-09-28T16:00:00Z",
  created_at: "2026-09-27T00:00:00Z",
  targets: [alpha, beta].map((device_id) => ({
    device_id,
    state: "pending",
    generation: 0,
    error: null,
    original: true,
  })),
  rollout: {
    kind: "all",
    canary_size: 1,
    batch_size: 10,
    observation_seconds: 0,
    failure_threshold: 0,
  },
});

describe("scheduled-device review", () => {
  it("keeps exact saved/proposed scope with friendly metadata and case-insensitive source identity", () => {
    expect(
      assertScheduledAssignmentRefreshPreview(source.toUpperCase(), preview()),
    ).toEqual(preview());
  });
  it.each([
    ["missing supporting capability", { refresh_review: undefined }],
    ["wrong source", { source_deployment_id: id(50) }],
    ["unknown source status", { source_status: "running" }],
    ["missing scheduled time", { scheduled_at: null }],
    ["invalid token", { review_token: "A".repeat(64) }],
    ["missing warnings", { warnings: undefined }],
    ["unexpected root field", { extra: true }],
    [
      "duplicate saved identity",
      { saved_devices: [device(alpha), device(alpha.toUpperCase())] },
    ],
    [
      "duplicate proposed identity",
      { devices: [device(beta), device(beta.toUpperCase())] },
    ],
    ["false ready with no blockers", { ready: false }],
    ["empty unblocked selection", { devices: [], ready: false }],
    ["empty ready selection", { devices: [] }],
    [
      "inactive unblocked selection",
      { source_status: "active", devices: [], ready: false },
    ],
    [
      "inactive proposed targets",
      {
        source_status: "active",
        ready: false,
        blockers: [{ code: "SCHEDULE_INACTIVE", reason: "Already activated" }],
      },
    ],
    [
      "ready with a blocker",
      { blockers: [{ code: "NO_TARGETS", reason: "Select a device" }] },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(() =>
      assertScheduledAssignmentRefreshPreview(source, {
        ...preview(),
        ...patch,
      }),
    ).toThrow();
  });
  it("accepts honest empty-selection and inactive blockers without proposing removals", () => {
    const empty = {
      ...preview(),
      devices: [],
      ready: false,
      blockers: [{ code: "NO_TARGETS", reason: "No eligible members" }],
    };
    expect(
      ScheduledAssignmentRefreshPreviewSchema.safeParse(empty).success,
    ).toBe(true);
    const inactive = assertScheduledAssignmentRefreshPreview(source, {
      ...empty,
      source_status: "completed",
      blockers: [{ code: "SCHEDULE_INACTIVE", reason: "Already activated" }],
    });
    expect(scheduleSelectionRows(inactive)).toEqual([
      { ...device(alpha, "Alpha"), change: "kept" },
    ]);
  });
  it("bounds the combined review while permitting the same10000 identities on both sides", () => {
    const all = Array.from({ length: 10000 }, (_, n) => device(id(n + 100)));
    expect(
      ScheduledAssignmentRefreshPreviewSchema.safeParse({
        ...preview(),
        saved_devices: all,
        devices: all,
      }).success,
    ).toBe(true);
    expect(
      ScheduledAssignmentRefreshPreviewSchema.safeParse({
        ...preview(),
        saved_devices: all,
        devices: [device(id(99999))],
      }).success,
    ).toBe(false);
  });
  it("bounds unicode names, diagnostics and status without assuming ASCII names", () => {
    expect(
      ScheduledAssignmentRefreshPreviewSchema.safeParse({
        ...preview(),
        devices: [device(alpha, "😀".repeat(240))],
      }).success,
    ).toBe(true);
    for (const patch of [
      { devices: [device(alpha, "😀".repeat(241))] },
      { warnings: ["x".repeat(1001)] },
      { devices: [{ ...device(alpha), status: "" }] },
    ])
      expect(
        ScheduledAssignmentRefreshPreviewSchema.safeParse({
          ...preview(),
          ...patch,
        }).success,
      ).toBe(false);
  });
  it("creates a stable union with meaningful added/kept/removed values and retained saved names", () => {
    const input = {
      ...preview(),
      saved_devices: [device(alpha, "Alpha"), device(gamma, "Gamma")],
      devices: [device(beta, "Beta"), device(alpha.toUpperCase(), null)],
    };
    expect(scheduleSelectionRows(input)).toEqual([
      { ...device(beta, "Beta"), change: "added" },
      { ...device(alpha.toUpperCase(), "Alpha"), change: "kept" },
      { ...device(gamma, "Gamma"), change: "removed" },
    ]);
    expect(input.devices[1].name).toBeNull();
    expect(
      sameScheduleSelection([alpha, beta], [beta, alpha.toUpperCase()]),
    ).toBe(true);
    expect(sameScheduleSelection([alpha], [beta])).toBe(false);
  });
});

describe("scheduled refresh receipts and current-state observations", () => {
  it("requires full exact pending generation-zero targets while allowing ordering and metadata differences", () => {
    expect(
      assertScheduledAssignmentRefreshReceipt(source, [beta, alpha], {
        ...receipt(),
        name: "Later display name",
        targets: receipt().targets.reverse(),
      }),
    ).toMatchObject({ status: "scheduled" });
  });
  it.each([
    ["wrong source", { id: id(99) }],
    ["activated receipt", { status: "active" }],
    [
      "wrong targets",
      { targets: [{ device_id: gamma, state: "pending", generation: 0 }] },
    ],
    [
      "duplicate targets",
      { targets: [receipt().targets[0], receipt().targets[0]] },
    ],
    [
      "released generation",
      {
        targets: [
          { ...receipt().targets[0], generation: 1 },
          receipt().targets[1],
        ],
      },
    ],
    [
      "nonpending state",
      {
        targets: [
          { ...receipt().targets[0], state: "desired" },
          receipt().targets[1],
        ],
      },
    ],
    ["missing rollout", { rollout: undefined }],
    ["missing selector", { selector: undefined }],
    ["persistent mode", { target_mode: "persistent" }],
  ])("leaves %s unconfirmed", (_name, patch) => {
    expect(() =>
      assertScheduledAssignmentRefreshReceipt(source, [alpha, beta], {
        ...receipt(),
        ...patch,
      }),
    ).toThrow();
  });
  it("does not accept malformed expected IDs even if the response contains a matching set", () => {
    expect(() =>
      assertScheduledAssignmentRefreshReceipt(
        source,
        [alpha, beta, alpha],
        receipt(),
      ),
    ).toThrow();
  });
  it("an exact known status is current-state information, not target-selection or request confirmation", () => {
    expect(
      assertScheduledAssignmentRefreshStatus(source, {
        id: source.toUpperCase(),
        status: "completed",
        target_count: 12,
      }),
    ).toEqual({ id: source.toUpperCase(), status: "completed" });
    for (const value of [
      { id: gamma, status: "scheduled" },
      { id: source, status: "unknown" },
      { id: source },
    ])
      expect(() =>
        assertScheduledAssignmentRefreshStatus(source, value),
      ).toThrow();
  });
  it("keeps uncertainty actor/source isolated across component remount with defensive copies", () => {
    const original = [alpha, beta];
    setScheduleRefreshUncertainty("actor-a", source, original);
    original.pop();
    const read = getScheduleRefreshUncertainty(
      "actor-a",
      source.toUpperCase(),
    )!;
    read.pop();
    expect(getScheduleRefreshUncertainty("actor-a", source)).toEqual([
      alpha,
      beta,
    ]);
    expect(getScheduleRefreshUncertainty("actor-b", source)).toBeNull();
    expect(getScheduleRefreshUncertainty("actor-a", gamma)).toBeNull();
    setScheduleRefreshUncertainty("actor-a", source, null);
    expect(getScheduleRefreshUncertainty("actor-a", source)).toBeNull();
  });
});
