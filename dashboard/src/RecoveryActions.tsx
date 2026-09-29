import { useLayoutEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  APIError,
  api,
  can,
  getSessionEpoch,
  withRequestDeadline,
  type Device,
  type User,
} from "./api";
import { Button, ErrorBox, RefreshButton } from "./ui";
import DeviceRecoveryAuthorization from "./DeviceRecoveryAuthorization";
import "./control.css";

type DeviceRecoveryProps = {
  device: Device;
  user: User;
  onDone: (message: string) => void;
  onRefresh: () => Promise<void>;
};
export function eligibleState(snapshot: Device) {
  return [
    "failed",
    "rolled_back",
    "verification_unknown",
    "incompatible",
    "drift",
    "drift_detected",
  ].includes(snapshot.apply_state);
}
export function DeviceRecoveryActions(props: DeviceRecoveryProps) {
  return (
    <>
      <DeviceRetryAction {...props} />
      <DeviceIdentityRecovery {...props} />
    </>
  );
}
/** Application retry alone, e.g. beside a failure message. */
export function DeviceRetryAction(props: DeviceRecoveryProps) {
  const { device, user } = props;
  // Retire each retry review permanently when its assignment or eligibility
  // changes. Identity recovery keeps its independent review and token lifetime.
  const review = JSON.stringify([
    user.id,
    can(user, "operate"),
    device.id,
    device.desired_version_id,
    device.desired_generation,
    device.status === "revoked",
    !!device.local_paused,
    !!device.sync_paused,
    eligibleState(device),
    device.retry_preconditions === true,
  ]);
  return <DeviceApplicationRetry key={review} {...props} />;
}
/** Identity recovery alone, kept apart from routine sync controls. */
export function DeviceIdentityRecovery({ device, user }: DeviceRecoveryProps) {
  return (
    <DeviceRecoveryAuthorization
      key={`${user.id}:${user.role}:${device.id}:${device.name}`}
      device={device}
      user={user}
    />
  );
}
type RetryRequest = { controller: AbortController; epoch: number };
// Also used by Issues for "Retry on device"; mount it keyed by the reviewed
// assignment so a changed assignment retires the old review.
export function DeviceApplicationRetry({
  device,
  user,
  onDone,
  onRefresh,
}: DeviceRecoveryProps) {
  const [busy, setBusy] = useState(false);
  const active = useRef<RetryRequest | null>(null),
    mounted = useRef(false);
  const [retryState, setRetryState] = useState<{
    blocked: boolean;
    message: string;
    error: string;
  } | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    const ended = () => {
      active.current?.controller.abort();
      active.current = null;
      setBusy(false);
      setRetryState(null);
    };
    window.addEventListener("vectory:session-ended", ended);
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
      window.removeEventListener("vectory:session-ended", ended);
    };
  }, []);
  const current = (request: RetryRequest) =>
    mounted.current &&
    active.current === request &&
    request.epoch === getSessionEpoch() &&
    can(user, "operate");
  function claim() {
    if (!mounted.current || active.current || !can(user, "operate"))
      return null;
    const request = {
      controller: new AbortController(),
      epoch: getSessionEpoch(),
    };
    active.current = request;
    setBusy(true);
    return request;
  }
  function release(request: RetryRequest) {
    if (active.current !== request) return;
    active.current = null;
    if (mounted.current) setBusy(false);
  }
  const paused = device.local_paused || device.sync_paused;
  function refreshPage() {
    // The parent refresh has its own lifecycle; it must not hold this action latch.
    void onRefresh().catch(() => {});
  }
  async function checkCurrentStatus(request: RetryRequest) {
    try {
      const fresh = await withRequestDeadline(
        (signal) => api<Device>(`/devices/${device.id}`, { signal }),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      const sameAssignment =
        fresh.id === device.id &&
        fresh.desired_version_id === device.desired_version_id &&
        fresh.desired_generation === device.desired_generation;
      const available =
        sameAssignment &&
        fresh.status !== "revoked" &&
        eligibleState(fresh) &&
        fresh.retry_preconditions === true &&
        !fresh.local_paused &&
        !fresh.sync_paused;
      setRetryState((previous) =>
        previous
          ? {
              ...previous,
              blocked: !available,
              message: available
                ? "Status refreshed. The reviewed assignment is still eligible for retry. You can explicitly retry this assignment."
                : !sameAssignment
                  ? "Status refreshed. The assignment has changed. Review the current assignment before requesting a retry."
                  : "Status refreshed. This device is not currently eligible for retry. Review its reported state and any pause.",
              error: "",
            }
          : previous,
      );
    } catch {
      if (current(request))
        setRetryState((previous) =>
          previous
            ? {
                ...previous,
                blocked: true,
                message:
                  "Status could not be refreshed. No further retry was sent.",
                error:
                  "Current device status could not be refreshed. Check status before retrying.",
              }
            : previous,
        );
    } finally {
      if (current(request)) refreshPage();
    }
  }
  async function checkStatus() {
    const request = claim();
    if (!request) return;
    try {
      await checkCurrentStatus(request);
    } finally {
      release(request);
    }
  }
  async function retry() {
    if (
      !canRetry ||
      device.retry_preconditions !== true ||
      paused ||
      retryState?.blocked
    )
      return;
    const request = claim();
    if (!request) return;
    const expected = {
      expected_version_id: device.desired_version_id,
      expected_generation: device.desired_generation,
    };
    setRetryState({ blocked: true, message: "", error: "" });
    try {
      const result = await withRequestDeadline(
        (signal) =>
          api<Device>(`/devices/${device.id}/retry`, {
            method: "POST",
            body: JSON.stringify(expected),
            signal,
          }),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      if (
        result.id !== device.id ||
        result.desired_version_id !== expected.expected_version_id ||
        result.desired_generation !== expected.expected_generation + 1
      )
        throw new APIError(
          "CONTRACT_MISMATCH",
          "The response did not confirm the reviewed retry.",
          502,
        );
      setRetryState({
        blocked: true,
        message:
          "Retry requested for the reviewed assignment. Device verification is still pending.",
        error: "",
      });
      onDone(
        "Retry requested for the reviewed assignment. Device verification is still pending.",
      );
    } catch (e) {
      if (!current(request)) return;
      const stale =
        e instanceof APIError &&
        [
          "STALE_DEVICE_REVIEW",
          "DEVICE_NOT_RETRYABLE",
          "DEVICE_SYNC_PAUSED",
        ].includes(e.code);
      const rejected =
        e instanceof APIError &&
        e.serverRejection &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408;
      if (stale || !rejected) {
        setRetryState({
          blocked: true,
          message: stale
            ? "The device or assignment changed. Review its refreshed status before retrying."
            : "We could not confirm whether the retry was accepted. Checking current device status; no retry is sent automatically.",
          error: "",
        });
        await checkCurrentStatus(request);
      } else {
        setRetryState({
          blocked: false,
          message: "",
          error: (e as Error).message,
        });
      }
    } finally {
      release(request);
    }
  }
  const canRetry =
    can(user, "operate") &&
    device.desired_version_id &&
    Number.isSafeInteger(device.desired_generation) &&
    device.desired_generation > 0 &&
    device.status !== "revoked" &&
    eligibleState(device);
  if (!can(user, "operate") || (!canRetry && !retryState)) return null;
  return (
    <>
      {canRetry && (
        <div className="control-inline-actions">
          <Button
            variant="secondary"
            icon={RotateCcw}
            busy={busy}
            disabled={
              !!paused ||
              !!retryState?.blocked ||
              device.retry_preconditions !== true
            }
            onClick={retry}
          >
            Retry application
          </Button>
        </div>
      )}
      {canRetry && device.retry_preconditions !== true && (
        <p className="control-muted">
          Retry requires a newer server. You can still deploy a published
          version after reviewing its targets.
        </p>
      )}
      {canRetry && paused && (
        <p className="control-muted">
          {device.local_paused
            ? "Resume local sync on this device before retrying. The dashboard cannot clear a host-owned pause."
            : "Resume server sync before retrying. Retry does not change the pause policy."}
        </p>
      )}
      {retryState?.message && (
        <div className="control-section-space">
          <p className="control-muted" role="status">
            {retryState.message}
          </p>
          <RefreshButton busy={busy} onClick={checkStatus}>
            Check status
          </RefreshButton>
        </div>
      )}
      {retryState?.error && <ErrorBox message={retryState.error} />}
    </>
  );
}
