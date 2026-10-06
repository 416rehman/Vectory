import { z } from "zod";
import type { DeploymentSummary } from "./api";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const gateReasons = [
  "superseded",
  "stale",
  "paused",
  "unverified",
  "unavailable",
  "measuring",
  "degraded",
] as const;
export type GateReason = (typeof gateReasons)[number];
export const gateReasonLabels: Record<GateReason, string> = {
  superseded: "Another assignment is effective",
  stale: "Waiting for a check-in",
  paused: "Configuration sync is paused",
  unverified: "Waiting for the device to confirm",
  unavailable: "Device is unavailable",
  measuring: "Measuring delivery",
  degraded: "Not delivering",
};
export const gateReasonHelp: Record<GateReason, string> = {
  superseded:
    "Another assignment now wins on this device. Review its assignment and priority.",
  stale:
    "The device hasn't checked in recently. An earlier success doesn't count.",
  paused: "Sync is paused on this device, locally or by its agent settings.",
  unverified:
    "Devices confirm on their next check-in. The rollout waits until they do.",
  unavailable: "The device was revoked or replaced.",
  measuring:
    "Applied. Vectory checks a few telemetry samples to confirm events are delivered before it starts observing.",
  degraded:
    "Applied, but its telemetry shows it isn't delivering. It counts as a failure against the threshold.",
};
export const CanaryGateSchema = z
  .object({
    state: z.enum(["waiting", "observing", "paused"]),
    released_count: count,
    verified_count: count,
    pending_count: count,
    reasons: z
      .object({
        superseded: count,
        stale: count,
        paused: count,
        unverified: count,
        unavailable: count,
        // Servers without data-plane health omit these.
        measuring: count.default(0),
        degraded: count.default(0),
      })
      .strict(),
    observation_started_at: z.string().datetime({ offset: true }).nullable(),
    observation_seconds: z.number().int().min(0).max(86400),
    evaluated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((gate, ctx) => {
    const reasons = gateReasons.reduce(
      (sum, reason) => sum + gate.reasons[reason],
      0,
    );
    const observing = gate.state === "observing";
    if (
      !Number.isSafeInteger(reasons + gate.verified_count) ||
      reasons + gate.verified_count !== gate.released_count ||
      observing !== (gate.observation_started_at !== null) ||
      (observing && (gate.released_count === 0 || reasons !== 0)) ||
      (gate.observation_started_at !== null &&
        Date.parse(gate.observation_started_at) > Date.parse(gate.evaluated_at))
    )
      ctx.addIssue({
        code: "custom",
        message: "Canary gate evidence is inconsistent.",
      });
  });
export type CanaryGate = z.infer<typeof CanaryGateSchema>;
export function hasCanaryGate(deployment: DeploymentSummary) {
  return (
    deployment.rollout.kind === "canary" &&
    ["active", "paused"].includes(deployment.status)
  );
}
export function readCanaryGate(
  deployment: DeploymentSummary,
): CanaryGate | null {
  if (!hasCanaryGate(deployment)) return null;
  const result = CanaryGateSchema.safeParse(deployment.canary_gate);
  if (!result.success) return null;
  const gate = result.data;
  if (
    (deployment.status === "paused") !== (gate.state === "paused") ||
    gate.observation_seconds !== deployment.rollout.observation_seconds ||
    !Number.isSafeInteger(gate.released_count + gate.pending_count) ||
    gate.released_count + gate.pending_count > deployment.target_count
  )
    return null;
  return gate;
}
export function readGateReason(value: unknown): GateReason | null {
  return gateReasons.includes(value as GateReason)
    ? (value as GateReason)
    : null;
}
export function observationDuration(seconds: number) {
  if (seconds === 0) return "No additional observation time";
  if (seconds % 3600 === 0)
    return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0)
    return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
