import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { RotateCcw } from "lucide-react";
import {
  APIError,
  api,
  withRequestDeadline,
  type DeploymentSummary,
  type Device,
  type RolloutFailure,
} from "./api";
import { Button, ErrorBox, Modal, Spinner } from "./ui";
import { StatusChip } from "./DeploymentRollout";
import {
  explainError,
  targetLabel,
  targetTone,
  type StatusTone,
} from "./deploymentStatus";

/** Device states the server accepts a retry for (see POST /devices/{id}/retry). */
const retryableStates = [
  "failed",
  "rolled_back",
  "verification_unknown",
  "incompatible",
  "drift",
  "drift_detected",
];
/** The "Failed" part of the progress bar that a retry can act on. */
const failedStates = ["failed", "rolled_back", "incompatible"];
const concurrency = 4;

type Outcome = {
  state: "sending" | "sent" | "changed" | "unconfirmed" | "rejected";
  message: string;
};
const outcomeChip: Record<Outcome["state"], [string, StatusTone]> = {
  sending: ["Sending", "info"],
  sent: ["Retry sent", "success"],
  changed: ["Changed", "warning"],
  unconfirmed: ["Not confirmed", "warning"],
  rejected: ["Not sent", "danger"],
};

/** Why a device cannot be retried from this rollout, or null when it can. */
export function retryBlocker(
  device: Device,
  deployment: Pick<DeploymentSummary, "id" | "version_id">,
): string | null {
  if (device.status === "revoked") return "Revoked";
  if (device.assignment?.id !== deployment.id)
    return "Now follows another assignment";
  if (device.desired_version_id !== deployment.version_id)
    return "Now assigned another version";
  if (!retryableStates.includes(device.apply_state))
    return device.apply_state === "verified_applied"
      ? "Verified since"
      : "No longer failing";
  if (device.local_paused) return "Sync paused on the device";
  if (device.sync_paused) return "Sync paused by agent settings";
  if (device.retry_preconditions !== true) return "Needs a newer server";
  if (
    !Number.isSafeInteger(device.desired_generation) ||
    device.desired_generation < 1
  )
    return "No assignment to retry";
  return null;
}

function outcomeFor(error: unknown): Outcome {
  if (error instanceof APIError) {
    if (
      [
        "STALE_DEVICE_REVIEW",
        "DEVICE_NOT_RETRYABLE",
        "DEVICE_SYNC_PAUSED",
      ].includes(error.code)
    )
      return { state: "changed", message: error.message };
    if (error.serverRejection && error.status === 429)
      return {
        state: "rejected",
        message: "Retried less than a minute ago. Try again shortly.",
      };
    if (
      error.serverRejection &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    )
      return { state: "rejected", message: error.message };
  }
  return {
    state: "unconfirmed",
    message:
      "We couldn't confirm this retry. Nothing is resent automatically. Check the device before retrying.",
  };
}

/**
 * Sends a reviewed retry to failed devices of one rollout. Each request names
 * the exact version and generation that was reviewed, so a device that changed
 * meanwhile is refused rather than retried blindly.
 */
export default function DeploymentRetry({
  deployment,
  scope,
  returnFocusRef,
  onClose,
  onDone,
}: {
  deployment: DeploymentSummary;
  /** One failure group, or null for every failed device in the rollout. */
  scope: RolloutFailure | null;
  /** Where focus goes when the dialog closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  onDone(message: string): void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null),
    [loadError, setLoadError] = useState(""),
    [loading, setLoading] = useState(true),
    [chosen, setChosen] = useState<Set<string>>(new Set()),
    [outcomes, setOutcomes] = useState<Map<string, Outcome>>(new Map()),
    [sending, setSending] = useState(false),
    [finished, setFinished] = useState(false);
  const controller = useRef<AbortController | null>(null),
    sendingRef = useRef(false),
    mounted = useRef(true);
  const scopeIds = scope
    ? new Set(scope.device_ids || scope.devices.map((d) => d.device_id))
    : null;
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const request = new AbortController();
    controller.current = request;
    try {
      const list = await withRequestDeadline(
        (signal) => api<Device[]>("/devices", { signal }),
        30000,
        request.signal,
      );
      if (!mounted.current || controller.current !== request) return;
      setDevices(list);
      setChosen(
        new Set(
          list
            .filter(
              (device) => inScope(device) && !retryBlocker(device, deployment),
            )
            .map((device) => device.id),
        ),
      );
    } catch (e) {
      if (mounted.current && controller.current === request)
        setLoadError((e as Error).message);
    } finally {
      if (mounted.current && controller.current === request) setLoading(false);
    }
    // The scope and deployment are fixed for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function inScope(device: Device) {
    if (scopeIds) return scopeIds.has(device.id);
    return (
      device.assignment?.id === deployment.id &&
      failedStates.includes(device.apply_state)
    );
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    const guard = (event: Event) => {
      if (sendingRef.current) event.preventDefault();
    };
    const ended = () => controller.current?.abort();
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("vectory:session-ended", ended);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("vectory:session-ended", ended);
    };
  }, [load]);

  const listed = (devices || []).filter(inScope);
  const eligible = listed.filter((device) => !retryBlocker(device, deployment));
  const selected = eligible.filter((device) => chosen.has(device.id));
  const failedTargets = (
    ["failed", "rolled_back", "incompatible", "blocked"] as const
  )
    .map((state) => deployment.state_counts[state] || 0)
    .reduce((sum, n) => sum + n, 0);
  const missing = scope
    ? Math.max(0, scope.count - listed.length)
    : Math.max(0, failedTargets - listed.length);
  const version =
    deployment.version_number !== null
      ? `v${deployment.version_number}`
      : "the same version";

  async function send() {
    if (sendingRef.current || !selected.length) return;
    sendingRef.current = true;
    setSending(true);
    const request = new AbortController();
    controller.current = request;
    const queue = [...selected];
    const results = new Map<string, Outcome>();
    setOutcomes(
      new Map(
        queue.map((device) => [device.id, { state: "sending", message: "" }]),
      ),
    );
    async function worker() {
      for (let device = queue.shift(); device; device = queue.shift()) {
        const expected = {
          expected_version_id: device.desired_version_id!,
          expected_generation: device.desired_generation,
        };
        let outcome: Outcome;
        try {
          const result = await withRequestDeadline(
            (signal) =>
              api<Device>(`/devices/${encodeURIComponent(device.id)}/retry`, {
                method: "POST",
                body: JSON.stringify(expected),
                signal,
              }),
            30000,
            request.signal,
          );
          outcome =
            result.id === device.id &&
            result.desired_version_id === expected.expected_version_id &&
            result.desired_generation === expected.expected_generation + 1
              ? {
                  state: "sent",
                  message: "Applies on its next check-in.",
                }
              : {
                  state: "unconfirmed",
                  message:
                    "The response didn't confirm this retry. Check the device before retrying.",
                };
        } catch (e) {
          if (request.signal.aborted) return;
          outcome = outcomeFor(e);
        }
        results.set(device.id, outcome);
        if (mounted.current)
          setOutcomes((old) => new Map(old).set(device.id, outcome));
      }
    }
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, worker),
      );
    } finally {
      sendingRef.current = false;
      if (mounted.current) {
        setSending(false);
        setFinished(true);
      }
    }
    if (request.signal.aborted) return;
    const sent = [...results.values()].filter((o) => o.state === "sent").length;
    const unconfirmed = [...results.values()].filter(
      (o) => o.state === "unconfirmed",
    ).length;
    const notSent = results.size - sent - unconfirmed;
    onDone(
      [
        sent
          ? `Retry sent to ${sent} ${sent === 1 ? "device" : "devices"}. ${sent === 1 ? "It downloads" : "Each downloads"} ${version} again on its next check-in.`
          : "No retry was sent.",
        unconfirmed
          ? `${unconfirmed} couldn't be confirmed; nothing was resent.`
          : "",
        notSent ? `${notSent} changed or were refused.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  const title = scope
    ? `Retry ${scope.count} ${scope.count === 1 ? "device" : "devices"}`
    : "Retry failed devices";
  return (
    <Modal
      open
      wide
      className="deployment-retry-modal"
      returnFocusRef={returnFocusRef}
      onClose={() => {
        if (!sendingRef.current) onClose();
      }}
      title={title}
      description={`Each device downloads and validates ${version} again on its next check-in. This doesn't restart the rollout or release waiting devices.`}
    >
      <div className="modal-body deployment-retry">
        {scope && (
          <div className="deployment-retry-reason">
            <StatusChip tone={targetTone(scope.state)}>
              {targetLabel(scope.state)}
            </StatusChip>
            {scope.diagnostic ? (
              <code>{scope.diagnostic}</code>
            ) : (
              <span>
                {explainError(scope.message)?.summary ||
                  "The agent did not report a reason."}
              </span>
            )}
          </div>
        )}
        {loadError && <ErrorBox message={loadError} retry={load} />}
        {loading && !devices ? (
          <div className="loading" role="status">
            <Spinner />
            Checking each device
          </div>
        ) : (
          devices && (
            <>
              {listed.length === 0 ? (
                <p className="control-muted">
                  No failed devices follow this rollout any more. They may have
                  recovered, or a newer assignment replaced them.
                </p>
              ) : (
                <fieldset
                  className="deployment-retry-list"
                  disabled={sending || finished}
                >
                  <legend className="sr-only">Devices to retry</legend>
                  {eligible.length > 1 && !finished && (
                    <label className="deployment-retry-all">
                      <input
                        type="checkbox"
                        checked={selected.length === eligible.length}
                        ref={(input) => {
                          if (input)
                            input.indeterminate =
                              selected.length > 0 &&
                              selected.length < eligible.length;
                        }}
                        onChange={(event) =>
                          setChosen(
                            new Set(
                              event.target.checked
                                ? eligible.map((device) => device.id)
                                : [],
                            ),
                          )
                        }
                      />
                      <span>All {eligible.length} retryable devices</span>
                    </label>
                  )}
                  <ul>
                    {listed.map((device) => {
                      const blocker = retryBlocker(device, deployment);
                      const outcome = outcomes.get(device.id);
                      const attempt = device.configuration_attempt?.error;
                      const known = attempt ? explainError(attempt.code) : null;
                      const reason = attempt
                        ? known?.code
                          ? known.summary
                          : attempt.message
                        : null;
                      return (
                        <li
                          key={device.id}
                          data-blocked={blocker ? "true" : undefined}
                        >
                          <label>
                            <input
                              type="checkbox"
                              disabled={!!blocker}
                              checked={!blocker && chosen.has(device.id)}
                              onChange={() =>
                                setChosen((old) => {
                                  const next = new Set(old);
                                  if (next.has(device.id))
                                    next.delete(device.id);
                                  else next.add(device.id);
                                  return next;
                                })
                              }
                            />
                            <span className="deployment-retry-device">
                              <strong>{device.name}</strong>
                              <small>
                                {blocker
                                  ? blocker
                                  : reason && !scope
                                    ? reason
                                    : targetLabel(device.apply_state)}
                              </small>
                            </span>
                          </label>
                          {outcome ? (
                            <span className="deployment-retry-outcome">
                              <StatusChip
                                tone={outcomeChip[outcome.state][1]}
                                spin={outcome.state === "sending"}
                              >
                                {outcomeChip[outcome.state][0]}
                              </StatusChip>
                              {outcome.message && (
                                <small>{outcome.message}</small>
                              )}
                            </span>
                          ) : (
                            blocker && (
                              <StatusChip tone="neutral">
                                Can't retry
                              </StatusChip>
                            )
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              )}
              {missing > 0 && (
                <p className="control-muted">
                  {missing} other {missing === 1 ? "device" : "devices"} in this
                  group no longer {missing === 1 ? "follows" : "follow"} this
                  rollout or {missing === 1 ? "isn't" : "aren't"} listed any
                  more.
                </p>
              )}
            </>
          )
        )}
      </div>
      <div className="modal-footer">
        {finished ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={sending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              icon={RotateCcw}
              busy={sending}
              disabled={sending || loading || !selected.length}
              onClick={() => void send()}
            >
              {selected.length
                ? `Retry ${selected.length} ${selected.length === 1 ? "device" : "devices"}`
                : "Retry"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
