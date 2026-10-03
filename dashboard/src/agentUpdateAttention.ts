// How devices whose agent update went wrong read where the rest of the product
// lists problems: a group in Needs you on the Overview, and an issue on the
// Issues page. An agent-update issue is about the agent's own build, never a
// pipeline version, so nothing here says "version" or "pipeline".
import { codeText } from "./agentUpdateCodes";
import { countLabel } from "./countLabel";

/** The Overview's `agent_update` group, as far as its row needs. */
export type AgentUpdateGroup = {
  count: number;
  /** `rolled_back` or `failed`. */
  state: string | null;
  /** The most common code among its devices' open issues. */
  reason: string | null;
  device_ids: readonly string[];
};

export type AgentUpdateRow = {
  title: string;
  detail: string;
  /** The code the detail was written from, for a tooltip. */
  code: string | null;
  /** Where the devices and their reasons are listed. */
  href: string;
  action: "Open device" | "Open issues";
};

/** Open issues about agent updates, found by their code. */
export const agentUpdateIssuesHref = "#/issues?q=agent_update";

/** The row for devices whose update rolled back or failed. */
export function agentUpdateRow(group: AgentUpdateGroup): AgentUpdateRow {
  const devices = countLabel(group.count, "device");
  const one = group.count === 1;
  const failed = group.state === "failed";
  const reason = group.reason ? codeText(group.reason).reason : null;
  const outcome = failed
    ? "The update didn't finish."
    : `${one ? "The host" : "Each host"} took the new build back and won't try this release again.`;
  const only = one ? group.device_ids[0] : undefined;
  return {
    title: failed
      ? `Agent update failed on ${devices}`
      : `Agent update rolled back on ${devices}`,
    detail: [reason, outcome].filter(Boolean).join(" "),
    code: group.reason,
    href: only
      ? `#/devices/${encodeURIComponent(only)}`
      : agentUpdateIssuesHref,
    action: only ? "Open device" : "Open issues",
  };
}

/** An issue the server opened for an agent update that rolled back or failed. */
export const isAgentUpdateIssue = (issue: {
  code: string;
  stage?: string | null;
}) => issue.code.startsWith("AGENT_UPDATE_") || issue.stage === "agent_update";
