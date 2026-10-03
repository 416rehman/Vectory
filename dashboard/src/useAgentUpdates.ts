// The agent update settings, read once for every page that shows them or
// depends on them (the Devices tab, the Add device step, a device's panel).
// Pages reading the same path share one request (see sharedReads), so using
// this hook in several places costs one read, not one each.
import { useResource } from "./ui";
import type { AgentUpdates } from "./agentUpdateModel";

export const AGENT_UPDATES_PATH = "/agent-updates";
const POLL_MS = 60_000;

/**
 * `path` is null to read nothing (a page that only needs the settings when it
 * shows something): the hook then reports neither on nor off.
 */
export function useAgentUpdates(
  refresh = 0,
  interval = POLL_MS,
  enabled = true,
) {
  const resource = useResource<AgentUpdates | null>(
    enabled ? AGENT_UPDATES_PATH : null,
    null,
    refresh,
    { interval },
  );
  return {
    ...resource,
    updates: resource.data,
    /** Known to be on: an unread or failed read is neither on nor off. */
    on: resource.data?.enabled === true,
    /** Known to be off. */
    off: resource.data?.enabled === false,
  };
}
