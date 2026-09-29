import { useEffect, useState, type ReactNode } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import type { DeploymentTarget, RolloutFailure, RolloutLane } from "./api";
import {
  countdown,
  explainError,
  exactTime,
  progressSegments,
  since,
  targetLabel,
  targetTone,
  timelineSteps,
  type ProgressSegment,
  type StatusTone,
} from "./deploymentStatus";
import "./deployment-rollout.css";

/** Re-render once a second while mounted, for countdowns and "updated" stamps. */
export function useNow(active = true, everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

const toneIcons: Record<StatusTone, typeof CircleCheck> = {
  success: CircleCheck,
  danger: CircleX,
  warning: TriangleAlert,
  info: LoaderCircle,
  neutral: CircleDashed,
};
/** State chip: an icon and a label, never color alone. */
export function StatusChip({
  tone,
  children,
  spin = false,
}: {
  tone: StatusTone;
  children: ReactNode;
  spin?: boolean;
}) {
  const Icon = toneIcons[tone];
  return (
    <span className="rollout-chip" data-tone={tone}>
      <Icon
        size={14}
        aria-hidden="true"
        className={spin && tone === "info" ? "rollout-spin" : undefined}
      />
      <span>{children}</span>
    </span>
  );
}

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
const laneStates: Record<
  RolloutLane["state"],
  { label: string; tone: StatusTone }
> = {
  verified: { label: "Verified", tone: "success" },
  in_progress: { label: "Rolling out", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
  queued: { label: "Queued", tone: "neutral" },
  stopped: { label: "Not released", tone: "neutral" },
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
  const now = useNow(true, 250) + clockOffset;
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
        const state = laneStates[lane.state];
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
              <StatusChip tone={state.tone} spin>
                {state.label}
              </StatusChip>
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

/** Failures grouped by what the agent reported, most common first. */
export function FailureGroups({
  failures,
  navigate,
  onRetry,
}: {
  failures: RolloutFailure[];
  navigate(path: string): void;
  onRetry?(failure: RolloutFailure): void;
}) {
  if (!failures.length) return null;
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
          const explained = explainError(failure.message);
          const reason =
            failure.diagnostic ||
            explained?.summary ||
            "The agent did not report a reason.";
          return (
            <li key={`${failure.state}-${index}`}>
              <div className="rollout-failure-head">
                <StatusChip
                  tone={
                    failure.state === "verification_unknown"
                      ? "warning"
                      : "danger"
                  }
                >
                  {targetLabel(failure.state)} on {failure.count}{" "}
                  {failure.count === 1 ? "device" : "devices"}
                </StatusChip>
                {onRetry && failure.state !== "verification_unknown" && (
                  <button
                    type="button"
                    className="button secondary compact"
                    onClick={() => onRetry(failure)}
                  >
                    Retry these
                  </button>
                )}
              </div>
              <p className="rollout-failure-reason">
                {failure.diagnostic ? <code>{reason}</code> : reason}
              </p>
              {failure.diagnostic && explained && (
                <p className="rollout-failure-detail">{explained.summary}</p>
              )}
              {explained?.code && (
                <p className="rollout-failure-detail">
                  Agent code <code>{explained.code}</code>
                </p>
              )}
              <p className="rollout-failure-devices">
                {failure.devices.map((device, position) => (
                  <span key={device.device_id}>
                    {position > 0 && ", "}
                    <a
                      href={`#/devices/${encodeURIComponent(device.device_id)}`}
                      onClick={(event) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey
                        )
                          return;
                        event.preventDefault();
                        navigate(
                          `devices/${encodeURIComponent(device.device_id)}`,
                        );
                      }}
                    >
                      {device.device_name || device.device_id}
                    </a>
                  </span>
                ))}
                {failure.count > failure.devices.length &&
                  ` and ${failure.count - failure.devices.length} more`}
              </p>
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
        <StatusChip tone="warning">
          {targetLabel(failure.state)} on {failure.count}{" "}
          {failure.count === 1 ? "device" : "devices"}
        </StatusChip>
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
      <p className="rollout-failure-devices">
        {failure.devices.map((device, position) => (
          <span key={device.device_id}>
            {position > 0 && ", "}
            <a
              href={`#/devices/${encodeURIComponent(device.device_id)}`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey)
                  return;
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
    </li>
  );
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

/** "Updated 3 s ago · live" for a polled view. */
export function UpdatedStamp({
  at,
  live,
  error,
}: {
  at: number | null;
  live: boolean;
  error?: boolean;
}) {
  const now = useNow(true, 1000);
  if (!at) return null;
  const text = since(new Date(at).toISOString(), now);
  return (
    <span
      className="rollout-updated"
      data-live={live || undefined}
      role="status"
    >
      {live && <span className="rollout-live-dot" aria-hidden="true" />}
      {error ? "Couldn't refresh · updated " : "Updated "}
      {text === "Just now" ? "just now" : text}
      {live && !error ? " · live" : ""}
    </span>
  );
}
