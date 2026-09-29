/** Turn audit summaries into short sentences that name what changed. */
import { auditActionLabel, auditResourceRoute, isAuditId } from "./auditModel";

export type ActivityItem = {
  id: string;
  action: string;
  actor: string;
  actor_id?: string;
  actor_kind?: string;
  target: string;
  target_id?: string | null;
  target_kind?: string;
  target_name?: string | null;
  target_exists?: boolean;
  device_id?: string | null;
  outcome: string;
  created_at: string | null;
  repeat?: number;
  device_names?: string[];
  first_at?: string | null;
  version_number?: number;
  deployment?: {
    configuration_name: string | null;
    version_number: number | null;
    policy: boolean;
    rollout_kind: string | null;
    priority: number | null;
    target_count: number;
  };
};
export type Part = { text: string; href?: string | null; strong?: boolean };

const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** "edge-01, edge-02 and 3 more" from a bounded name list and a total. */
export function nameList(names: string[], total = names.length) {
  const shown = names.slice(0, 2);
  const rest = total - shown.length;
  if (!shown.length) return plural(total, "device");
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0];
}

export function actorPart(item: ActivityItem): Part {
  if (item.actor_kind === "system")
    return {
      text:
        item.actor === "scheduler"
          ? "Vectory"
          : item.actor === "local-admin"
            ? "Local administrator"
            : "Someone",
      strong: true,
    };
  const href =
    item.actor_kind === "device"
      ? auditResourceRoute("device", item.actor_id)
      : null;
  return {
    text: item.actor || "Someone",
    href: href ? `#/${href}` : null,
    strong: true,
  };
}

function targetPart(item: ActivityItem, label?: string | null): Part {
  const route =
    item.target_exists === true
      ? auditResourceRoute(item.target_kind, item.target_id)
      : null;
  return {
    text: label || item.target_name || "an item",
    href: route ? `#/${route}` : null,
    strong: true,
  };
}

function pipelineLabel(item: ActivityItem) {
  const deployment = item.deployment;
  if (deployment?.policy) return "agent settings";
  const name = deployment?.configuration_name || item.target_name;
  const version = deployment?.version_number ?? item.version_number;
  if (!name) return version ? `version ${version}` : "a pipeline";
  return version ? `${name} v${version}` : name;
}

/** A sentence as parts: actor, verb, target and a trailing detail. */
export function describeActivity(item: ActivityItem): Part[] {
  const actor = actorPart(item);
  const repeat = item.repeat ?? 1;
  const devices = item.device_names || [];
  const count = item.deployment?.target_count;
  const toDevices = count ? ` to ${plural(count, "device")}` : "";
  const canary =
    item.deployment?.rollout_kind === "canary" ? " as a canary" : "";
  switch (item.action) {
    case "configuration.create":
      return [actor, { text: " created pipeline " }, targetPart(item)];
    case "configuration.publish":
      return [
        actor,
        { text: " published " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "configuration.duplicate":
      return [actor, { text: " duplicated pipeline " }, targetPart(item)];
    case "configuration.archive":
      return [actor, { text: " archived pipeline " }, targetPart(item)];
    case "configuration.unarchive":
      return [actor, { text: " restored pipeline " }, targetPart(item)];
    case "deployment.create":
      return item.deployment?.policy
        ? [
            actor,
            { text: " applied " },
            targetPart(item, "agent settings"),
            { text: toDevices },
          ]
        : [
            actor,
            { text: " deployed " },
            targetPart(item, pipelineLabel(item)),
            { text: `${toDevices}${canary}` },
          ];
    case "deployment.schedule":
      return [
        actor,
        { text: " scheduled " },
        targetPart(item, pipelineLabel(item)),
        { text: count ? ` for ${plural(count, "device")}` : "" },
      ];
    case "deployment.release":
      return [
        actor,
        { text: " released " },
        targetPart(item, pipelineLabel(item)),
        { text: ` to ${nameList(devices, repeat)}` },
      ];
    case "deployment.activate":
      return [
        actor,
        { text: " started the scheduled rollout of " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "deployment.pause":
      return [
        actor,
        { text: " paused the rollout of " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "deployment.resume":
      return [
        actor,
        { text: " resumed the rollout of " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "deployment.cancel":
      return [
        actor,
        { text: " cancelled the rollout of " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "deployment.rollback":
      return [
        actor,
        { text: " rolled back to " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "deployment.unassign":
      return [
        actor,
        { text: " removed the assignment of " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "deployment.missed":
      return [
        { text: "The scheduled start of " },
        targetPart(item, pipelineLabel(item)),
        { text: " was missed" },
      ];
    case "deployment.refresh_targets":
      return [
        actor,
        { text: " refreshed the devices for " },
        targetPart(item, pipelineLabel(item)),
      ];
    case "device.enroll":
      return [targetPart(item), { text: " enrolled" }];
    case "device.revoke":
      return [actor, { text: " revoked " }, targetPart(item)];
    case "device.retry":
      return [actor, { text: " retried the pipeline on " }, targetPart(item)];
    case "device.recovery_authorize":
      return [actor, { text: " authorized recovery for " }, targetPart(item)];
    case "device.recovery_complete":
      return [targetPart(item), { text: " completed recovery" }];
    case "device.apply_state": {
      const who = nameList(
        devices.length ? devices : [item.target_name || "A device"],
        repeat,
      );
      const verb =
        item.outcome === "verified_applied"
          ? repeat > 1
            ? " applied their pipeline"
            : " applied its pipeline"
          : item.outcome === "failed"
            ? " failed to apply its pipeline"
            : item.outcome === "rolled_back"
              ? " rolled back to its last working version"
              : " needs a check: Vector wasn't confirmed running";
      return [
        {
          text: who,
          strong: true,
          href: repeat === 1 ? targetPart(item).href : null,
        },
        { text: verb },
      ];
    }
    case "group.create":
      return [actor, { text: " created group " }, targetPart(item)];
    case "group.update":
      return [actor, { text: " updated group " }, targetPart(item)];
    case "policy.create":
      return [actor, { text: " saved agent settings " }, targetPart(item)];
    case "token.create":
      return [actor, { text: " created enrollment token " }, targetPart(item)];
    case "token.revoke":
      return [actor, { text: " revoked enrollment token " }, targetPart(item)];
    case "issue.acknowledge":
      return [actor, { text: " acknowledged an issue" }];
    case "issue.reopen":
      return [actor, { text: " reopened an issue" }];
    default:
      return [
        actor,
        { text: ` · ${auditActionLabel(item.action)}` },
        ...(item.target_name ? [{ text: " " }, targetPart(item)] : []),
      ];
  }
}

export const activityTone = (item: ActivityItem) =>
  ["failed", "failure", "denied", "rolled_back"].includes(item.outcome)
    ? "danger"
    : ["verification_unknown", "conflict", "missed"].includes(item.outcome) ||
        item.action === "deployment.missed"
      ? "warning"
      : "neutral";

export const isEventId = isAuditId;

/** Sign-in and account events belong in Security activity (mirrors the server). */
export function isSecurityAction(action: string) {
  return (
    action === "bootstrap" ||
    action === "login" ||
    action.startsWith("login.") ||
    action === "logout" ||
    action.startsWith("account.") ||
    action.startsWith("user.") ||
    action.startsWith("mfa.") ||
    action.startsWith("signing.") ||
    action.startsWith("server.restore_access")
  );
}
