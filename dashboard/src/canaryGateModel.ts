import { z } from "zod";
import type { DeploymentSummary } from "./api";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const gateReasons = [
  "superseded",
  "stale",
  "paused",
  "unverified",
  "unavailable",
] as const;
export type GateReason = (typeof gateReasons)[number];
export const gateReasonLabels: Record<GateReason, string> = {
  superseded: "Another assignment is effective",
  stale: "Waiting for a fresh heartbeat",
  paused: "Configuration sync is paused",
  unverified: "Current application is not verified",
  unavailable: "Device is unavailable",
};
export const gateReasonHelp: Record<GateReason, string> = {
  superseded:
    "Review the device’s current assignment and priority before changing this rollout.",
  stale:
    "Check the device connection. A previous success cannot replace a fresh report.",
  paused:
    "Review the device’s local and remote pause settings before continuing.",
  unverified:
    "Open the device to review the current version, agent settings and reported issues.",
  unavailable:
    "Review the original device identity and this deployment’s target membership.",
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
