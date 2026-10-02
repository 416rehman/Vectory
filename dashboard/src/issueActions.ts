import { can, type Issue, type IssueGroup, type User } from "./api";
import { pipelineFixable } from "./deploymentStatus";
import { pipelineFixHref } from "./pipelineDestination";
import type { Diagnostic } from "./runtimeModel";
import { isDataPlaneCode } from "./status";

/**
 * The one thing an issue most likely needs next, as a link: roll the rollout
 * back, fix the step the device named, open the rollout, or open the device.
 * Only a target that exists is offered, and only to a person whose role allows
 * what it leads to.
 */
export type IssueAction = {
  kind: "rollback" | "fix" | "rollout" | "device";
  label: "Roll back" | "Fix in pipeline" | "Open rollout" | "Open device";
  href: string;
  /** Roll back: the rollout whose rollback review its page opens. */
  deployment?: string;
};

/** What decides an issue's action: the same for one device and for a group. */
export type IssueSubject = {
  code: string;
  configuration_id?: string | null;
  /** Rollouts the issue came from. */
  deployments: string[];
  device_id?: string | null;
  /** False: a live device; true: revoked; null: no longer exists. */
  device_revoked?: boolean | null;
  resolved: boolean;
  diagnostics: readonly Diagnostic[];
};

export const issueSubject = (issue: Issue): IssueSubject => ({
  code: issue.code,
  configuration_id: issue.configuration_id,
  deployments: issue.deployment_id ? [issue.deployment_id] : [],
  device_id: issue.device_id,
  device_revoked: issue.device_revoked,
  resolved: issue.resolved,
  diagnostics: issue.diagnostics,
});

export const groupSubject = (group: IssueGroup): IssueSubject => {
  // A card about one device can open it; one about several has none to choose.
  const only = group.device_count === 1 ? group.devices[0] : undefined;
  return {
    code: group.code,
    configuration_id: group.configuration_id,
    deployments: group.deployment_ids,
    device_id: only?.device_id,
    device_revoked: only?.device_revoked,
    resolved:
      group.devices.length > 0 &&
      group.devices.every((issue) => issue.resolved),
    diagnostics: group.diagnostics,
  };
};

/**
 * What only the pipeline can clear: the findings that are errors a pipeline
 * edit fixes (a host problem, a missing directory, is not one), with the step
 * and field of the first that names a step.
 */
function pipelineFinding(diagnostics: readonly Diagnostic[]) {
  const fixing = diagnostics.filter(
    (item) => item.severity === "error" && pipelineFixable(item.code),
  );
  if (!fixing.length) return null;
  const named = fixing.find((item) => item.component_id);
  return { step: named?.component_id, field: named?.field };
}

export function issueAction(
  subject: IssueSubject,
  user: User,
): IssueAction | null {
  if (subject.resolved) return null;
  // A rollback or a rollout page needs one rollout to be about.
  const rollout =
    subject.deployments.length === 1 ? subject.deployments[0] : null;
  const rolloutHref = rollout
    ? `#/deployments/${encodeURIComponent(rollout)}`
    : null;
  if (
    isDataPlaneCode(subject.code) &&
    rollout &&
    rolloutHref &&
    can(user, "operate")
  )
    return {
      kind: "rollback",
      label: "Roll back",
      href: rolloutHref,
      deployment: rollout,
    };
  const fix = subject.configuration_id
    ? pipelineFinding(subject.diagnostics)
    : null;
  if (fix && subject.configuration_id && can(user, "edit"))
    return {
      kind: "fix",
      label: "Fix in pipeline",
      href: pipelineFixHref(subject.configuration_id, fix.step, fix.field),
    };
  if (rolloutHref)
    return { kind: "rollout", label: "Open rollout", href: rolloutHref };
  if (subject.device_id && subject.device_revoked !== null)
    return {
      kind: "device",
      label: "Open device",
      href: `#/devices/${encodeURIComponent(subject.device_id)}`,
    };
  return null;
}
