import { useEffect, useRef, useState } from "react";
import { ShieldOff } from "lucide-react";
import {
  api,
  can,
  getSessionEpoch,
  withRequestDeadline,
  type Device,
  type User,
} from "./api";
import { Button, ErrorBox, Modal } from "./ui";
import DocLink from "./DocLink";
import {
  DeviceRevocationStatusSchema,
  DeviceRevocationReceiptSchema,
  checkDeviceRevocationStatus,
  checkDeviceRevocationReceipt,
  readDeviceRevocationIntent,
  useDeviceRevocationIntent,
  beginDeviceRevocation,
  deviceRevocationIntentAvailable,
  finishDeviceRevocation,
  clearDeviceRevocationIssue,
} from "./deviceRevocation";
import "./device-revocation.css";

type Snapshot = ReturnType<typeof readDeviceRevocationIntent>;
type Active = { controller: AbortController; epoch: number };
type Phase = "review" | "unknown" | "confirmed";

export default function DeviceRevocation({
  device,
  user,
  onRefresh,
}: {
  device: Device;
  user: User;
  onRefresh(): Promise<void>;
}) {
  const saved = useDeviceRevocationIntent(user.id, device.id);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("review");
  const [checked, setChecked] = useState(false),
    [error, setError] = useState("");
  const [cleanupError, setCleanupError] = useState("");
  const [observedActive, setObservedActive] = useState(false);
  const active = useRef<Active | null>(null),
    mounted = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const context = `${user.id}:${user.role}:${device.id}`;
  const owner = useRef(context);
  owner.current = context;
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const pending = !!saved.intent || saved.issue?.kind === "corrupt";
  const confirmed = phase === "confirmed";
  const allowed = () =>
    mounted.current && owner.current === context && can(user, "operate");
  const current = (request: Active) =>
    allowed() &&
    active.current === request &&
    request.epoch === getSessionEpoch();

  useEffect(() => {
    mounted.current = true;
    const ended = () => {
      active.current?.controller.abort();
      active.current = null;
      setOpen(false);
      setBusy(false);
      setChecked(false);
    };
    window.addEventListener("vectory:session-ended", ended);
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
      window.removeEventListener("vectory:session-ended", ended);
    };
  }, []);
  function claim() {
    if (!allowed() || active.current) return null;
    const request = {
      controller: new AbortController(),
      epoch: getSessionEpoch(),
    };
    active.current = request;
    setBusy(true);
    setError("");
    return request;
  }
  function release(request: Active) {
    if (active.current !== request) return;
    active.current = null;
    if (mounted.current) setBusy(false);
  }
  function close() {
    active.current?.controller.abort();
    active.current = null;
    setOpen(false);
    setBusy(false);
    setChecked(false);
    setError("");
  }
  function confirmRevoked(snapshot: Snapshot) {
    setPhase("confirmed");
    setChecked(true);
    setObservedActive(false);
    setCleanupError("");
    try {
      if (snapshot.intent) finishDeviceRevocation(snapshot.intent);
      else if (snapshot.issue?.kind === "corrupt")
        clearDeviceRevocationIssue(snapshot.issue);
      else if (snapshot.issue) throw Error(snapshot.issue.message);
    } catch {
      setCleanupError(
        "Access is revoked, but the browser reminder could not be cleared. Check status again when storage is available.",
      );
    }
    void refresh.current().catch(() => {});
  }
  async function readStatus(
    request: Active,
    snapshot: Snapshot,
    uncertain: boolean,
  ) {
    const result = await withRequestDeadline(
      (signal) =>
        api(
          `/devices/${device.id}/revocation`,
          { signal },
          DeviceRevocationStatusSchema,
        ),
      30000,
      request.controller.signal,
    );
    if (!current(request)) return;
    checkDeviceRevocationStatus(device.id, result);
    if (result.revoked) {
      setError("");
      confirmRevoked(snapshot);
    } else {
      setPhase("review");
      setChecked(true);
      setObservedActive(uncertain);
      setCleanupError("");
      setError("");
    }
  }
  async function check() {
    const request = claim();
    if (!request) return;
    const snapshot = readDeviceRevocationIntent(user.id, device.id);
    const uncertain =
      !!snapshot.intent ||
      snapshot.issue?.kind === "corrupt" ||
      phase === "unknown";
    setChecked(false);
    try {
      await readStatus(request, snapshot, uncertain);
    } catch {
      if (current(request)) {
        setPhase("unknown");
        setError(
          "Current access could not be verified. Check status before confirming revocation. This requires a server with device-access status support.",
        );
      }
    } finally {
      release(request);
    }
  }
  function startReview() {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpen(true);
    setChecked(false);
    setObservedActive(false);
    setError("");
    setCleanupError("");
    void check();
  }
  async function revoke() {
    if (!checked || phase !== "review") return;
    const request = claim();
    if (!request) return;
    let snapshot = readDeviceRevocationIntent(user.id, device.id),
      sent = false;
    try {
      if (snapshot.issue?.kind === "unavailable")
        throw Error(snapshot.issue.message);
      if (!snapshot.intent && !snapshot.issue)
        snapshot = {
          intent: beginDeviceRevocation(user.id, device.id, device.name),
          issue: null,
        };
      const reminder = snapshot.intent || snapshot.issue;
      if (!reminder || !deviceRevocationIntentAvailable(reminder))
        throw Error(
          "The saved revocation reminder changed in another tab. Check status again before continuing.",
        );
      setPhase("unknown");
      setChecked(false);
      sent = true;
      const result = await withRequestDeadline(
        (signal) =>
          api(
            `/devices/${device.id}/revoke`,
            { method: "POST", body: "{}", signal },
            DeviceRevocationReceiptSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      checkDeviceRevocationReceipt(device.id, result);
      confirmRevoked(snapshot);
    } catch (failure) {
      if (!current(request)) return;
      if (!sent) {
        setError((failure as Error).message);
        setChecked(false);
      } else {
        setPhase("unknown");
        setError(
          "The revocation reply was not confirmed. Checking this device's current access; no second request is sent.",
        );
        try {
          await readStatus(request, snapshot, true);
        } catch {
          if (current(request)) {
            setPhase("unknown");
            setChecked(false);
            setError(
              "Revocation is unconfirmed. Check status before trying again; an earlier request may still complete.",
            );
          }
        }
      }
    } finally {
      release(request);
    }
  }
  if (!can(user, "operate")) return null;
  return (
    <section className="device-revocation" aria-label="Device access">
      <h3>Device access</h3>
      <p className="control-muted">
        {confirmed || device.status === "revoked"
          ? "This identity is revoked. Local files remain on the host."
          : "Revocation blocks future authenticated check-ins and changes. It does not remotely stop Vector or erase local files."}
      </p>
      {pending && (
        <p className="device-revocation-reminder" role="status">
          <ShieldOff size={16} aria-hidden="true" />A revocation request needs a
          status check.
        </p>
      )}
      {saved.issue?.kind === "unavailable" && (
        <p className="control-muted">{saved.issue.message}</p>
      )}
      <Button
        variant={
          pending || confirmed || device.status === "revoked"
            ? "secondary"
            : "danger-ghost"
        }
        onClick={startReview}
        disabled={busy}
      >
        {pending
          ? "Check revocation"
          : confirmed || device.status === "revoked"
            ? "View access status"
            : "Revoke device identity…"}
      </Button>
      <Modal
        className="device-revocation-dialog"
        open={open}
        returnFocusRef={opener}
        onClose={close}
        title={confirmed ? "Device access revoked" : "Revoke device access"}
        description={
          confirmed
            ? "The server has confirmed the state of this exact device identity."
            : "Review the device and what changes before revoking its access."
        }
      >
        <div className="modal-body">
          <p className="device-revocation-name">
            <strong>{device.name}</strong>
          </p>
          {error && <ErrorBox message={error} />}
          {cleanupError && <ErrorBox message={cleanupError} />}
          {busy ? (
            <p role="status">
              Checking with the server… You can close this dialog; any submitted
              request may still complete.
            </p>
          ) : confirmed ? (
            <p role="status">
              This device identity can no longer authenticate to Vectory. A
              status check confirms its current state, even if the original
              response was lost.
            </p>
          ) : observedActive ? (
            <p role="status">
              This identity is not revoked at the time of this check. An earlier
              request may still arrive. You can explicitly confirm revocation
              again for this same device.
            </p>
          ) : !checked ? (
            <p className="control-muted">
              A current status check is required before confirming revocation.
            </p>
          ) : (
            <p>This identity is not revoked. Revoking it will:</p>
          )}
          <ul className="control-instructions">
            <li>
              Block its device credentials from future authenticated requests.
            </li>
            <li>
              Remove it from groups and current persistent assignment targets.
            </li>
            <li>
              Leave local files and the Vector process under the host's control.
            </li>
          </ul>
          <p className="control-muted">
            Restoring access requires administrator-authorized identity recovery
            on the host. The replacement has a new identity and needs its groups
            and assignments restored.
          </p>
          <DocLink topic="telemetry" section="revoke-device-access">
            Device access and revocation guide
          </DocLink>
          <details className="control-disclosure">
            <summary>Device identity</summary>
            <code className="control-wrap-code">{device.id}</code>
          </details>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={close}>
            {confirmed || pending || busy ? "Close" : "Cancel"}
          </Button>
          {(!confirmed || cleanupError) && (
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => void check()}
            >
              Check status
            </Button>
          )}
          {!confirmed && checked && phase === "review" && (
            <Button
              variant="danger"
              disabled={busy || saved.issue?.kind === "unavailable"}
              onClick={() => void revoke()}
            >
              Revoke identity
            </Button>
          )}
        </div>
      </Modal>
    </section>
  );
}
