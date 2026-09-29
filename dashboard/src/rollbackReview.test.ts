import { describe, expect, it } from "vitest";
import {
  RollbackPreviewSchema,
  assertReviewedRollbackReceipt,
  locallyConfigured,
  nothingToRollBackTo,
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
