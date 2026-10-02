import { Clock3, Pause, ShieldCheck } from "lucide-react";
import type { CanaryWatch, DeploymentSummary } from "./api";
import { HelpLink } from "./DocLink";
import { exactTime } from "./deploymentStatus";
import { gateHeadline } from "./canaryWatch";
import {
  gateReasons,
  gateReasonLabels,
  gateReasonHelp,
  hasCanaryGate,
  readCanaryGate,
} from "./canaryGateModel";
import "./canary-gate.css";

/**
 * What the canary gate is waiting for, in one sentence that names the devices.
 * The stage lanes above own the countdown and the page header owns refreshing.
 */
export default function CanaryGate({
  deployment,
  readError,
  watch,
}: {
  deployment: DeploymentSummary;
  readError: boolean;
  /** Names the devices the gate is waiting on, from the rollout lanes. */
  watch?: CanaryWatch | null;
}) {
  if (!hasCanaryGate(deployment)) return null;
  const gate = readError ? null : readCanaryGate(deployment);
  const headline = gate ? gateHeadline(gate, watch) : null;
  const Icon =
    gate?.state === "paused"
      ? Pause
      : gate?.state === "observing"
        ? ShieldCheck
        : Clock3;
  return (
    <section className="canary-gate" aria-label="Canary gate">
      <header>
        <div className="canary-gate-heading">
          <Icon size={18} aria-hidden="true" />
          <h2>Canary gate</h2>
        </div>
        <div className="canary-gate-actions">
          <HelpLink
            topic="deployments"
            section="choose-a-rollout"
            label="Canary rollout help"
          />
        </div>
      </header>
      <strong className="canary-gate-state">
        {headline ? headline.title : "Current gate details unavailable"}
      </strong>
      {!gate || !headline ? (
        <p>
          Refresh this page to check the gate. This server may not provide
          current gate details. Recorded progress alone does not establish
          readiness.
        </p>
      ) : (
        <>
          {headline.detail && <p>{headline.detail}</p>}
          {headline.listed.length > 0 && (
            <ul className="canary-gate-reasons">
              {gateReasons
                .filter((reason) => headline.listed.includes(reason))
                .map((reason) => (
                  <li key={reason}>
                    <span className="canary-gate-reason-count">
                      {gate.reasons[reason]}
                    </span>
                    <div>
                      <strong>{gateReasonLabels[reason]}</strong>
                      <p>{gateReasonHelp[reason]}</p>
                    </div>
                  </li>
                ))}
            </ul>
          )}
          {gate.observation_started_at && (
            <dl className="canary-gate-timing">
              <div>
                <dt>Observation started</dt>
                <dd>{exactTime(gate.observation_started_at)}</dd>
              </div>
            </dl>
          )}
        </>
      )}
    </section>
  );
}
