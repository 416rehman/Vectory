import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Copy, KeyRound } from "lucide-react";
import { z } from "zod";
import {
  api,
  can,
  getSessionEpoch,
  withRequestDeadline,
  type Token,
  type User,
} from "./api";
import { Button, ErrorBox, Modal } from "./ui";
import {
  TokenCreateResultSchema,
  TokenRecordSchema,
  TokenRequestStatusSchema,
  beginTokenRequest,
  checkTokenCreation,
  checkTokenStatus,
  finishTokenRequest,
  readTokenRequests,
  useTokenRequests,
  tokenRequestAvailable,
  dismissTokenRequestIssue,
  type TokenCreateInput,
  type TokenRequestOperation,
  type TokenRequestStatus,
  type TokenRequestIssue,
} from "./enrollmentTokenRequests";
import "./enrollment-token-flow.css";
import type { Notify } from "./toast";

export type EnrollmentTokenFlowHandle = {
  /**
   * Create a token. Inline tokens are handed to `onReady` for the page to show
   * next to its command instead of opening the save dialog.
   */
  create(
    input: TokenCreateInput,
    options?: { inline?: boolean },
  ): Promise<Token | null>;
  openRevoke(token: Token): void;
  copySecret(): Promise<void>;
  /** The token did its job: drop the in-page copy and its reminder. */
  finish(): void;
  /** Drop the in-page copy; the saved request stays to be checked. */
  discard(): void;
};
export type ReadyToken = { token: string; record: Token };
type Selection = {
  id: string;
  operation?: TokenRequestOperation;
  issue?: TokenRequestIssue;
};
type Active = { controller: AbortController; epoch: number };

export default forwardRef<
  EnrollmentTokenFlowHandle,
  {
    user: User;
    notify: Notify;
    onChange(): void;
    onState(busy: boolean, blocked: boolean): void;
    onReady?(ready: ReadyToken | null): void;
  }
>(function EnrollmentTokenFlow(
  { user, notify, onChange, onState, onReady },
  ref,
) {
  const { operations, errors } = useTokenRequests(user.id);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [damaged, setDamaged] = useState<TokenRequestIssue | null>(null);
  const [status, setStatus] = useState<TokenRequestStatus | null>(null);
  const [ready, setReady] = useState<{
    operation: TokenRequestOperation;
    token: string;
    record: Token;
  } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  // An inline token is shown by the page beside its command, not in a dialog.
  const [inline, setInline] = useState(false);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [unconfirmedRevoke, setUnconfirmedRevoke] = useState<Token | null>(
    null,
  );
  const [revokeState, setRevokeState] = useState<
    "review" | "unknown" | "revoked"
  >("review");
  const [, redraw] = useState(0);
  const active = useRef<Active | null>(null),
    mounted = useRef(false);
  const requestOpener = useRef<HTMLElement | null>(null);
  const secretOpener = useRef<HTMLElement | null>(null);
  const revokeOpener = useRef<HTMLElement | null>(null);
  const damagedOpener = useRef<HTMLElement | null>(null);
  const focusedElement = () =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  function openSecret() {
    secretOpener.current = focusedElement();
    setShowSecret(true);
  }
  const knownTokens = useRef(new Map<string, string>());
  function rememberToken(id: string, record: Token | null) {
    if (!record) return;
    const known = knownTokens.current.get(id);
    if (known && known !== record.id)
      throw Error(
        "The response identifies a different token for this request. Keep the reminder and check again.",
      );
    knownTokens.current.set(id, record.id);
  }
  const owner = useRef({ id: user.id, role: user.role });
  owner.current = { id: user.id, role: user.role };
  const allowed = () =>
    mounted.current &&
    owner.current.id === user.id &&
    (owner.current.role === "admin" || owner.current.role === "operator") &&
    can(user, "operate");
  const current = (request: Active) =>
    allowed() &&
    active.current === request &&
    request.epoch === getSessionEpoch();
  const callbacks = useRef({ notify, onChange, onState, onReady });
  callbacks.current = { notify, onChange, onState, onReady };
  useEffect(() => {
    callbacks.current.onReady?.(
      ready ? { token: ready.token, record: ready.record } : null,
    );
  }, [ready]);
  useEffect(() => {
    mounted.current = true;
    const ended = () => {
      active.current?.controller.abort();
      active.current = null;
      setBusy(false);
      setReady(null);
      setShowSecret(false);
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
  const blocked = operations.length > 0 || errors.length > 0 || !!ready;
  useEffect(() => {
    if (!ready) return;
    const navigate = (event: Event) => {
      if (!can(user, "operate")) return;
      event.preventDefault();
      openSecret();
      setError("Save this token or discard its in-page copy before leaving.");
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!can(user, "operate")) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", navigate);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("vectory:before-navigate", navigate);
      window.removeEventListener("beforeunload", unload);
    };
  }, [ready, user]);
  useEffect(() => {
    callbacks.current.onState(busy, blocked);
  }, [busy, blocked]);
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
  function readStatus(id: string, request: Active) {
    return withRequestDeadline(
      (signal) =>
        api(`/tokens/requests/${id}`, { signal }, TokenRequestStatusSchema),
      30000,
      request.controller.signal,
    );
  }
  async function create(
    input: TokenCreateInput,
    options: { inline?: boolean } = {},
  ): Promise<Token | null> {
    const saved = readTokenRequests(user.id);
    if (saved.operations.length || saved.errors.length || ready) {
      setError(
        "Resolve the saved token request before creating another token.",
      );
      return null;
    }
    requestOpener.current = focusedElement();
    secretOpener.current = focusedElement();
    const request = claim();
    if (!request) return null;
    let operation: TokenRequestOperation | undefined;
    let sent = false;
    try {
      operation = beginTokenRequest(user.id, input);
      // An exact negative lookup proves protocol support, not cancellation.
      // Probe before sending so older servers never receive an untracked create.
      const support = await readStatus(operation.id, request);
      if (!current(request)) return null;
      checkTokenStatus(operation.id, support, operation);
      if (support.found) {
        rememberToken(operation.id, support.record);
        setSelection({ id: operation.id, operation });
        setStatus(support);
        return null;
      }
      if (!tokenRequestAvailable(operation))
        throw Error(
          "The saved token request changed in another tab. Review saved requests before continuing.",
        );
      sent = true;
      const result = await withRequestDeadline(
        (signal) =>
          api(
            "/tokens",
            {
              method: "POST",
              body: JSON.stringify(operation!.request),
              signal,
            },
            TokenCreateResultSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return null;
      if (!tokenRequestAvailable(operation))
        throw Error(
          "The saved request changed while the server was replying. Check the request status before using its token.",
        );
      checkTokenCreation(operation, result);
      rememberToken(operation.id, result.record);
      callbacks.current.onChange();
      if (!("token" in result)) {
        setSelection({ id: operation.id, operation });
        setStatus(result);
        return null;
      }
      setReady({ operation, token: result.token, record: result.record });
      setInline(!!options.inline);
      if (!options.inline) setShowSecret(true);
      // In the same update as the caller's, so its command and token appear together.
      callbacks.current.onReady?.({
        token: result.token,
        record: result.record,
      });
      return result.record;
    } catch (failure) {
      if (current(request)) {
        setError(
          sent
            ? "The token response was not confirmed. Check the saved request before creating a replacement."
            : (failure as Error).message,
        );
        if (operation) {
          setSelection({ id: operation.id, operation });
          setStatus(null);
        }
      }
      return null;
    } finally {
      release(request);
    }
  }
  useImperativeHandle(ref, () => ({
    create,
    openRevoke(token) {
      if (!allowed() || active.current) return;
      revokeOpener.current = focusedElement();
      setError("");
      setRevoking(unconfirmedRevoke || token);
      setRevokeState(unconfirmedRevoke ? "unknown" : "review");
    },
    copySecret,
    finish: acknowledge,
    discard() {
      if (!allowed()) return;
      setReady(null);
      setShowSecret(false);
      setError("");
    },
  }));
  async function inspect(item: Selection) {
    if (!selection) requestOpener.current = focusedElement();
    const request = claim();
    if (!request) return;
    setSelection(item);
    setStatus(null);
    try {
      const result = await readStatus(item.id, request);
      if (!current(request)) return;
      checkTokenStatus(item.id, result, item.operation);
      if (result.found) rememberToken(item.id, result.record);
      setStatus(result);
    } catch (failure) {
      if (current(request)) setError((failure as Error).message);
    } finally {
      release(request);
    }
  }
  async function cancelRequest() {
    if (!selection) return;
    const item = selection,
      request = claim();
    if (!request) return;
    try {
      const result = await withRequestDeadline(
        (signal) =>
          api(
            `/tokens/requests/${item.id}/cancel`,
            {
              method: "POST",
              body: "{}",
              signal,
            },
            TokenRequestStatusSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      checkTokenStatus(item.id, result, item.operation);
      if (result.found) rememberToken(item.id, result.record);
      if (!result.found || result.state !== "cancelled")
        throw Error(
          "Cancellation was not confirmed. Check this request again.",
        );
      setStatus(result);
      callbacks.current.onChange();
      if (ready?.operation.id === item.id) {
        setReady(null);
        setShowSecret(false);
      }
    } catch (failure) {
      if (current(request)) {
        setStatus(null);
        setError(
          "Cancellation was not confirmed. Check status; do not create a replacement yet.",
        );
      }
    } finally {
      release(request);
    }
  }
  function clearReminder() {
    if (!selection || !status?.found || status.state !== "cancelled") return;
    try {
      if (selection.operation) finishTokenRequest(selection.operation);
      else if (selection.issue) dismissTokenRequestIssue(selection.issue);
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
      finishTokenRequest(ready.operation);
      setReady(null);
      setShowSecret(false);
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  async function copySecret() {
    if (!allowed() || !ready) return;
    const epoch = getSessionEpoch();
    try {
      await navigator.clipboard.writeText(ready.token);
      if (allowed() && epoch === getSessionEpoch())
        callbacks.current.notify("Token copied.", { tone: "success" });
    } catch {
      if (allowed() && epoch === getSessionEpoch())
        setError(
          "Select and copy the token manually; clipboard access is unavailable.",
        );
    }
  }
  async function revoke(checkOnly = false) {
    if (!revoking) return;
    const token = revoking,
      request = claim();
    if (!request) return;
    try {
      if (!checkOnly) {
        await withRequestDeadline(
          (signal) =>
            api(
              `/tokens/${token.id}/revoke`,
              { method: "POST", body: "{}", signal },
              z.object({ ok: z.literal(true) }),
            ),
          30000,
          request.controller.signal,
        );
      }
      if (!current(request)) return;
      const records = await withRequestDeadline(
        (signal) => api("/tokens", { signal }, z.array(TokenRecordSchema)),
        30000,
        request.controller.signal,
      );
      if (!current(request)) return;
      const found = records.find((record) => record.id === token.id);
      if (!found)
        throw Error(
          "This token was not returned. Its revocation could not be verified.",
        );
      if (found.revoked) {
        setRevokeState("revoked");
        setUnconfirmedRevoke(null);
        callbacks.current.onChange();
      } else if (checkOnly) {
        setRevokeState("review");
        setUnconfirmedRevoke(null);
        setError(
          "This token is still available. You can confirm revocation again.",
        );
      } else {
        setRevokeState("unknown");
        setUnconfirmedRevoke(token);
        setError("Revocation was not confirmed. Check the current status.");
      }
    } catch (failure) {
      if (current(request)) {
        setRevokeState("unknown");
        setUnconfirmedRevoke(token);
        setError(
          "Revocation was not confirmed. Check the current status before trying again.",
        );
      }
    } finally {
      release(request);
    }
  }
  const visible = can(user, "operate");
  const requestTitle =
    status?.found && status.state === "cancelled"
      ? "Request cancelled"
      : "Check token request";
  // The page shows an inline token beside its command; list the rest here.
  const listed = operations.filter(
    (operation) => !(inline && ready?.operation.id === operation.id),
  );
  const pending =
    listed.length > 0 ||
    errors.length > 0 ||
    (!!ready &&
      (!inline ||
        !operations.some((operation) => operation.id === ready.operation.id)));
  return (
    <>
      {(pending || error || unconfirmedRevoke) && (
        <section
          className="enrollment-token-status"
          aria-label="Enrollment token requests"
        >
          <div className="enrollment-token-status-heading">
            <KeyRound size={17} aria-hidden="true" />
            <strong>
              {ready && !inline ? "Token ready to save" : "Token requests"}
            </strong>
          </div>
          {error && !selection && !showSecret && !revoking && (
            <ErrorBox message={error} />
          )}
          {listed.map((operation) => (
            <div className="enrollment-token-request" key={operation.id}>
              <div>
                <strong>{operation.request.name}</strong>
                <p>
                  {ready?.operation.id === operation.id
                    ? "Keep a private copy before continuing."
                    : "Check this request before creating another token. Its secret is shown only once."}
                </p>
              </div>
              <Button
                variant="secondary compact"
                disabled={busy || !visible}
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
            </div>
          ))}
          {ready &&
            !operations.some(
              (operation) => operation.id === ready.operation.id,
            ) && (
              <div className="enrollment-token-request">
                <div>
                  <strong>{ready.record.name}</strong>
                  <p>
                    The saved request changed in another tab. This page still
                    holds a copy; check its current status before using it.
                  </p>
                </div>
                <Button
                  variant="secondary compact"
                  disabled={busy || !visible}
                  onClick={openSecret}
                >
                  Show token
                </Button>
                <Button
                  variant="secondary compact"
                  disabled={busy || !visible}
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
            <div className="enrollment-token-request" key={issue.id || index}>
              <p>{issue.message}</p>
              {issue.id && (
                <Button
                  variant="secondary compact"
                  disabled={busy || !visible}
                  onClick={() => void inspect({ id: issue.id!, issue })}
                >
                  Check request
                </Button>
              )}
              {!issue.id && issue.kind === "corrupt" && (
                <Button
                  variant="secondary compact"
                  disabled={busy || !visible}
                  onClick={() => {
                    setError("");
                    damagedOpener.current = focusedElement();
                    setDamaged(issue);
                  }}
                >
                  Review unreadable reminder
                </Button>
              )}
            </div>
          ))}
          {unconfirmedRevoke && (
            <div className="enrollment-token-request">
              <div>
                <strong>{unconfirmedRevoke.name}</strong>
                <p>Revocation needs checking.</p>
              </div>
              <Button
                variant="secondary compact"
                disabled={busy || !visible}
                onClick={() => {
                  revokeOpener.current = focusedElement();
                  setRevoking(unconfirmedRevoke);
                  setRevokeState("unknown");
                  setError("");
                }}
              >
                Check revocation
              </Button>
            </div>
          )}
        </section>
      )}
      <Modal
        open={!!damaged && visible}
        returnFocusRef={damagedOpener}
        onClose={() => setDamaged(null)}
        title="Unreadable token reminder"
        description="This reminder has no usable request identity."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            Review the enrollment token list and revoke any unwanted tokens
            before dismissing this reminder. Dismissing it does not cancel a
            server request or revoke a token. The original secret cannot be
            retrieved.
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
                dismissTokenRequestIssue(damaged);
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
      <Modal
        open={!!selection && visible}
        returnFocusRef={requestOpener}
        onClose={() => {
          if (!busy) {
            setSelection(null);
            setError("");
          }
        }}
        title={requestTitle}
        description="Review this exact request before creating a replacement token."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            <strong>
              {selection?.operation?.request.name || "Enrollment token"}
            </strong>
          </p>
          {busy ? (
            <p role="status">Waiting for the server…</p>
          ) : status?.found ? (
            status.state === "cancelled" ? (
              <p>
                {status.record
                  ? "The token created by this request is revoked. Existing device connections are unchanged."
                  : "This request is cancelled. It cannot create a token, even if the original request arrives later."}
              </p>
            ) : (
              <p>
                A token was created. Its secret cannot be retrieved. Cancel this
                request to revoke that token before creating a replacement.
                Existing devices stay connected.
              </p>
            )
          ) : (
            <p>
              {status
                ? "No result is recorded yet. The original request may still arrive."
                : "The outcome is unknown."}{" "}
              Check its status or cancel the request before creating a
              replacement. Cancellation also revokes any token this request
              created; existing devices stay connected.
            </p>
          )}
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
            <Button onClick={clearReminder}>Continue setup</Button>
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
                onClick={() => void cancelRequest()}
              >
                {status?.found ? "Revoke token and cancel" : "Cancel request"}
              </Button>
            </>
          )}
        </div>
      </Modal>
      <Modal
        open={!!ready && showSecret && visible}
        returnFocusRef={secretOpener}
        onClose={() => setShowSecret(false)}
        title="Save your enrollment token"
        description="Keep a private copy. The server cannot show this token again."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <div className="control-command">
            <code>{visible ? ready?.token : ""}</code>
            <Button
              variant="secondary compact"
              icon={Copy}
              onClick={() => void copySecret()}
            >
              Copy token
            </Button>
          </div>
          <p className="control-muted">
            Closing this dialog keeps the token available in this page.
            Reloading, leaving the page or signing out removes this copy. If it
            is lost, check the saved request to revoke it and start again.
          </p>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            onClick={() => {
              if (!allowed()) return;
              setReady(null);
              setShowSecret(false);
              setError("");
            }}
          >
            Discard token copy
          </Button>
          <Button onClick={acknowledge}>I've saved the token</Button>
        </div>
      </Modal>
      <Modal
        open={!!revoking && visible}
        returnFocusRef={revokeOpener}
        onClose={() => !busy && setRevoking(null)}
        title={revokeState === "revoked" ? "Token revoked" : "Revoke token"}
        description="Existing device connections are unchanged."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            {revokeState === "revoked"
              ? "New enrollments are blocked for"
              : revokeState === "unknown"
                ? "Check whether revocation completed for"
                : "Prevent new enrollments using"}{" "}
            <strong>{revoking?.name}</strong>
            {revokeState === "review" ? "?" : "."}
          </p>
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setRevoking(null)}
          >
            {revokeState === "review" ? "Cancel" : "Close"}
          </Button>
          {revokeState !== "revoked" && (
            <Button
              variant={revokeState === "unknown" ? "secondary" : "danger"}
              busy={busy}
              onClick={() => void revoke(revokeState === "unknown")}
            >
              {revokeState === "unknown"
                ? "Check current status"
                : "Revoke token"}
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
});
