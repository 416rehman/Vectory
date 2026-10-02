import { CircleX, TriangleAlert } from "lucide-react";
import type { DeploymentPage } from "./api";
import { Button, useResource } from "./ui";
import { stoppedRollouts, type StoppedRollout } from "./stoppedRolloutsModel";

const empty: DeploymentPage = { items: [], total: 0, page: 1, page_size: 5 };

export type StoppedRollouts = {
  items: StoppedRollout[];
  /** The read failed: the list may be missing rollouts. */
  error: string;
  /** The read has not answered yet. */
  loading: boolean;
  retrying: boolean;
  retry: () => void;
};

/**
 * Rollouts that stopped by themselves in the last day, for the Overview's
 * "Needs you". Read from deployment history, so they stay listed after the
 * rollout itself is no longer in progress. Rolled-back rollouts are resolved
 * and not read. A failed read is reported, never turned into an empty list.
 */
export function useStoppedRollouts(enabled: boolean): StoppedRollouts {
  const failed = useResource<DeploymentPage>(
    enabled ? "/deployments/history?status=failed&page=1&page_size=5" : null,
    empty,
  );
  return {
    items: stoppedRollouts(failed.data.items),
    error: failed.error,
    loading: failed.loading,
    retrying: failed.refreshing,
    retry: () => {
      if (failed.error) void failed.reload();
    },
  };
}

/**
 * The row shown when the check itself failed, so "Nothing needs you right
 * now" never appears after a failed read.
 */
export function StoppedRolloutsCheckFailed({
  stopped,
}: {
  stopped: StoppedRollouts;
}) {
  if (!stopped.error) return null;
  return (
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
          Rollouts that stopped in the last day may be missing here.
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
  );
}

/** A Needs-you row for a stopped rollout no device group already names. */
export function StoppedRolloutItem({
  item,
  onDismiss,
}: {
  item: StoppedRollout;
  onDismiss(): void;
}) {
  const d = item.deployment;
  return (
    <li className="overview-attention-item" data-severity="danger">
      <span className="overview-attention-icon" aria-hidden="true">
        <CircleX size={16} />
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
        <button
          type="button"
          className="button ghost compact"
          aria-label={`Dismiss: ${item.title}`}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
