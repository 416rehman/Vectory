import { CircleX, Undo2 } from "lucide-react";
import type { DeploymentPage } from "./api";
import { useResource } from "./ui";
import { stoppedRollouts, type StoppedRollout } from "./stoppedRollouts";

const empty: DeploymentPage = { items: [], total: 0, page: 1, page_size: 5 };

/**
 * Rollouts that stopped on failures or were rolled back in the last day, for
 * the Overview's "Needs you". Read from deployment history, so they stay
 * listed after the rollout itself is no longer in progress.
 */
export function useStoppedRollouts(enabled: boolean) {
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
  return stoppedRollouts(failed.data.items, rolledBack.data.items);
}

/** Needs-you rows for stopped rollouts, each leading to its rollout page. */
export function StoppedRolloutItems({ items }: { items: StoppedRollout[] }) {
  return (
    <>
      {items.map((item) => {
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
