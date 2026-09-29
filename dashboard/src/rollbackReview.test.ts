import { describe, expect, it } from "vitest";
import {
  RollbackPreviewSchema,
  assertReviewedRollbackReceipt,
  excludedDetail,
  locallyConfigured,
  nothingToRollBackTo,
  rollbackStory,
  type RollbackPreview,
  type RollbackReviewContext,
} from "./rollbackReview";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const preview = (): RollbackPreview => ({
  source_deployment_id: id(1),
  source_version_id: id(2),
  source_status: "completed",
  source_action: "cancel",
  previous_version_id: id(3),
  previous_version_number: 2,
  previous_configuration_id: id(4),
  previous_configuration_name: "Prior pipeline",
  priority: 101,
  eligible_devices: [
    {
      device_id: id(5),
      device_name: "Live device",
      artifact_sha256: "a".repeat(64),
    },
  ],
  excluded_devices: [
    { device_id: id(6), device_name: "Retired identity", reason: "revoked" },
  ],
  blockers: [],
  review_token: "a".repeat(64),
  ready: true,
});
describe("reviewed rollback scope", () => {
  it("accepts a complete review without conflating exclusions with eligible devices", () => {
    expect(RollbackPreviewSchema.parse(preview())).toEqual(preview());
    expect(
      RollbackPreviewSchema.parse({
        ...preview(),
        blockers: [
          { code: "MIXED_PRIOR_VERSIONS", reason: "Prior versions differ." },
        ],
        previous_version_id: null,
        ready: false,
      }).ready,
    ).toBe(false);
  });
  it.each([
    (v: RollbackPreview) => ({
      ...v,
      eligible_devices: [v.eligible_devices[0], v.eligible_devices[0]],
    }),
    (v: RollbackPreview) => ({
      ...v,
      excluded_devices: [
        {
          ...v.excluded_devices[0],
          device_id: v.eligible_devices[0].device_id,
        },
      ],
    }),
    (v: RollbackPreview) => ({ ...v, ready: false }),
    (v: RollbackPreview) => ({ ...v, previous_version_id: null }),
    (v: RollbackPreview) => ({ ...v, eligible_devices: [] }),
    (v: RollbackPreview) => ({ ...v, review_token: "A".repeat(64) }),
    (v: RollbackPreview) => ({
      ...v,
      eligible_devices: [{ ...v.eligible_devices[0], artifact_sha256: "bad" }],
    }),
    (v: RollbackPreview) => ({
      ...v,
      excluded_devices: [{ ...v.excluded_devices[0], reason: "offline" }],
    }),
    (v: RollbackPreview) => ({ ...v, requested_device_ids: [] }),
  ])("rejects an ambiguous or malformed review", (change) => {
    expect(RollbackPreviewSchema.safeParse(change(preview())).success).toBe(
      false,
    );
  });
  it("bounds the combined historical scope rather than each list independently", () => {
    const devices = Array.from({ length: 10000 }, (_, n) => ({
      device_id: id(n + 10),
      device_name: null,
      artifact_sha256: "a".repeat(64),
    }));
    expect(
      RollbackPreviewSchema.safeParse({
        ...preview(),
        eligible_devices: devices,
        excluded_devices: [],
      }).success,
    ).toBe(true);
    expect(
      RollbackPreviewSchema.safeParse({
        ...preview(),
        eligible_devices: devices,
      }).success,
    ).toBe(false);
  });
  it("requires an exact prior-version receipt, allowing target order to differ", () => {
    const review: RollbackReviewContext = {
      version_id: id(3),
      version_number: 2,
      configuration_name: "Prior pipeline",
      device_ids: [id(5), id(7)],
      excluded_count: 1,
    };
    const receipt = {
      id: id(8),
      version_id: id(3),
      targets: [{ device_id: id(7) }, { device_id: id(5) }],
      status: "active",
    };
    expect(() =>
      assertReviewedRollbackReceipt(review, id(1), receipt),
    ).not.toThrow();
    for (const wrong of [
      { ...receipt, id: id(1) },
      { ...receipt, version_id: id(2) },
      { ...receipt, targets: [{ device_id: id(5) }] },
      { ...receipt, targets: [{ device_id: id(5) }, { device_id: id(5) }] },
      { ...receipt, targets: [{ device_id: id(5) }, { device_id: id(6) }] },
      { ...receipt, targets: [...receipt.targets, { device_id: id(6) }] },
    ])
      expect(() => assertReviewedRollbackReceipt(review, id(1), wrong)).toThrow(
        /reviewed rollback/,
      );
  });
});

describe("rolling back a live canary", () => {
  const edge = {
    configuration_name: "Edge syslog processing",
    version_number: 1,
  };
  const canary = (): RollbackPreview => ({
    ...preview(),
    source_status: "active",
    previous_configuration_name: "Edge syslog processing",
    previous_version_number: 1,
    eligible_devices: [
      {
        device_id: id(5),
        device_name: "edge-nyc-02",
        artifact_sha256: "a".repeat(64),
      },
    ],
    excluded_devices: [
      {
        device_id: id(6),
        device_name: "edge-fra-01",
        reason: "not_released",
        effect: "unchanged",
        current: edge,
        next: null,
      },
      {
        device_id: id(7),
        device_name: "edge-nyc-01",
        reason: "not_released",
        effect: "unchanged",
        current: edge,
        next: null,
      },
    ],
  });
  it("accepts what excluded devices run afterwards and rejects anything else", () => {
    expect(RollbackPreviewSchema.parse(canary())).toEqual(canary());
    const bad = canary();
    (bad.excluded_devices[0] as Record<string, unknown>).effect = "moves";
    expect(RollbackPreviewSchema.safeParse(bad).success).toBe(false);
    const extra = canary();
    (extra.excluded_devices[0].current as Record<string, unknown>).id = id(9);
    expect(RollbackPreviewSchema.safeParse(extra).success).toBe(false);
  });
  it("says who returns, who keeps what, and that the rollout stops", () => {
    expect(rollbackStory(canary(), "r15-demo v1").map((l) => l.text)).toEqual([
      "edge-nyc-02 returns to Edge syslog processing v1.",
      "edge-fra-01 and edge-nyc-01 never received r15-demo v1 and keep Edge syslog processing v1 (no change).",
      "The rollout stops here.",
    ]);
    expect(excludedDetail(canary().excluded_devices[0], "r15-demo v1")).toBe(
      "Never received r15-demo v1 · keeps Edge syslog processing v1 (no change)",
    );
    // A stopped rollout doesn't stop again.
    expect(
      rollbackStory({ ...canary(), source_status: "failed" }, "r15-demo v1").at(
        -1,
      )?.text,
    ).not.toBe("The rollout stops here.");
  });
  it("names a device that would switch, and one still waiting for a rollout", () => {
    const web = { configuration_name: "Web access logs", version_number: 2 };
    const review = canary();
    review.excluded_devices = [
      { ...review.excluded_devices[0], effect: "fallback", next: web },
      { ...review.excluded_devices[1], effect: "retained_pending", next: web },
    ];
    const lines = rollbackStory(review, "r15-demo v1");
    expect(lines[1]).toEqual({
      text: "edge-fra-01 never received r15-demo v1 but would switch to Web access logs v2 once the rollout stops.",
      tone: "danger",
    });
    expect(lines[2].text).toBe(
      "edge-nyc-01 never received r15-demo v1 and keeps Edge syslog processing v1 until Web access logs v2 reaches it.",
    );
    expect(excludedDetail(review.excluded_devices[0], "r15-demo v1")).toBe(
      "Never received r15-demo v1 · would switch to Web access logs v2",
    );
  });
});

describe("rollback of a first deployment", () => {
  const first = (): RollbackPreview => ({
    ...preview(),
    previous_version_id: null,
    previous_version_number: null,
    previous_configuration_id: null,
    previous_configuration_name: null,
    eligible_devices: [
      { device_id: id(5), device_name: "edge-01", artifact_sha256: null },
    ],
    blockers: [
      {
        code: "PRIOR_VERSION_UNKNOWN",
        reason: "These devices ran their local config before this deployment.",
      },
    ],
    ready: false,
  });
  it("accepts a blocked review with no earlier artifact instead of a contract error", () => {
    const parsed = RollbackPreviewSchema.parse(first());
    expect(nothingToRollBackTo(parsed)).toBe(true);
    expect(locallyConfigured(parsed).map((d) => d.device_name)).toEqual([
      "edge-01",
    ]);
  });
  it("never accepts a ready review with an unknown artifact", () => {
    expect(
      RollbackPreviewSchema.safeParse({ ...first(), blockers: [], ready: true })
        .success,
    ).toBe(false);
  });
});
