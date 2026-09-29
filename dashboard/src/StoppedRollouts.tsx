import { CircleX, TriangleAlert, Undo2 } from "lucide-react";
import type { DeploymentPage } from "./api";
import { Button, useResource } from "./ui";
import { stoppedRollouts, type StoppedRollout } from "./stoppedRollouts";

const empty: DeploymentPage = { items: [], total: 0, page: 1, page_size: 5 };

export type StoppedRollouts = {
  items: StoppedRollout[];
  /** Either read failed: the list may be missing rollouts. */
  error: string;
  /** Neither read has answered yet. */
  loading: boolean;
  retrying: boolean;
  retry: () => void;
};

/**
 * Rollouts that stopped on failures or were rolled back in the last day, for
 * the Overview's "Needs you". Read from deployment history, so they stay
 * listed after the rollout itself is no longer in progress.
 */
export function useStoppedRollouts(enabled: boolean): StoppedRollouts {
  const failed = useResource<DeploymentPage>(
    enabled ? "/deployments/history?status=failed&page=1&page_size=5" : null,
    empty,
  );
  const rolledBack = useResource<DeploymentPage>(
    enabled
      ? "/deployments/history?status=rolled_back&page=1&page_size=5"
      : null,
    empty,
  );
  return {
    items: stoppedRollouts(failed.data.items, rolledBack.data.items),
    error: failed.error || rolledBack.error,
    loading: failed.loading || rolledBack.loading,
    retrying: failed.refreshing || rolledBack.refreshing,
    retry: () => {
      if (failed.error) void failed.reload();
      if (rolledBack.error) void rolledBack.reload();
    },
  };
}

/**
 * Needs-you rows for stopped rollouts, each leading to its rollout page, and
 * a row of its own when the check failed: a failed read is never an all-clear.
 */
export function StoppedRolloutItems({
  stopped,
}: {
  stopped: StoppedRollouts;
}) {
  return (
    <>
      {stopped.error && (
        <li
          className="overview-attention-item"
          data-severity="warning"
          data-stopped-check="failed"
        >
          <span className="overview-attention-icon" aria-hidden="true">
            <TriangleAlert size={16} />
          </span>
          <div className="overview-attention-copy">
            <p className="overview-attention-title">
              Couldn’t check stopped rollouts.
            </p>
            <p className="overview-attention-detail">
              Rollouts that failed or were rolled back in the last day may be
              missing here.
            </p>
          </div>
          <div className="overview-attention-actions">
            <Button
              variant="secondary compact"
              busy={stopped.retrying}
              onClick={stopped.retry}
            >
              Retry
            </Button>
          </div>
        </li>
      )}
      {stopped.items.map((item) => {
        const d = item.deployment;
        const Icon = item.kind === "stopped" ? CircleX : Undo2;
        return (
          <li
            key={`rollout:${d.id}`}
            className="overview-attention-item"
            data-severity={item.kind === "stopped" ? "danger" : "neutral"}
          >
            <span className="overview-attention-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <div className="overview-attention-copy">
              <p className="overview-attention-title">{item.title}</p>
              <p className="overview-attention-detail">{item.detail}</p>
            </div>
            <div className="overview-attention-actions">
              <a
                className="button compact"
                href={`#/deployments/${encodeURIComponent(d.id)}`}
              >
                Open rollout
              </a>
              {d.configuration_id && (
                <a
                  className="overview-inline-link"
                  href={`#/configurations/${encodeURIComponent(d.configuration_id)}`}
                >
                  Open pipeline
                </a>
              )}
            </div>
          </li>
        );
      })}
    </>
  );
}
