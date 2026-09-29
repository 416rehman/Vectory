import { z } from "zod";

const uuid = z.string().uuid();
const name = z.string().refine((s) => [...s].length <= 240);
const device = z
  .object({ device_id: uuid, device_name: name.nullable() })
  .strict();
const eligibleDevice = device.extend({ artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const rollbackToken = z.string().regex(/^[a-f0-9]{64}$/);
export const RollbackPreviewSchema = z
  .object({
    source_deployment_id: uuid,
    source_version_id: uuid,
    source_status: z.string().min(1).max(64),
    source_action: z.enum(["cancel", "unassign"]),
    previous_version_id: uuid.nullable(),
    previous_version_number: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    previous_configuration_id: uuid.nullable(),
    previous_configuration_name: name.nullable(),
    priority: z.number().int().min(-1000000).max(1000000),
    eligible_devices: z.array(eligibleDevice).max(10000),
    excluded_devices: z
      .array(
        device
          .extend({
            reason: z.enum(["revoked", "removed", "not_released", "missing"]),
          })
          .strict(),
      )
      .max(10000),
    blockers: z
      .array(
        z
          .object({
            code: z.string().min(1).max(64),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(10000),
    review_token: rollbackToken,
    ready: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = [...v.eligible_devices, ...v.excluded_devices].map((d) =>
      d.device_id.toLowerCase(),
    );
    if (ids.length > 10000 || new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Rollback scope must contain distinct device identities.",
      });
    if (
      v.ready !==
      (v.blockers.length === 0 &&
        v.eligible_devices.length > 0 &&
        v.previous_version_id !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Rollback readiness does not match its reviewed scope.",
      });
  });
export type RollbackPreview = z.infer<typeof RollbackPreviewSchema>;
export const RollbackReviewContextSchema = z
  .object({
    version_id: uuid,
    version_number: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    configuration_name: name.nullable(),
    device_ids: z
      .array(uuid)
      .min(1)
      .max(10000)
      .refine(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      ),
    excluded_count: z.number().int().min(0).max(10000),
  })
  .strict()
  .refine((v) => v.device_ids.length + v.excluded_count <= 10000);
export type RollbackReviewContext = z.infer<typeof RollbackReviewContextSchema>;

export function assertReviewedRollbackReceipt(
  review: RollbackReviewContext,
  source: string,
  value: unknown,
) {
  const receipt = z
    .object({
      id: uuid,
      version_id: uuid,
      targets: z.array(z.object({ device_id: uuid })).max(10000),
    })
    .safeParse(value);
  const expected = new Set(review.device_ids.map((id) => id.toLowerCase()));
  if (
    !receipt.success ||
    receipt.data.id.toLowerCase() === source.toLowerCase() ||
    receipt.data.version_id.toLowerCase() !== review.version_id.toLowerCase() ||
    receipt.data.targets.length !== expected.size ||
    new Set(receipt.data.targets.map((d) => d.device_id.toLowerCase())).size !==
      expected.size ||
    receipt.data.targets.some((d) => !expected.has(d.device_id.toLowerCase()))
  )
    throw Error(
      "The response does not match the reviewed rollback. Confirm the original request before sending another.",
    );
}
