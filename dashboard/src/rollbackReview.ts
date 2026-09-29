import { z } from "zod";

const uuid = z.string().uuid();
const name = z.string().refine((s) => [...s].length <= 240);
const device = z
  .object({ device_id: uuid, device_name: name.nullable() })
  .strict();
// A device that ran its local config before this deployment has no earlier
// managed artifact: the server reports null and blocks the review.
const eligibleDevice = device
  .extend({
    artifact_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const versionLabel = z
  .object({
    configuration_name: name.nullable(),
    version_number: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict();
export type RollbackVersion = z.infer<typeof versionLabel>;
/**
 * What a device the rollback leaves out runs once the rollout stops:
 * unchanged, retained_pending (until another rollout releases it), fallback
 * (it would switch; blocks) or unmanaged (it would lose its pipeline;
 * blocks). Older servers omit it.
 */
const effect = z.enum([
  "unchanged",
  "retained_pending",
  "fallback",
  "unmanaged",
]);
export type ExcludedEffect = z.infer<typeof effect>;
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
            effect: effect.nullable().optional(),
            current: versionLabel.nullable().optional(),
            next: versionLabel.nullable().optional(),
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
        v.previous_version_id !== null &&
        v.eligible_devices.every((d) => d.artifact_sha256 !== null))
    )
      ctx.addIssue({
        code: "custom",
        message: "Rollback readiness does not match its reviewed scope.",
      });
  });
export type RollbackPreview = z.infer<typeof RollbackPreviewSchema>;
/** No included device has an earlier managed version to return to. */
export function nothingToRollBackTo(preview: RollbackPreview) {
  return preview.blockers.some(
    (blocker) => blocker.code === "PRIOR_VERSION_UNKNOWN",
  );
}
/** Devices that ran their local config before this deployment. */
export function locallyConfigured(preview: RollbackPreview) {
  return preview.eligible_devices.filter(
    (device) => device.artifact_sha256 === null,
  );
}

/** "Edge syslog processing v1" for a version label. */
export function versionName(
  version: RollbackVersion | null | undefined,
  fallback = "the version it runs now",
) {
  const name = version?.configuration_name;
  const number = version?.version_number;
  if (name) return number ? `${name} v${number}` : name;
  return number ? `version ${number}` : fallback;
}
/** The version the rollback restores. */
export function restoredName(preview: RollbackPreview) {
  return versionName(
    {
      configuration_name: preview.previous_configuration_name,
      version_number: preview.previous_version_number,
    },
    "its previous version",
  );
}
function deviceNames(names: (string | null)[]) {
  const shown = names.map((name) => name || "An unnamed device");
  if (shown.length <= 2) return shown.join(" and ");
  return `${shown.slice(0, 2).join(", ")} and ${shown.length - 2} more`;
}
/** A live rollout (active or paused) stops as part of the rollback. */
export const stopsRollout = (preview: RollbackPreview) =>
  preview.source_status === "active" || preview.source_status === "paused";

export type ExcludedDevice = RollbackPreview["excluded_devices"][number];
/** What one excluded device does, in the review's words. */
export function excludedDetail(device: ExcludedDevice, source: string) {
  if (device.reason === "revoked") return "Device revoked";
  if (device.reason === "missing") return "Device unavailable";
  const why =
    device.reason === "removed"
      ? "No longer follows it"
      : `Never received ${source}`;
  const current = versionName(device.current);
  switch (device.effect) {
    case "unchanged":
      return `${why} · keeps ${current} (no change)`;
    case "retained_pending":
      return `${why} · keeps ${current} until ${versionName(device.next, "another rollout")} reaches it`;
    case "fallback":
      return `${why} · would switch to ${versionName(device.next, "another version")}`;
    case "unmanaged":
      return `${why} · would lose its pipeline`;
    default:
      return why;
  }
}
/**
 * The review in sentences: who returns to what, who keeps what, and whether
 * the rollout stops. Devices are named (two, then a count).
 */
export function rollbackStory(preview: RollbackPreview, source: string) {
  const lines: { text: string; tone: "neutral" | "danger" }[] = [];
  const restored = restoredName(preview);
  const eligible = preview.eligible_devices.map((d) => d.device_name);
  if (eligible.length)
    lines.push({
      text: `${deviceNames(eligible)} ${eligible.length === 1 ? "returns" : "return"} to ${restored}.`,
      tone: "neutral",
    });
  const groups = new Map<string, ExcludedDevice[]>();
  for (const device of preview.excluded_devices) {
    const key =
      device.reason === "revoked" || device.reason === "missing"
        ? "gone"
        : `${device.reason === "removed" ? "left" : "never"}|${device.effect ?? ""}|${versionName(device.current)}|${versionName(device.next, "")}`;
    groups.set(key, [...(groups.get(key) || []), device]);
  }
  for (const [key, devices] of groups) {
    const names = deviceNames(devices.map((d) => d.device_name));
    const one = devices.length === 1;
    if (key === "gone") {
      lines.push({
        text: `${devices.length} revoked or unavailable ${one ? "device is" : "devices are"} left out.`,
        tone: "neutral",
      });
      continue;
    }
    const [how] = key.split("|");
    const first = devices[0];
    const never =
      how === "left"
        ? `${one ? "no longer follows" : "no longer follow"} ${source}`
        : `never received ${source}`;
    const current = versionName(first.current);
    const next = versionName(first.next, "another version");
    const text =
      first.effect === "unchanged"
        ? `${names} ${never} and ${one ? "keeps" : "keep"} ${current} (no change).`
        : first.effect === "retained_pending"
          ? `${names} ${never} and ${one ? "keeps" : "keep"} ${current} until ${next} reaches ${one ? "it" : "them"}.`
          : first.effect === "fallback"
            ? `${names} ${never} but would switch to ${next} once the rollout stops.`
            : first.effect === "unmanaged"
              ? `${names} ${never} but would lose ${one ? "its" : "their"} pipeline once the rollout stops.`
              : `${names} ${never} and ${one ? "isn't" : "aren't"} part of this rollback.`;
    lines.push({
      text,
      tone:
        first.effect === "fallback" || first.effect === "unmanaged"
          ? "danger"
          : "neutral",
    });
  }
  if (stopsRollout(preview))
    lines.push({ text: "The rollout stops here.", tone: "neutral" });
  return lines;
}
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
