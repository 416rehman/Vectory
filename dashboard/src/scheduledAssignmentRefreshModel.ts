import { z } from "zod";

const uuid = z.string().uuid();
const ids = z.array(uuid).max(10000);
const timestamp = z.string().datetime({ offset: true });
const sourceStatus = z.enum([
  "scheduled",
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "missed",
  "unassigned",
]);
const normalized = (id: string) => id.toLowerCase();
const distinct = (values: string[]) =>
  new Set(values.map(normalized)).size === values.length;
const device = z
  .object({
    id: uuid,
    name: z
      .string()
      .refine((value) => [...value].length <= 240)
      .nullable(),
    status: z.string().min(1).max(64),
  })
  .strict();
// A compatibility blocker (full mode, Vector version) also says which devices
// it affects and for which resource; the other blockers speak for the whole
// schedule and carry a code and a reason only.
const blocker = z
  .object({
    code: z.string().min(1).max(64),
    reason: z.string().min(1).max(1000),
    resource: z.enum(["configuration", "policy"]).optional(),
    device_ids: ids.optional(),
  })
  .strict()
  .refine((value) => !value.device_ids || distinct(value.device_ids), {
    message: "A blocker names each device once.",
  });

export const ScheduledAssignmentRefreshPreviewSchema = z
  .object({
    refresh_review: z.literal(true),
    source_deployment_id: uuid,
    source_status: sourceStatus,
    resource: z.enum(["configuration", "policy"]),
    scheduled_at: timestamp,
    ready: z.boolean(),
    review_token: z.string().regex(/^[a-f0-9]{64}$/),
    saved_devices: z.array(device).max(10000),
    devices: z.array(device).max(10000),
    warnings: z.array(z.string().min(1).max(1000)).max(10000),
    blockers: z.array(blocker).max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const saved = value.saved_devices.map((row) => row.id);
    const proposed = value.devices.map((row) => row.id);
    if (!distinct(saved) || !distinct(proposed))
      ctx.addIssue({
        code: "custom",
        message: "Each selection must contain distinct device identities.",
      });
    if (new Set([...saved, ...proposed].map(normalized)).size > 10000)
      ctx.addIssue({
        code: "custom",
        message: "The combined review exceeds 10000 devices.",
      });
    if (
      value.ready !== (value.blockers.length === 0) ||
      (value.ready &&
        (value.source_status !== "scheduled" || proposed.length === 0))
    )
      ctx.addIssue({
        code: "custom",
        message: "Readiness must match the reviewed selection and blockers.",
      });
    if (value.source_status !== "scheduled" && proposed.length > 0)
      ctx.addIssue({
        code: "custom",
        message: "An inactive schedule cannot propose a new selection.",
      });
  });
export type ScheduledAssignmentRefreshPreview = z.infer<
  typeof ScheduledAssignmentRefreshPreviewSchema
>;

const policy = z
  .object({
    heartbeat_seconds: z.number().int().min(10).max(3600),
    sync_paused: z.boolean(),
    telemetry_enabled: z.boolean(),
  })
  .strict();
export const ScheduledAssignmentRefreshReceiptSchema = z
  .object({
    id: uuid,
    name: z.string().nullable().optional(),
    version_id: uuid.nullable().optional(),
    policy: policy.nullable().optional(),
    selector: z.object({ device_ids: ids, group_ids: ids, exclude_ids: ids }),
    priority: z.number().int().min(-1000000).max(1000000),
    target_mode: z.literal("snapshot"),
    status: z.literal("scheduled"),
    scheduled_at: timestamp,
    created_at: timestamp,
    targets: z
      .array(
        z
          .object({
            device_id: uuid,
            state: z.literal("pending"),
            generation: z.literal(0),
            error: z.string().nullable().optional(),
            original: z.boolean().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(10000),
    rollout: z.object({
      kind: z.enum(["all", "canary"]),
      canary_size: z.number().int().min(1).max(10000),
      batch_size: z.number().int().min(1).max(10000),
      observation_seconds: z.number().int().min(0).max(86400),
      failure_threshold: z.number().int().min(0).max(10000),
    }),
  })
  .passthrough()
  .refine((value) => distinct(value.targets.map((row) => row.device_id)));

export function sameScheduleSelection(
  left: readonly string[],
  right: readonly string[],
) {
  const a = new Set(left.map(normalized)),
    b = new Set(right.map(normalized));
  return a.size === b.size && [...a].every((id) => b.has(id));
}
export function assertScheduledAssignmentRefreshPreview(
  id: string,
  value: unknown,
) {
  const result = ScheduledAssignmentRefreshPreviewSchema.safeParse(value);
  if (
    !result.success ||
    normalized(result.data.source_deployment_id) !== normalized(id)
  )
    throw Error(
      "The server could not provide a matching scheduled-device review. Refresh the review or update the server before continuing.",
    );
  return result.data;
}
export function assertScheduledAssignmentRefreshReceipt(
  id: string,
  expectedIds: readonly string[],
  value: unknown,
) {
  const result = ScheduledAssignmentRefreshReceiptSchema.safeParse(value);
  if (
    !ids.min(1).safeParse(expectedIds).success ||
    !distinct([...expectedIds]) ||
    !result.success ||
    normalized(result.data.id) !== normalized(id) ||
    !sameScheduleSelection(
      expectedIds,
      result.data.targets.map((row) => row.device_id),
    )
  )
    throw Error(
      "The response did not confirm the reviewed device selection. Check current selection before making another change.",
    );
  return result.data;
}
const status = z.object({ id: uuid, status: sourceStatus });
export function assertScheduledAssignmentRefreshStatus(
  id: string,
  value: unknown,
) {
  const result = status.safeParse(value);
  if (!result.success || normalized(result.data.id) !== normalized(id))
    throw Error(
      "The current status could not be confirmed for this schedule. Check again before making another change.",
    );
  return result.data;
}
/**
 * What the review calls a device: the name it carries now, else the name it
 * was saved under, and only when neither is known its identity.
 */
export function reviewedDeviceName(preview: ScheduledAssignmentRefreshPreview) {
  const names = new Map<string, string>();
  for (const row of [...preview.saved_devices, ...preview.devices])
    if (row.name) names.set(normalized(row.id), row.name);
  return (id: string) => names.get(normalized(id)) ?? id;
}
export type ScheduleSelectionRow = z.infer<typeof device> & {
  change: "added" | "kept" | "removed";
};
export function scheduleSelectionRows(
  preview: ScheduledAssignmentRefreshPreview,
): ScheduleSelectionRow[] {
  if (preview.source_status !== "scheduled")
    return preview.saved_devices.map((row) => ({ ...row, change: "kept" }));
  const saved = new Map(
    preview.saved_devices.map((row) => [normalized(row.id), row]),
  );
  const proposed = new Set(preview.devices.map((row) => normalized(row.id)));
  return [
    ...preview.devices.map((row) => ({
      ...row,
      name: row.name ?? saved.get(normalized(row.id))?.name ?? null,
      change: saved.has(normalized(row.id))
        ? ("kept" as const)
        : ("added" as const),
    })),
    ...preview.saved_devices
      .filter((row) => !proposed.has(normalized(row.id)))
      .map((row) => ({ ...row, change: "removed" as const })),
  ];
}

// Tab-local recovery context only. It neither identifies a server attempt nor
// authorizes retry. A reload always starts with a fresh typed server review.
const unresolved = new Map<string, readonly string[]>();
const key = (actor: string, source: string) =>
  JSON.stringify([actor, normalized(source)]);
export function getScheduleRefreshUncertainty(actor: string, source: string) {
  const saved = unresolved.get(key(actor, source));
  return saved ? [...saved] : null;
}
export function setScheduleRefreshUncertainty(
  actor: string,
  source: string,
  value: readonly string[] | null,
) {
  if (value === null) unresolved.delete(key(actor, source));
  else unresolved.set(key(actor, source), Object.freeze([...value]));
}
