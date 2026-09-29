import { useEffect, useRef, useState } from "react";
import { Copy, Download, KeyRound } from "lucide-react";
import {
  api,
  can,
  download,
  getSessionEpoch,
  withRequestDeadline,
  type Device,
  type User,
} from "./api";
import { Button, ErrorBox, Modal } from "./ui";
import DocLink from "./DocLink";
import {
  DeviceRecoveryCreateResultSchema,
  DeviceRecoveryRequestStatusSchema,
  beginDeviceRecoveryRequest,
  checkDeviceRecoveryCreation,
  checkDeviceRecoveryStatus,
  deviceRecoveryRequestAvailable,
  dismissDeviceRecoveryRequestIssue,
  finishDeviceRecoveryRequest,
  readDeviceRecoveryRequests,
  useDeviceRecoveryRequests,
  type DeviceRecoveryRequestOperation,
  type DeviceRecoveryRequestIssue,
  type DeviceRecoveryRequestStatus,
} from "./deviceRecoveryRequests";
import "./enrollment-token-flow.css";
import "./device-recovery-authorization.css";

type Selection = {
  id: string;
  operation?: DeviceRecoveryRequestOperation;
  issue?: DeviceRecoveryRequestIssue;
};
type Active = { controller: AbortController; epoch: number };

export default function DeviceRecoveryAuthorization({
  device,
  user,
  onDone,
}: {
  device: Device;
  user: User;
  onDone(message: string): void;
}) {
  const { operations, errors } = useDeviceRecoveryRequests(user.id, device.id);
  const [review, setReview] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<DeviceRecoveryRequestStatus | null>(
    null,
  );
  const [damaged, setDamaged] = useState<DeviceRecoveryRequestIssue | null>(
    null,
  );
  const [ready, setReady] = useState<{
    operation: DeviceRecoveryRequestOperation;
    token: string;
    expiresAt: string;
  } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [, redraw] = useState(0);
  const mounted = useRef(false),
    active = useRef<Active | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const secretOpener = useRef<HTMLElement | null>(null);
  const knownTokens = useRef(new Map<string, string>());
  const context = JSON.stringify([user.id, user.role, device.id, device.name]);
  const owner = useRef(context);
  owner.current = context;
  const notify = useRef(onDone);
  notify.current = onDone;
  const allowed = () =>
    mounted.current && owner.current === context && can(user, "admin");
  const current = (request: Active) =>
    allowed() &&
    active.current === request &&
    request.epoch === getSessionEpoch();
  const focused = () =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const endpoint = `/devices/${device.id}/recovery-requests/`;
  const blocked = !!ready || operations.length > 0 || errors.length > 0;
  const visible = can(user, "admin");

  useEffect(() => {
    mounted.current = true;
    const ended = () => {
      active.current?.controller.abort();
      active.current = null;
      setBusy(false);
      setReady(null);
      setShowSecret(false);
      setReview(false);
      redraw((n) => n + 1);
    };
    window.addEventListener("vectory:session-ended", ended);
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
      window.removeEventListener("vectory:session-ended", ended);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const navigate = (event: Event) => {
      if (!allowed()) return;
      event.preventDefault();
      secretOpener.current = focused();
      setSelection(null);
      setDamaged(null);
      setReview(false);
      setShowSecret(true);
      setError(
        "Save this recovery token or discard its in-page copy before leaving.",
      );
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (allowed()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("vectory:before-navigate", navigate);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("vectory:before-navigate", navigate);
      window.removeEventListener("beforeunload", unload);
    };
  }, [ready, context]);
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
  function remember(id: string, record: { id: string } | null) {
    if (!record) return;
    const known = knownTokens.current.get(id);
    if (known && known !== record.id)
      throw Error(
        "The response identifies a different token. Keep this reminder and check again.",
      );
    knownTokens.current.set(id, record.id);
  }
  const readStatus = (id: string, request: Active) =>
    withRequestDeadline(
      (signal) =>
        api(endpoint + id, { signal }, DeviceRecoveryRequestStatusSchema),
      30000,
      request.controller.signal,
    );
  async function create() {
    const saved = readDeviceRecoveryRequests(user.id, device.id);
    if (ready || saved.operations.length || saved.errors.length) {
      setError(
        "Review the saved recovery request before creating another token.",
      );
      return;
    }
    const request = claim();
    if (!request) return;
    let operation: DeviceRecoveryRequestOperation | undefined,
      sent = false;
    try {
      operation = beginDeviceRecoveryRequest(user.id, device.id, device.name);
      const support = await readStatus(operation.id, request);
      if (!current(request)) return;
      checkDeviceRecoveryStatus(operation.id, device.id, support, operation);
      if (support.found) {
        remember(operation.id, support.record);
        setReview(false);
        setSelection({ id: operation.id, operation });
        setStatus(support);
        return;
      }
      if (!deviceRecoveryRequestAvailable(operation))
        throw Error(
          "This saved request changed in another tab. Check it before continuing.",
        );
      sent = true;
      const result = await withRequestDeadline(
        (signal) =>
          api(
            `/devices/${device.id}/recover`,
            {
              method: "POST",
              body: JSON.stringify(operation!.request),
              signal,
            },
            DeviceRecoveryCreateResultSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      if (!deviceRecoveryRequestAvailable(operation))
        throw Error(
          "The saved request changed while the server was replying. Check its status before using a token.",
        );
      checkDeviceRecoveryCreation(operation, result);
      remember(operation.id, result.record);
      setReview(false);
      if (!("token" in result)) {
        setSelection({ id: operation.id, operation });
        setStatus(result);
        return;
      }
      secretOpener.current = opener.current;
      setReady({
        operation,
        token: result.token,
        expiresAt: result.record.expires_at,
      });
      setShowSecret(true);
    } catch (failure) {
      if (current(request)) {
        setError(
          sent
            ? "The recovery token response was not confirmed. Check the saved request before creating a replacement."
            : (failure as Error).message,
        );
        if (operation) {
          setReview(false);
          setSelection({ id: operation.id, operation });
          setStatus(null);
        }
      }
    } finally {
      release(request);
    }
  }
  async function inspect(item: Selection) {
    if (!selection) opener.current = focused();
    const request = claim();
    if (!request) return;
    setSelection(item);
    setStatus(null);
    try {
      const result = await readStatus(item.id, request);
      if (!current(request)) return;
      checkDeviceRecoveryStatus(item.id, device.id, result, item.operation);
      if (result.found) remember(item.id, result.record);
      setStatus(result);
      if (
        result.found &&
        result.state === "cancelled" &&
        ready?.operation.id === item.id
      ) {
        setReady(null);
        setShowSecret(false);
      }
    } catch (failure) {
      if (current(request)) setError((failure as Error).message);
    } finally {
      release(request);
    }
  }
  async function cancel() {
    if (!selection) return;
    const item = selection,
      request = claim();
    if (!request) return;
    try {
      const result = await withRequestDeadline(
        (signal) =>
          api(
            endpoint + item.id + "/cancel",
            {
              method: "POST",
              body: "{}",
              signal,
            },
            DeviceRecoveryRequestStatusSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      checkDeviceRecoveryStatus(item.id, device.id, result, item.operation);
      if (result.found) remember(item.id, result.record);
      if (!result.found || result.state !== "cancelled")
        throw Error("Cancellation was not confirmed.");
      setStatus(result);
      if (ready?.operation.id === item.id) {
        setReady(null);
        setShowSecret(false);
      }
    } catch {
      if (current(request)) {
        setStatus(null);
        setError(
          "Cancellation was not confirmed. Check status before creating another token.",
        );
      }
    } finally {
      release(request);
    }
  }
  function clearReminder() {
    if (
      !allowed() ||
      !selection ||
      !status?.found ||
      status.state !== "cancelled"
    )
      return;
    try {
      if (selection.operation) finishDeviceRecoveryRequest(selection.operation);
      else if (selection.issue)
        dismissDeviceRecoveryRequestIssue(selection.issue);
      setSelection(null);
      setStatus(null);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  function acknowledge() {
    if (!allowed() || !ready) return;
    try {
      finishDeviceRecoveryRequest(ready.operation);
      setReady(null);
      setShowSecret(false);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  function openSecret() {
    secretOpener.current = focused();
    setError("");
    setShowSecret(true);
  }
  async function copy() {
    if (!allowed() || !ready) return;
    const epoch = getSessionEpoch();
    try {
      await navigator.clipboard.writeText(ready.token);
      if (allowed() && epoch === getSessionEpoch())
        notify.current("Recovery token copied.");
    } catch {
      if (allowed() && epoch === getSessionEpoch())
        setError(
          "Select and copy the token manually; clipboard access is unavailable.",
        );
    }
  }
  if (!visible) return null;
  return (
    <>
      <details className="control-disclosure" open={blocked || undefined}>
        <summary>Device recovery</summary>
        <div className="control-disclosure-content">
          <p className="control-muted">
            Replace an expired or lost device identity. Someone with access to
            this device completes recovery locally.
          </p>
          {error && !review && !selection && !showSecret && !damaged && (
            <ErrorBox message={error} />
          )}
          {blocked && (
            <section
              className="enrollment-token-status"
              aria-label="Device recovery requests"
            >
              <div className="enrollment-token-status-heading">
                <KeyRound size={17} aria-hidden="true" />
                <strong>
                  {ready
                    ? "Recovery token ready to save"
                    : "Recovery request needs attention"}
                </strong>
              </div>
              {operations.map((operation) => (
                <div className="enrollment-token-request" key={operation.id}>
                  <div>
                    <strong>{operation.request.expected_name}</strong>
                    <p>
                      {ready?.operation.id === operation.id
                        ? "Keep a private copy before continuing."
                        : "Check this request before creating another token."}
                    </p>
                  </div>
                  <div className="control-inline-actions">
                    <Button
                      variant="secondary compact"
                      disabled={busy}
                      onClick={() =>
                        ready?.operation.id === operation.id
                          ? openSecret()
                          : void inspect({ id: operation.id, operation })
                      }
                    >
                      {ready?.operation.id === operation.id
                        ? "Show token"
                        : "Check request"}
                    </Button>
                    {ready?.operation.id === operation.id && (
                      <Button
                        variant="secondary compact"
                        disabled={busy}
                        onClick={() =>
                          void inspect({ id: operation.id, operation })
                        }
                      >
                        Check request
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {ready &&
                !operations.some(
                  (operation) => operation.id === ready.operation.id,
                ) && (
                  <div className="enrollment-token-request">
                    <p>
                      The saved request changed in another tab. This page still
                      holds its token; check current status before using it.
                    </p>
                    <Button
                      variant="secondary compact"
                      disabled={busy}
                      onClick={openSecret}
                    >
                      Show token
                    </Button>
                    <Button
                      variant="secondary compact"
                      disabled={busy}
                      onClick={() =>
                        void inspect({
                          id: ready.operation.id,
                          operation: ready.operation,
                        })
                      }
                    >
                      Check request
                    </Button>
                  </div>
                )}
              {errors.map((issue, index) => (
                <div className="enrollment-token-request" key={index}>
                  <p>{issue.message}</p>
                  {issue.kind === "corrupt" && (
                    <Button
                      variant="secondary compact"
                      disabled={busy}
                      onClick={() => {
                        if (issue.id) void inspect({ id: issue.id, issue });
                        else {
                          opener.current = focused();
                          setError("");
                          setDamaged(issue);
                        }
                      }}
                    >
                      Review reminder
                    </Button>
                  )}
                </div>
              ))}
            </section>
          )}
          <Button
            variant="secondary"
            disabled={busy || blocked}
            onClick={() => {
              opener.current = focused();
              setError("");
              setReview(true);
            }}
          >
            Authorize device recovery
          </Button>
        </div>
      </details>
      <Modal
        className="device-recovery-dialog"
        open={review}
        returnFocusRef={opener}
        onClose={() => !busy && setReview(false)}
        title={`Recover ${device.name}`}
        description="Review what will change before creating a recovery token."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            The token works once, only for <strong>{device.name}</strong>, and
            expires in one hour. Creating it does not disconnect this device.
          </p>
          <h3 className="control-small-heading">When the token is used</h3>
          <ul className="control-instructions">
            <li>The old credential is revoked.</li>
            <li>A new device identity is created.</li>
            <li>Groups and pipeline assignments must be added again.</li>
          </ul>
          <DocLink topic="installation" section="recover-a-device-identity">
            Device recovery guide
          </DocLink>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setReview(false)}
          >
            Cancel
          </Button>
          <Button busy={busy} onClick={() => void create()}>
            Create recovery token
          </Button>
        </div>
      </Modal>
      <Modal
        className="device-recovery-dialog"
        open={!!selection}
        returnFocusRef={opener}
        onClose={() => {
          if (!busy) {
            setSelection(null);
            setError("");
          }
        }}
        title={
          status?.found && status.state === "cancelled"
            ? "Recovery request cancelled"
            : "Check recovery request"
        }
        description="Review this exact request before creating a replacement token."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            <strong>
              {selection?.operation?.request.expected_name || device.name}
            </strong>
          </p>
          {busy ? (
            <p role="status">Waiting for the server…</p>
          ) : status?.found && status.state === "cancelled" ? (
            <p>
              This request is closed. Its token is revoked if one was created,
              and a delayed request cannot create another.
            </p>
          ) : status?.found ? (
            <p>
              A recovery token was created. Its secret cannot be retrieved.
              Cancel this request to revoke the token before creating a
              replacement.
            </p>
          ) : (
            <p>
              {status
                ? "No result is recorded yet. The original request may still arrive."
                : "The outcome is unknown."}{" "}
              Check status or cancel this request before creating another token.
            </p>
          )}
          {status?.found && status.record && status.record.uses > 0 && (
            <p role="status">
              This token has already been used. Check Devices for the
              replacement identity before authorizing further recovery.
            </p>
          )}
          <p className="control-muted">
            Cancellation can block an unfinished recovery. If someone already
            started recovery on the host, preserve its pending files and
            original token, and check its outcome before revoking. A completed
            replacement stays connected; cancellation does not restore the old
            identity.
          </p>
          <details className="control-disclosure">
            <summary>Request details</summary>
            <code className="control-wrap-code">{selection?.id}</code>
          </details>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setSelection(null);
              setError("");
            }}
          >
            Close
          </Button>
          {status?.found && status.state === "cancelled" ? (
            <Button onClick={clearReminder}>Continue</Button>
          ) : (
            <>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() => selection && void inspect(selection)}
              >
                Check status
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void cancel()}
              >
                {status?.found ? "Revoke token and cancel" : "Cancel request"}
              </Button>
            </>
          )}
        </div>
      </Modal>
      <Modal
        className="device-recovery-dialog"
        open={!!ready && showSecret}
        returnFocusRef={secretOpener}
        onClose={() => setShowSecret(false)}
        title="Save the recovery token"
        description="Keep a private copy. The server cannot show this token again."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <div className="control-command">
            <code>{ready?.token}</code>
          </div>
          <div className="control-inline-actions control-section-space">
            <Button
              variant="secondary compact"
              icon={Copy}
              onClick={() => void copy()}
            >
              Copy token
            </Button>
            <Button
              variant="secondary compact"
              icon={Download}
              onClick={() => {
                if (allowed() && ready)
                  download("vectory-recovery-token.txt", ready.token);
              }}
            >
              Download token file
            </Button>
          </div>
          <p className="control-muted">
            Expires {ready && new Date(ready.expiresAt).toLocaleString()}.
            Closing this dialog keeps the token in this page. Reloading, leaving
            or signing out removes this copy.
          </p>
          <ol className="control-instructions">
            <li>
              On <strong>{ready?.operation.request.expected_name}</strong>, stop
              the agent and run <code>vectory recover-enrollment</code> with its
              state directory. Enter this token at the hidden terminal prompt.
            </li>
            <li>
              Start the agent and find the replacement identity in Devices.
            </li>
            <li>
              Restore its groups and pipeline assignment. Keep the token file
              private and delete it after recovery finishes.
            </li>
          </ol>
          <DocLink topic="installation" section="recover-a-device-identity">
            Device recovery guide
          </DocLink>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            onClick={() => {
              if (allowed()) {
                setReady(null);
                setShowSecret(false);
                setError("");
              }
            }}
          >
            Discard token copy
          </Button>
          <Button onClick={acknowledge}>I've saved the token</Button>
        </div>
      </Modal>
      <Modal
        className="device-recovery-dialog"
        open={!!damaged}
        returnFocusRef={opener}
        onClose={() => setDamaged(null)}
        title="Unreadable recovery reminder"
        description="This reminder has no usable request identity."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            Open Devices → Add device → Manage enrollment tokens and revoke any
            unwanted recovery tokens before dismissing this reminder. Dismissal
            does not cancel a server request, revoke a token or undo recovery.
            The original secret cannot be retrieved.
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setDamaged(null)}>
            Keep reminder
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!allowed() || !damaged) return;
              try {
                dismissDeviceRecoveryRequestIssue(damaged);
                setDamaged(null);
                setError("");
              } catch (failure) {
                setError((failure as Error).message);
              }
            }}
          >
            Dismiss unreadable reminder
          </Button>
        </div>
      </Modal>
    </>
  );
}
