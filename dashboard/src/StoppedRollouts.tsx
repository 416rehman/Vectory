import { CircleX } from "lucide-react";
import type { DeploymentPage } from "./api";
import { useResource } from "./ui";
import { stoppedRollouts, type StoppedRollout } from "./stoppedRollouts";

const empty: DeploymentPage = { items: [], total: 0, page: 1, page_size: 5 };

/**
 * Rollouts that stopped by themselves in the last day, for the Overview's
 * "Needs you". Read from deployment history, so they stay listed after the
 * rollout itself is no longer in progress. Rolled-back rollouts are resolved
 * and not read.
 */
export function useStoppedRollouts(enabled: boolean) {
  const failed = useResource<DeploymentPage>(
    enabled ? "/deployments/history?status=failed&page=1&page_size=5" : null,
    empty,
  );
  return stoppedRollouts(failed.data.items);
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
