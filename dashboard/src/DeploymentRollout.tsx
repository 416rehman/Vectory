import { CircleCheck, Clock3, Wrench } from "lucide-react";
import type { DeploymentTarget, RolloutFailure, RolloutLane } from "./api";
import {
  countdown,
  exactTime,
  failureText,
  pipelineFixable,
  progressSegments,
  targetLabel,
  targetTone,
  timelineSteps,
  type ProgressSegment,
} from "./deploymentStatus";

import { StatusBadge, useNow } from "./ui";
import "./deployment-rollout.css";

function share(count: number, total: number) {
  return total ? `${Math.round((count / total) * 100)}%` : "0%";
}
/**
 * Stacked state bar. Segments sit on one baseline with a 2px surface gap; the
 * legend carries counts so identity never depends on color, and every segment
 * shows its label and count on hover or keyboard focus.
 */
export function ProgressBar({
  counts,
  stopped = false,
  variant = "full",
  label,
}: {
  counts: Record<string, number>;
  stopped?: boolean;
  variant?: "full" | "mini";
  label: string;
}) {
  const segments = progressSegments(counts, { stopped });
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const visible = segments.filter((segment) => segment.count > 0);
  const summary = visible
    .map((segment) => `${segment.count} ${segment.label.toLowerCase()}`)
    .join(", ");
  return (
    <div className="rollout-bar" data-variant={variant}>
      <div
        className="rollout-bar-track"
        role="img"
        aria-label={`${label}: ${summary || "no devices"}`}
      >
        {visible.map((segment) => (
          <span
            key={segment.key}
            className="rollout-bar-segment"
            data-segment={segment.key}
            style={{ flexGrow: segment.count }}
          >
            {variant === "full" && (
              <span className="rollout-tip" role="presentation">
                <strong>{segment.count}</strong> {segment.label}
                <small>{share(segment.count, total)}</small>
              </span>
            )}
          </span>
        ))}
        {!visible.length && <span className="rollout-bar-empty" />}
      </div>
      {variant === "full" && (
        <ul className="rollout-legend" aria-label={`${label} by state`}>
          {segments
            .filter(
              (segment) =>
                segment.count > 0 ||
                ["verified", "failed"].includes(segment.key),
            )
            .map((segment: ProgressSegment) => (
              <li key={segment.key} data-segment={segment.key}>
                <span className="rollout-swatch" aria-hidden="true" />
                <span className="rollout-legend-count">{segment.count}</span>
                <span>{segment.label}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

const laneTitles: Record<RolloutLane["kind"], string> = {
  canary: "Canary",
  batch: "Batch",
  all: "All devices",
  added: "Added later",
  not_released: "Not released",
};
export function laneTitle(lane: RolloutLane) {
  return lane.kind === "batch"
    ? `Batch ${lane.index}`
    : laneTitles[lane.kind] || "Devices";
}

/** The countdown ring for the next admission. */
export function NextAdmission({
  due,
  totalSeconds,
  clockOffset,
  last,
}: {
  due: string;
  totalSeconds: number;
  clockOffset: number;
  last: boolean;
}) {
  const now = useNow(null, { every: 250 }) + clockOffset;
  const remaining = Date.parse(due) - now;
  const fraction =
    totalSeconds > 0
      ? Math.min(1, Math.max(0, remaining / (totalSeconds * 1000)))
      : 0;
  const circumference = 2 * Math.PI * 15;
  const label = last ? "Completes" : "Next batch";
  return (
    <div className="rollout-countdown" role="timer" aria-live="off">
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="rollout-countdown-track" cx="18" cy="18" r="15" />
        <circle
          className="rollout-countdown-fill"
          cx="18"
          cy="18"
          r="15"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <span>
        <small>
          {remaining > 0 ? `${label} in` : `${label} at next check`}
        </small>
        <strong>{remaining > 0 ? countdown(remaining) : "now"}</strong>
      </span>
    </div>
  );
}

/**
 * Canary → batches as lanes, each with one mark per device colored by state
 * (with an icon legend and per-device labels on hover and focus).
 */
export function StageLanes({
  lanes,
  nextAdmissionAt,
  observationSeconds,
  clockOffset,
  failureThreshold,
  navigate,
}: {
  lanes: RolloutLane[];
  nextAdmissionAt: string | null;
  observationSeconds: number;
  clockOffset: number;
  failureThreshold: number | null;
  navigate(path: string): void;
}) {
  const current = lanes.findIndex(
    (lane) => lane.state === "in_progress" || lane.state === "failed",
  );
  let observing = -1;
  if (nextAdmissionAt !== null)
    lanes.forEach((lane, index) => {
      if (lane.released_at !== null) observing = index;
    });
  return (
    <ol className="rollout-lanes" aria-label="Release stages">
      {lanes.map((lane, index) => {
        const verified = lane.counts.verified_applied || 0;
        return (
          <li
            key={`${lane.kind}-${lane.index}-${index}`}
            className="rollout-lane"
            data-state={lane.state}
            aria-current={index === current ? "step" : undefined}
          >
            <header>
              <strong>{laneTitle(lane)}</strong>
              <StatusBadge domain="stage" value={lane.state} />
            </header>
            <p className="rollout-lane-count">
              <span>
                {verified} of {lane.size}
              </span>{" "}
              verified
            </p>
            <ul
              className="rollout-dots"
              aria-label={`${laneTitle(lane)} devices`}
            >
              {lane.devices.map((device) => (
                <li key={device.device_id}>
                  <a
                    href={`#/devices/${encodeURIComponent(device.device_id)}`}
                    className="rollout-dot"
                    data-tone={targetTone(device.state)}
                    aria-label={`${device.device_name || device.device_id}: ${targetLabel(device.state, { stopped: lane.state === "stopped" })}`}
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey)
                        return;
                      event.preventDefault();
                      navigate(
                        `devices/${encodeURIComponent(device.device_id)}`,
                      );
                    }}
                  >
                    <span className="rollout-tip" role="presentation">
                      <strong>{device.device_name || "Unnamed device"}</strong>
                      <small>
                        {targetLabel(device.state, {
                          stopped: lane.state === "stopped",
                        })}
                      </small>
                    </span>
                  </a>
                </li>
              ))}
              {lane.more > 0 && (
                <li className="rollout-dots-more">+{lane.more}</li>
              )}
            </ul>
            <footer>
              {index === observing && nextAdmissionAt ? (
                <NextAdmission
                  due={nextAdmissionAt}
                  totalSeconds={observationSeconds}
                  clockOffset={clockOffset}
                  last={index === lanes.length - 1}
                />
              ) : lane.verified_at ? (
                <span>
                  <CircleCheck size={13} aria-hidden="true" /> Verified{" "}
                  {exactTime(lane.verified_at)}
                </span>
              ) : lane.released_at ? (
                <span>
                  <Clock3 size={13} aria-hidden="true" /> Released{" "}
                  {exactTime(lane.released_at)}
                </span>
              ) : lane.state === "stopped" ? (
                <span>The rollout stopped before these devices.</span>
              ) : (
                <span>
                  Waits for {index === 0 ? "release" : "the stage before"}
                  {index > 0 && failureThreshold !== null
                    ? failureThreshold === 0
                      ? ". Stops on the first failure."
                      : `. Stops after ${failureThreshold + 1} failures.`
                    : "."}
                </span>
              )}
            </footer>
          </li>
        );
      })}
    </ol>
  );
}

/** The devices a failure group names, linked, with how many more. */
function GroupDevices({
  failure,
  navigate,
}: {
  failure: RolloutFailure;
  navigate(path: string): void;
}) {
  return (
    <p className="rollout-failure-devices">
      {failure.devices.map((device, position) => (
        <span key={device.device_id}>
          {position > 0 && ", "}
          <a
            href={`#/devices/${encodeURIComponent(device.device_id)}`}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              navigate(`devices/${encodeURIComponent(device.device_id)}`);
            }}
          >
            {device.device_name || device.device_id}
          </a>
        </span>
      ))}
      {failure.count > failure.devices.length &&
        ` and ${failure.count - failure.devices.length} more`}
    </p>
  );
}

/**
 * Failures grouped by what the agent reported, most common first. Each card
 * says the reason once; a failure only the pipeline can clear (a port in use,
 * a VRL error) leads with Fix in pipeline, and Retry comes second. When the
 * rollout stopped, the first card that offers a retry says what a retry does.
 */
export function FailureGroups({
  failures,
  navigate,
  onRetry,
  fixHref,
  stopped = false,
}: {
  failures: RolloutFailure[];
  navigate(path: string): void;
  onRetry?(failure: RolloutFailure): void;
  /** The pipeline, for failures only a pipeline change can clear. */
  fixHref?: string | null;
  /** The rollout stopped: a retry doesn't restart it. */
  stopped?: boolean;
}) {
  if (!failures.length) return null;
  const retryable = (failure: RolloutFailure) =>
    !!onRetry &&
    failure.state !== "degraded" &&
    failure.state !== "verification_unknown";
  const noted = stopped ? failures.findIndex(retryable) : -1;
  return (
    <section className="rollout-failures" aria-labelledby="rollout-failures">
      <h2 id="rollout-failures">Why devices failed</h2>
      <ul>
        {failures.map((failure, index) => {
          if (failure.state === "degraded")
            return (
              <DeliveryFailure
                key={`degraded-${index}`}
                failure={failure}
                navigate={navigate}
              />
            );
          const text = failureText(failure.diagnostic, failure.message);
          const fix = fixHref && pipelineFixable(failure.code) ? fixHref : null;
          const code = failure.code || text.code;
          return (
            <li key={`${failure.state}-${index}`}>
              <div className="rollout-failure-head">
                <StatusBadge
                  domain="target"
                  value={failure.state}
                  label={`${targetLabel(failure.state)} on ${failure.count} ${failure.count === 1 ? "device" : "devices"}`}
                />
                {(fix || retryable(failure)) && (
                  <span className="rollout-failure-actions">
                    {fix && (
                      <a className="button secondary compact" href={fix}>
                        <Wrench size={14} aria-hidden="true" />
                        Fix in pipeline
                      </a>
                    )}
                    {retryable(failure) && (
                      <button
                        type="button"
                        className={`button ${fix ? "ghost" : "secondary"} compact`}
                        onClick={() => onRetry!(failure)}
                      >
                        Retry these
                      </button>
                    )}
                  </span>
                )}
              </div>
              <p className="rollout-failure-reason">
                {text.reason || "The agent did not report a reason."}
              </p>
              {text.effect && (
                <p className="rollout-failure-detail">{text.effect}</p>
              )}
              {(failure.component_id || code) && (
                <p className="rollout-failure-detail rollout-failure-origin">
                  {failure.component_id && (
                    <span>
                      Step <code>{failure.component_id}</code>
                      {failure.field && (
                        <>
                          {" "}
                          · field <code>{failure.field}</code>
                        </>
                      )}
                    </span>
                  )}
                  {code && (
                    <span>
                      Agent code <code>{code}</code>
                    </span>
                  )}
                </p>
              )}
              <GroupDevices failure={failure} navigate={navigate} />
              {index === noted && (
                <p className="rollout-failure-footer">
                  Retrying a device sends the same version again. It
                  doesn&apos;t restart the rollout or release waiting devices.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Applied, but the device's telemetry shows it isn't delivering: the delivery
 * issue's title, the measured reason and the fix. Retrying the same version
 * can't help, so there is no retry.
 */
function DeliveryFailure({
  failure,
  navigate,
}: {
  failure: RolloutFailure;
  navigate(path: string): void;
}) {
  return (
    <li data-state="degraded">
      <div className="rollout-failure-head">
        <StatusBadge
          domain="target"
          value={failure.state}
          label={`${targetLabel(failure.state)} on ${failure.count} ${failure.count === 1 ? "device" : "devices"}`}
        />
      </div>
      <p className="rollout-failure-reason">
        {failure.message || "The pipeline isn't delivering events"}
      </p>
      {failure.diagnostic && (
        <p className="rollout-failure-detail">{failure.diagnostic}</p>
      )}
      {failure.fix && (
        <p className="rollout-failure-fix">
          <strong>Fix</strong> {failure.fix}
        </p>
      )}
      {failure.component_id && (
        <p className="rollout-failure-detail rollout-failure-origin">
          <span>
            Step <code>{failure.component_id}</code>
            {bufferFill(failure.buffer_utilization) &&
              ` · buffer ${bufferFill(failure.buffer_utilization)} full`}
          </span>
        </p>
      )}
      <GroupDevices failure={failure} navigate={navigate} />
    </li>
  );
}

/** A buffer's reported fill as a whole percentage, or null when unknown. */
export function bufferFill(value: number | null | undefined) {
  return typeof value === "number" && value >= 0 && value <= 1
    ? `${Math.round(value * 100)}%`
    : null;
}

/** Released → downloaded → validated → applied → verified for one device. */
export function DeviceTimeline({ target }: { target: DeploymentTarget }) {
  const steps = timelineSteps(target);
  return (
    <ol className="rollout-timeline" aria-label="Progress on this device">
      {steps.map((step) => (
        <li key={step.key} data-state={step.state}>
          <span className="rollout-timeline-mark" aria-hidden="true" />
          <span className="rollout-timeline-label">
            {step.label}
            <span className="sr-only">
              {step.state === "done"
                ? step.at
                  ? ` at ${exactTime(step.at)}`
                  : ", time not reported"
                : step.state === "failed"
                  ? ", failed"
                  : step.state === "current"
                    ? ", in progress"
                    : ", not yet"}
            </span>
          </span>
          {step.state === "done" && step.at && (
            <time dateTime={step.at} aria-hidden="true">
              {exactTime(step.at)}
            </time>
          )}
        </li>
      ))}
    </ol>
  );
}
