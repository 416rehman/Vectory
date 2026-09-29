import { useState } from "react";
import { Clock3, Pause, ShieldCheck } from "lucide-react";
import type { DeploymentSummary } from "./api";
import { HelpLink } from "./DocLink";
import { exactTime } from "./deploymentStatus";
import { NextAdmission } from "./DeploymentRollout";
import { RefreshButton } from "./ui";
import {
  gateReasons,
  gateReasonLabels,
  gateReasonHelp,
  hasCanaryGate,
  observationDuration,
  readCanaryGate,
} from "./canaryGateModel";
import "./canary-gate.css";

export default function CanaryGate({
  deployment,
  readError,
  onRefresh,
  clockOffset = 0,
  lastWave = false,
}: {
  deployment: DeploymentSummary;
  readError: boolean;
  onRefresh(): Promise<void>;
  /** Server minus browser clock, from the latest read. */
  clockOffset?: number;
  lastWave?: boolean;
}) {
  const [refreshing, setRefreshing] = useState(false);
  if (!hasCanaryGate(deployment)) return null;
  const gate = readError ? null : readCanaryGate(deployment);
  const Icon =
    gate?.state === "paused"
      ? Pause
      : gate?.state === "observing"
        ? ShieldCheck
        : Clock3;
  const title = !gate
    ? "Current gate details unavailable"
    : gate.state === "paused"
      ? "Rollout paused"
      : gate.state === "observing"
        ? "Observation in progress"
        : gate.released_count === 0
          ? "Waiting for the first release"
          : gate.verified_count === gate.released_count
            ? "Waiting for the next rollout check"
            : "Waiting for current verification";
  return (
    <section className="canary-gate" aria-label="Canary gate">
      <header>
        <div className="canary-gate-heading">
          <Icon size={18} aria-hidden="true" />
          <h3>Canary gate</h3>
        </div>
        <div className="canary-gate-actions">
          <RefreshButton
            aria-label="Refresh canary gate"
            busy={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await onRefresh();
              } finally {
                setRefreshing(false);
              }
            }}
          />
          <HelpLink
            topic="deployments"
            section="choose-a-rollout"
            label="Canary rollout help"
          />
        </div>
      </header>
      <strong className="canary-gate-state">{title}</strong>
      {!gate ? (
        <p>
          Refresh to check the gate. This server may not provide current gate
          details. Recorded progress alone does not establish readiness.
        </p>
      ) : (
        <>
          <p>
            <strong>
              {gate.verified_count} of {gate.released_count}
            </strong>{" "}
            released devices currently verified.
            {gate.pending_count > 0 && (
              <>
                {" "}
                {gate.pending_count}{" "}
                {gate.pending_count === 1 ? "device is" : "devices are"} waiting
                for release.
              </>
            )}
          </p>
          {gateReasons.some((reason) => gate.reasons[reason] > 0) && (
            <ul className="canary-gate-reasons">
              {gateReasons
                .filter((reason) => gate.reasons[reason] > 0)
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
          {gate.state === "paused" ? (
            <p>
              Resume the rollout to begin a new observation period once the
              released devices are currently verified.
            </p>
          ) : gate.state === "observing" ? (
            <p>
              The server continues checking these devices before releasing the
              next batch or completing this rollout.
            </p>
          ) : gate.released_count > 0 &&
            gate.verified_count < gate.released_count ? (
            <p>
              The observation period restarts when all released devices are
              currently verified. Review their gate messages below.
            </p>
          ) : null}
          <div className="canary-gate-footer">
            {gate.state === "observing" && gate.observation_started_at && (
              <NextAdmission
                due={new Date(
                  Date.parse(gate.observation_started_at) +
                    gate.observation_seconds * 1000,
                ).toISOString()}
                totalSeconds={gate.observation_seconds}
                clockOffset={clockOffset}
                last={lastWave}
              />
            )}
            <dl className="canary-gate-timing">
              <div>
                <dt>Observation period</dt>
                <dd>{observationDuration(gate.observation_seconds)}</dd>
              </div>
              {gate.observation_started_at && (
                <div>
                  <dt>Started</dt>
                  <dd>{exactTime(gate.observation_started_at)}</dd>
                </div>
              )}
              <div>
                <dt>Checked</dt>
                <dd>{exactTime(gate.evaluated_at)}</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </section>
  );
}
