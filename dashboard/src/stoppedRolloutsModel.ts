import type { DeploymentSummary } from "./api";
import { countLabel } from "./countLabel";
import { progressSegments } from "./deploymentStatus";

/** A rollout that stopped by itself and still deserves a look. */
export type StoppedRollout = {
  deployment: DeploymentSummary;
  /** Identifies this stop: a later failure of the same rollout is new. */
  key: string;
  title: string;
  detail: string;
  /** "The rollout stopped; 2 devices never received v3." */
  consequence: string;
  /** Devices it released, so a rollback can be named after the one it covers. */
  released: number;
  at: string;
};

const DAY = 86400000;

function name(d: DeploymentSummary) {
  if (d.policy) return d.policy_name || "Agent settings";
  const pipeline = d.configuration_name || d.name || "A pipeline";
  return d.version_number ? `${pipeline} v${d.version_number}` : pipeline;
}

/**
 * Rollouts that stopped by themselves in the last day and still hold devices
 * back, newest first. A rolled-back rollout is resolved: its rollback shows
 * under Rollouts while it runs and in Recent changes after. A failed rollout
 * whose devices all verified since, or that a newer version replaced
 * everywhere, no longer needs anyone.
 */
export function stoppedRollouts(
  failed: DeploymentSummary[],
  now = Date.now(),
): StoppedRollout[] {
  const recent = (value: string | null | undefined) => {
    const at = value ? Date.parse(value) : NaN;
    return Number.isFinite(at) && now - at <= DAY;
  };
  const items: StoppedRollout[] = [];
  for (const d of failed) {
    if (d.status !== "failed" || d.rolled_back_by) continue;
    const at = d.failed_at || d.created_at;
    if (!recent(at)) continue;
    const current = d.target_count - (d.state_counts.removed || 0);
    if (current <= 0 || d.verified_count >= current) continue;
    const counts = Object.fromEntries(
      progressSegments(d.state_counts, { stopped: true }).map((segment) => [
        segment.key,
        segment.count,
      ]),
    );
    const waiting = d.state_counts.pending || 0;
    const version = d.policy
      ? "these settings"
      : d.version_number
        ? `v${d.version_number}`
        : "this version";
    items.push({
      deployment: d,
      key: `${d.id.toLowerCase()}:${d.status}:${d.failed_at || ""}`,
      at,
      title:
        d.failure_reason === "incompatible"
          ? `${name(d)} stopped: a device became incompatible`
          : d.failure_reason === "data_plane"
            ? `${name(d)} stopped: a device isn't delivering`
            : `${name(d)} stopped after ${counts.failed === 1 ? "a failure" : "failures"}`,
      detail:
        [
          counts.failed ? `${counts.failed} failed` : "",
          counts.queued ? `${counts.queued} not released` : "",
          d.verified_count ? `${d.verified_count} applied` : "",
        ]
          .filter(Boolean)
          .join(" · ") || countLabel(current, "device"),
      consequence: waiting
        ? `The rollout stopped; ${countLabel(waiting, "device")} never received ${version}.`
        : "The rollout stopped.",
      released: Math.max(0, current - waiting),
    });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// Dismissed stopped rollouts, per person, in this browser only. Keyed by the
// stop, so the same rollout failing again comes back.
const MAX_DISMISSED = 200;
const dismissalStore = (userId: string) =>
  `vectory-needs-you-dismissed:${JSON.stringify(userId)}`;
export function readDismissed(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissalStore(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed
            .filter(
              (value): value is string =>
                typeof value === "string" && value.length <= 200,
            )
            .slice(-MAX_DISMISSED)
        : [],
    );
  } catch {
    return new Set();
  }
}
/** Remembers a dismissal; without storage it lasts until the page reloads. */
export function dismissStoppedRollout(
  userId: string,
  key: string,
  current: Set<string>,
): Set<string> {
  const next = new Set([...readDismissed(userId), ...current, key]);
  try {
    localStorage.setItem(
      dismissalStore(userId),
      JSON.stringify([...next].slice(-MAX_DISMISSED)),
    );
  } catch {
    // Storage is unavailable: the dismissal holds for this view only.
  }
  return next;
}
