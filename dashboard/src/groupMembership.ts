import {
  APIError,
  type GroupMembershipPreview,
  type GroupMembershipState,
} from "./api";
import { assignmentName, policySummary } from "./deploymentReview";

/** Quiet retries of a busy preview, one a second, before it shows an error. */
export const BUSY_PREVIEW_RETRIES = 3;

/**
 * The server never queues a preview behind heartbeats: while one is writing it
 * answers 429 CAPACITY_BUSY ("Preview busy, retrying") instead.
 */
export function previewBusy(error: unknown) {
  return (
    error instanceof APIError &&
    error.status === 429 &&
    error.code === "CAPACITY_BUSY"
  );
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Run a membership preview. While the server says it's busy, ask again once
 * a second, quietly, up to BUSY_PREVIEW_RETRIES times; any other error, or
 * the last busy answer, goes to the caller.
 */
export async function previewWithRetries<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = pause,
): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await request();
    } catch (error) {
      if (!previewBusy(error) || retries >= BUSY_PREVIEW_RETRIES) throw error;
      await wait(1000, signal);
    }
  }
}

type Part = GroupMembershipPreview["devices"][number]["configuration"];

function pipeline(state: NonNullable<GroupMembershipState>) {
  const name =
    state.configuration_name || state.assignment_name || "a pipeline";
  return state.version_number ? `${name} v${state.version_number}` : name;
}

function configurationEffect(part: Part, change: "added" | "removed") {
  const { before, after, pending } = part;
  if (pending)
    return `queues ${assignmentName(pending)}, which deploys when its rollout reaches this device`;
  if (!part.changed) return null;
  if (
    after?.version_id &&
    before?.version_id &&
    after.version_id !== before.version_id
  )
    return `switches it from ${pipeline(before)} to ${pipeline(after)}`;
  if (after?.version_id && !before?.version_id)
    return `deploys ${pipeline(after)}`;
  if (!after && before?.version_id)
    return change === "removed"
      ? `stops managing its pipeline; it keeps running ${pipeline(before)}`
      : `stops managing its pipeline`;
  if (after?.version_id)
    return `moves it to ${after.assignment_name || pipeline(after)}`;
  return null;
}

function policyEffect(part: Part) {
  const { before, after, pending } = part;
  if (pending) return `queues ${assignmentName(pending)}`;
  if (!part.changed) return null;
  if (after?.policy)
    return `applies agent settings (${policySummary(after.policy).toLowerCase()})`;
  if (before?.policy) return "leaves its current agent settings unmanaged";
  return null;
}

/**
 * "Adding web-01 deploys Web access logs v3." One sentence per device, from
 * the server's simulation of the exact membership edit.
 */
export function membershipSentence(
  entry: GroupMembershipPreview["devices"][number],
  name: string,
) {
  const effects = [
    configurationEffect(entry.configuration, entry.change),
    policyEffect(entry.policy),
  ].filter(Boolean);
  const verb = entry.change === "added" ? "Adding" : "Removing";
  if (!effects.length) return `${verb} ${name} changes nothing on it.`;
  return `${verb} ${name} ${effects.join(" and ")}.`;
}
