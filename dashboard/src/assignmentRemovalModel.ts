import { z } from "zod";

const uuid = z.string().uuid();
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shortName = z.string().refine((value) => [...value].length <= 120);
const name = z.string().refine((value) => [...value].length <= 240);
const policy = z
  .object({
    heartbeat_seconds: z.number().int().min(10).max(3600),
    sync_paused: z.boolean(),
    telemetry_enabled: z.boolean(),
  })
  .strict();

export const RemovalStateSchema = z
  .object({
    assignment_id: uuid.nullable(),
    assignment_name: shortName.nullable(),
    version_id: uuid.nullable(),
    configuration_name: name.nullable(),
    version_number: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    generation: safeCount,
    policy: policy.nullable(),
  })
  .strict();
export type RemovalState = z.infer<typeof RemovalStateSchema>;

export const AssignmentRemovalPreviewSchema = z
  .object({
    removal_review: z.literal(true),
    source_deployment_id: uuid,
    source_status: z.string().min(1).max(64),
    resource: z.enum(["configuration", "policy"]),
    ready: z.boolean(),
    review_token: z.string().regex(/^[a-f0-9]{64}$/),
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
    devices: z
      .array(
        z
          .object({
            device_id: uuid,
            device_name: name.nullable(),
            effect: z.enum([
              "fallback",
              "unmanaged",
              "default_policy",
              "retained_pending",
              "unchanged",
              "revoked",
              "missing",
              "not_targeted",
            ]),
            before: RemovalStateSchema.nullable(),
            after: RemovalStateSchema.nullable(),
            pending_assignment_id: uuid.nullable(),
            pending_assignment_name: shortName.nullable(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.devices.map((device) => device.device_id.toLowerCase());
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Reviewed devices must have distinct identities.",
      });
    if (value.ready !== (value.blockers.length === 0))
      ctx.addIssue({
        code: "custom",
        message: "Readiness must match the reviewed blockers.",
      });
    value.devices.forEach((device, index) => {
      const invalid = (message: string) =>
        ctx.addIssue({ code: "custom", path: ["devices", index], message });
      for (const state of [device.before, device.after]) {
        if (!state) continue;
        if (value.resource === "configuration" && state.policy !== null)
          invalid("Configuration removal cannot contain agent policy state.");
        if (
          value.resource === "policy" &&
          (state.policy === null ||
            state.version_id !== null ||
            state.configuration_name !== null ||
            state.version_number !== null)
        )
          invalid(
            "Policy removal requires policy state without configuration version fields.",
          );
      }
      if (device.effect === "fallback" && !device.after?.assignment_id)
        invalid("Fallback must identify its effective assignment.");
      if (
        device.effect === "unmanaged" &&
        (value.resource !== "configuration" ||
          !device.after ||
          device.after.assignment_id !== null ||
          device.after.version_id !== null)
      )
        invalid(
          "Unmanaged configuration must have no desired assignment or version.",
        );
      if (
        device.effect === "default_policy" &&
        (value.resource !== "policy" ||
          !device.after ||
          device.after.assignment_id !== null)
      )
        invalid("Default policy must have no effective policy assignment.");
      if (
        device.effect === "retained_pending" &&
        (!device.pending_assignment_id ||
          !device.before ||
          !device.after ||
          !sameRemovalState(device.before, device.after))
      )
        invalid(
          "A pending assignment must retain the same current desired state.",
        );
      if (
        device.effect === "missing" &&
        (device.before !== null || device.after !== null)
      )
        invalid("A missing device cannot report current desired state.");
      if (device.effect !== "missing" && (!device.before || !device.after))
        invalid(
          "An existing device must include both current and reviewed desired state.",
        );
    });
  });
export type AssignmentRemovalPreview = z.infer<
  typeof AssignmentRemovalPreviewSchema
>;
export type RemovalDevice = AssignmentRemovalPreview["devices"][number];

const statuses = z.enum([
  "scheduled",
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "missed",
  "unassigned",
]);
const statusSchema = z.object({ id: uuid, status: statuses });
const sameId = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
function sameRemovalState(before: RemovalState, after: RemovalState) {
  const sameNullableId = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : sameId(a, b);
  return (
    sameNullableId(before.assignment_id, after.assignment_id) &&
    sameNullableId(before.version_id, after.version_id) &&
    before.generation === after.generation &&
    (before.policy === null || after.policy === null
      ? before.policy === after.policy
      : before.policy.heartbeat_seconds === after.policy.heartbeat_seconds &&
        before.policy.sync_paused === after.policy.sync_paused &&
        before.policy.telemetry_enabled === after.policy.telemetry_enabled)
  );
}

// Keep an unresolved send visible when the details dialog is closed/reopened.
// This contains no request payload and is intentionally only this tab's memory.
// A reload still requires a fresh server review before a new removal.
const uncertainRemovals = new Set<string>();
const uncertaintyKey = (actorId: string, deploymentId: string) =>
  JSON.stringify([actorId, deploymentId.toLowerCase()]);
export function isAssignmentRemovalUncertain(
  actorId: string,
  deploymentId: string,
) {
  return uncertainRemovals.has(uncertaintyKey(actorId, deploymentId));
}
export function setAssignmentRemovalUncertain(
  actorId: string,
  deploymentId: string,
  uncertain: boolean,
) {
  const key = uncertaintyKey(actorId, deploymentId);
  if (uncertain) uncertainRemovals.add(key);
  else uncertainRemovals.delete(key);
}

export function assertAssignmentRemovalPreview(
  id: string,
  value: unknown,
): AssignmentRemovalPreview {
  const result = AssignmentRemovalPreviewSchema.safeParse(value);
  if (!result.success || !sameId(id, result.data.source_deployment_id))
    throw Error(
      "The server could not provide a matching assignment-removal review. Refresh the review or update the server before continuing.",
    );
  return result.data;
}

export function assertAssignmentRemovalStatus(id: string, value: unknown) {
  const result = statusSchema.safeParse(value);
  if (!result.success || !sameId(id, result.data.id))
    throw Error(
      "The current status could not be confirmed for this assignment. Check again before making another change.",
    );
  return result.data;
}

export function assertAssignmentRemovalReceipt(id: string, value: unknown) {
  const result = assertAssignmentRemovalStatus(id, value);
  if (result.status !== "unassigned")
    throw Error(
      "The response did not confirm assignment removal. Check current status before making another change.",
    );
  return result;
}

export function removalEffectLabel(device: RemovalDevice) {
  return {
    fallback: "Use another assignment",
    unmanaged: "Keep the local configuration",
    default_policy: "Use default agent policy",
    retained_pending: "Keep current state while rollout waits",
    unchanged: "No desired-state change",
    revoked: "Device revoked",
    missing: "Device unavailable",
    not_targeted: "No longer targeted",
  }[device.effect];
}

export function removalStateLabel(
  state: RemovalState | null,
  resource: AssignmentRemovalPreview["resource"],
) {
  if (!state) return "Unavailable";
  if (resource === "policy")
    return (
      state.assignment_name ||
      (state.assignment_id ? "Assigned agent policy" : "Default agent policy")
    );
  if (!state.version_id) return "No managed configuration";
  return `${state.configuration_name || "Pipeline"}${state.version_number !== null ? ` · Version ${state.version_number}` : ""}`;
}
