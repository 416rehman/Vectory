import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { KeyRound } from "lucide-react";
import { z } from "zod";
import {
  api,
  can,
  getSessionEpoch,
  withRequestDeadline,
  type Token,
  type User,
} from "./api";
import { Button, CopyButton, ErrorBox, Modal } from "./ui";
import {
  TokenCreateResultSchema,
  TokenRecordSchema,
  TokenRequestStatusSchema,
  beginTokenRequest,
  checkTokenCreation,
  checkTokenStatus,
  confirmTokenRequest,
  confirmed,
  enrollmentNote,
  finishTokenRequest,
  readTokenRequests,
  resolveTokenRequests,
  statusOutcome,
  tokenCanStillEnroll,
  useTokenRequests,
  tokenRequestAvailable,
  dismissTokenRequestIssue,
  when,
  type ListedToken,
  type TokenCreateInput,
  type TokenRecord,
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
  /** The token for a copy action; throws once this page may not show it. */
  secret(): string;
  /** The token did its job: drop the in-page copy and its reminder. */
  finish(): void;
  /** Drop the in-page copy; the saved request stays to be checked. */
  discard(): void;
  /**
   * Revoke the token this page holds and drop it with its reminder. Throws
   * a message to show when the server didn't confirm the revocation.
   */
  startOver(): Promise<void>;
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
    /**
     * The token list, to resolve stored requests whose creation was
     * confirmed; null while it loads or when it failed (nothing is dropped).
     */
    tokens?: readonly ListedToken[] | null;
    onChange(): void;
    onState(busy: boolean, blocked: boolean): void;
    onReady?(ready: ReadyToken | null): void;
    /** A stored request is done with; says what its token enrolled. */
    onSettled?(note: string): void;
  }
>(function EnrollmentTokenFlow(
  { user, notify, tokens = null, onChange, onState, onReady, onSettled },
  ref,
) {
  const { operations, errors } = useTokenRequests(user.id);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [damaged, setDamaged] = useState<TokenRequestIssue | null>(null);
  const [status, setStatus] = useState<TokenRequestStatus | null>(null);
  // What an exact status check found for requests whose response never
  // arrived here: "live" when their token could still enroll a device.
  const [checks, setChecks] = useState<Record<string, "live" | "unknown">>({});
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
  // Status checks run once per stored request, on their own, never for the
  // request this page is creating; unmounting aborts them.
  const background = useRef<AbortController | null>(null);
  const checked = useRef(new Set<string>()),
    settled = useRef(new Set<string>()),
    creating = useRef<string | null>(null);
  const tokenList = useRef(tokens);
  tokenList.current = tokens;
  const requestOpener = useRef<HTMLElement | null>(null);
  const secretOpener = useRef<HTMLElement | null>(null);
  const revokeOpener = useRef<HTMLElement | null>(null);
  const damagedOpener = useRef<HTMLElement | null>(null);
  // Where the person was heading when the token stopped them.
  const leaving = useRef<string | null>(null);
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
  const callbacks = useRef({ notify, onChange, onState, onReady, onSettled });
  callbacks.current = { notify, onChange, onState, onReady, onSettled };
  useEffect(() => {
    callbacks.current.onReady?.(
      ready ? { token: ready.token, record: ready.record } : null,
    );
  }, [ready]);
  useEffect(() => {
    mounted.current = true;
    background.current = new AbortController();
    const ended = () => {
      active.current?.controller.abort();
      active.current = null;
      leaving.current = null;
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
      background.current?.abort();
      window.removeEventListener("vectory:session-ended", ended);
    };
  }, []);
  // Only a creation whose response never arrived blocks another one; a
  // confirmed request is resolved against the token list below.
  const unconfirmed = operations.filter((operation) => !confirmed(operation));
  const blocked = unconfirmed.length > 0 || errors.length > 0 || !!ready;
  /**
   * Drop a stored request that is done with: its token enrolled something,
   * or can't enroll anything more. Says once what it enrolled.
   */
  function settle(
    operation: TokenRequestOperation,
    token: ListedToken | null,
    note = token ? enrollmentNote(token) : null,
  ) {
    if (settled.current.has(operation.id)) return;
    settled.current.add(operation.id);
    try {
      finishTokenRequest(operation);
    } catch {
      // Kept; it resolves the same way on the next visit.
    }
    if (note) callbacks.current.onSettled?.(note);
  }
  const readyId = ready?.operation.id;
  // Finished requests whose status arrived before the token list: they are
  // dropped once the list can name what their token enrolled.
  const finishedEarly = useRef(
    new Map<
      string,
      { operation: TokenRequestOperation; found: TokenRequestStatus }
    >(),
  );
  useEffect(() => {
    if (!allowed()) return;
    const known = operations.filter(
      (operation) => confirmed(operation) && operation.id !== readyId,
    );
    for (const resolution of resolveTokenRequests(known, tokens))
      if (resolution.kind === "finished")
        settle(resolution.operation, resolution.token, resolution.note);
    if (tokens)
      for (const [id, { operation, found }] of finishedEarly.current) {
        finishedEarly.current.delete(id);
        settle(operation, withDevices(found));
      }
  });
  useEffect(() => {
    if (!allowed() || !background.current) return;
    const signal = background.current.signal,
      epoch = getSessionEpoch();
    for (const operation of unconfirmed) {
      if (
        operation.id === creating.current ||
        checked.current.has(operation.id)
      )
        continue;
      checked.current.add(operation.id);
      void withRequestDeadline(
        (deadline) =>
          api(
            `/tokens/requests/${operation.id}`,
            { signal: deadline },
            TokenRequestStatusSchema,
          ),
        30000,
        signal,
      )
        .then((result) => {
          if (!allowed() || epoch !== getSessionEpoch()) return;
          const found = checkTokenStatus(operation.id, result, operation);
          const outcome = statusOutcome(found);
          if (outcome !== "finished")
            setChecks((previous) => ({ ...previous, [operation.id]: outcome }));
          else if (tokenList.current) settle(operation, withDevices(found));
          else {
            finishedEarly.current.set(operation.id, { operation, found });
            redraw((n) => n + 1);
          }
        })
        .catch(() => {
          // The reminder stays; Check request asks again.
        });
    }
  });
  /**
   * The request's token as its exact status reports it, with the device
   * names only the token list carries.
   */
  function withDevices(found: TokenRequestStatus): ListedToken | null {
    const record: TokenRecord | null = found.found ? found.record : null;
    if (!record) return null;
    const usage = tokenList.current?.find((token) => token.id === record.id);
    return usage
      ? {
          ...record,
          devices: usage.devices,
          device_count: usage.device_count,
          last_used_at: usage.last_used_at,
        }
      : record;
  }
  /** What became of a request's token that no longer needs this reminder. */
  function finishedText(token: ListedToken) {
    const note = enrollmentNote(token);
    if (note)
      return tokenCanStillEnroll(token)
        ? `${note} Its token still works until ${new Date(token.expires_at).toLocaleString()}; revoke it under Manage enrollment tokens when you no longer need it.`
        : `${note} Its token can't enroll another device, so there is nothing to cancel.`;
    return token.revoked
      ? "Its token was revoked before any device used it, so there is nothing to cancel."
      : "Its token expired before any device used it, so there is nothing to cancel.";
  }
  useEffect(() => {
    if (!ready) return;
    const navigate = (event: Event) => {
      if (!can(user, "operate")) return;
      event.preventDefault();
      leaving.current =
        (event as CustomEvent<{ route?: string }>).detail?.route ?? null;
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
  // Saving or discarding the token is the answer to the question that stopped
  // the person, so they go where they were heading.
  useEffect(() => {
    if (ready || !leaving.current) return;
    const route = leaving.current;
    leaving.current = null;
    location.hash = `/${route}`;
  }, [ready]);
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
    if (
      saved.operations.some((operation) => !confirmed(operation)) ||
      saved.errors.length ||
      ready
    ) {
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
      creating.current = operation.id;
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
      // The secret arrived: the reminder now tracks only its token, and
      // never blocks another request.
      let shown = operation;
      try {
        shown = confirmTokenRequest(operation, result.record);
      } catch {
        // Unconfirmed, it asks to be checked after a reload; the token works.
      }
      setReady({
        operation: shown,
        token: result.token,
        record: result.record,
      });
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
      creating.current = null;
      release(request);
    }
  }
  async function startOver() {
    if (!allowed() || !ready)
      throw Error(
        "This page no longer holds this command's token. Revoke it under Manage enrollment tokens if it may be exposed.",
      );
    const { operation, record } = ready;
    const request = claim();
    if (!request)
      throw Error("Wait for the current request to finish, then try again.");
    try {
      await withRequestDeadline(
        (signal) =>
          api(
            `/tokens/${record.id}/revoke`,
            { method: "POST", body: "{}", signal },
            z.object({ ok: z.literal(true) }),
          ),
        30000,
        request.controller.signal,
      );
      const records = await withRequestDeadline(
        (signal) => api("/tokens", { signal }, z.array(TokenRecordSchema)),
        30000,
        request.controller.signal,
      );
      if (!current(request)) throw Error("interrupted");
      const found = records.find((item) => item.id === record.id);
      if (found && tokenCanStillEnroll(found)) throw Error("still available");
    } catch {
      throw Error(
        "The server didn't confirm the revocation, so this command may still work. Try again, or revoke its token under Manage enrollment tokens.",
      );
    } finally {
      release(request);
    }
    settled.current.add(operation.id);
    try {
      finishTokenRequest(operation);
    } catch {
      // The reminder resolves as revoked on the next visit.
    }
    setReady(null);
    setShowSecret(false);
    setError("");
    callbacks.current.onChange();
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
    secret,
    finish: acknowledge,
    discard() {
      if (!allowed()) return;
      setReady(null);
      setShowSecret(false);
      setError("");
    },
    startOver,
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
      const outcome = statusOutcome(result);
      if (outcome !== "finished")
        setChecks((previous) => ({ ...previous, [item.id]: outcome }));
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
  /** After a confirmed cancellation, or a token that is done with. */
  function clearReminder() {
    if (!selection || !status?.found || statusOutcome(status) !== "finished")
      return;
    try {
      if (selection.operation) {
        settled.current.add(selection.operation.id);
        finishTokenRequest(selection.operation);
      } else if (selection.issue) dismissTokenRequestIssue(selection.issue);
      const token = status.state === "created" ? withDevices(status) : null;
      const note = token ? enrollmentNote(token) : null;
      setSelection(null);
      setStatus(null);
      setError("");
      if (note) callbacks.current.onSettled?.(note);
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
  function secret() {
    if (!allowed() || !ready) throw Error("The token is no longer shown here.");
    return ready.token;
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
  // The page shows an inline token beside its command; a token saved in the
  // dialog stays listed until it is saved. Confirmed requests aren't listed:
  // the page says what became of them.
  const listed = operations.filter((operation) =>
    ready?.operation.id === operation.id ? !inline : !confirmed(operation),
  );
  const outcome = status ? statusOutcome(status) : null;
  const finishedToken =
    status?.found && status.state === "created" && outcome === "finished"
      ? withDevices(status)
      : null;
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
                    : checks[operation.id] === "live"
                      ? `A token was created ${when(operation.recorded_at)} that no device has used. Revoke it before creating another.`
                      : `We couldn't confirm whether a token was created ${when(operation.recorded_at)}.`}
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
            ) : finishedToken ? (
              <p>{finishedText(finishedToken)}</p>
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
          ) : finishedToken ? (
            <Button onClick={clearReminder}>Done</Button>
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
        onClose={() => {
          // Closing without choosing means the person stays.
          leaving.current = null;
          setShowSecret(false);
        }}
        title="Save your enrollment token"
        description="Keep a private copy. The server cannot show this token again."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <div className="control-command">
            <code>{visible ? ready?.token : ""}</code>
            <CopyButton
              text={secret}
              label="Copy token"
              failedMessage="Copy isn't available here. Select the token to copy it."
            />
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
