import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  api,
  getCSRFToken,
  getCSRFVersion,
  getSessionEpoch,
  isSessionValid,
  download,
  withRequestDeadline,
  type User,
} from "./api";
import { isDefinitiveAuthRejection } from "./authRequests";
import {
  MfaConfirmSchema,
  MfaDisableSchema,
  MfaSetupSchema,
  MfaStatusSchema,
  mfaCanUseContext,
  mfaSameContext,
  mfaStatusMeaning,
  type MfaContext,
} from "./mfaActionModel";
import AuthenticatorSetup, {
  type AuthenticatorEnrollment,
} from "./AuthenticatorSetup";
import { Button, ErrorBox, Field, Modal, useResource } from "./ui";

type Flow = "setup" | "confirm" | "disable";
type Review = {
  flow: Flow;
  context: MfaContext;
  phase: "sending" | "unknown" | "changed";
  observed: boolean | null;
  error: string;
};
type Wait = { review: Review; controller: AbortController };

/** MFA responses may contain secrets that cannot be read from the server again. */
export default function MfaActions({
  user,
  notify,
}: {
  user: User;
  notify: (message: string) => void;
}) {
  const status = useResource<{ enabled: boolean }>("/mfa", {
    enabled: false,
  });
  const [action, setAction] = useState<"setup" | "disable" | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [setup, setSetup] = useState<AuthenticatorEnrollment | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [showCodes, setShowCodes] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const retained = useRef<Review | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refreshingAfterAction, setRefreshingAfterAction] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<Wait | null>(null);
  const statusRead = useRef<AbortController | null>(null);
  const receiptRead = useRef(0);
  const currentUser = useRef(user);
  const owner = useRef<MfaContext | null>(null);
  const secretOwner = useRef<MfaContext | null>(null);
  const mfaCodeInput = useRef<HTMLInputElement>(null);
  const recoveryAction = useRef<HTMLButtonElement>(null);

  function context(): MfaContext {
    return {
      userId: currentUser.current.id,
      role: currentUser.current.role,
      enabled: currentUser.current.enabled,
      csrfToken: getCSRFToken(),
      csrfVersion: getCSRFVersion(),
      epoch: getSessionEpoch(),
      valid: isSessionValid(),
    };
  }
  function remember(next: Review | null) {
    retained.current = next;
    setReview(next);
  }
  function clearSecrets() {
    secretOwner.current = null;
    setPassword("");
    setCode("");
    setSetup(null);
    setShowSetup(false);
    setRecoveryCodes([]);
    setShowCodes(false);
  }
  function stopWaiting(hide = false) {
    const request = active.current;
    if (request) {
      active.current = null;
      request.controller.abort();
      remember({ ...request.review, phase: "unknown", error: "" });
      clearSecrets();
    }
    if (hide) setShowReview(false);
  }
  function authorityChanged() {
    if (secretOwner.current)
      setNotice(
        "Authenticator details were hidden because your sign-in changed. Check the current setting before continuing.",
      );
    stopWaiting();
    statusRead.current?.abort();
    statusRead.current = null;
    setChecking(false);
    clearSecrets();
    setAction(null);
    setFormError("");
    setSetupError("");
    ++receiptRead.current;
    setRefreshingAfterAction(false);
    if (retained.current)
      remember({ ...retained.current, phase: "changed", observed: null });
  }
  useLayoutEffect(() => {
    currentUser.current = user;
    const next = context();
    if (owner.current && !mfaSameContext(owner.current, next))
      authorityChanged();
    owner.current = next;
  }, [user]);
  useLayoutEffect(
    () => () => {
      active.current?.controller.abort();
      active.current = null;
      statusRead.current?.abort();
      statusRead.current = null;
      ++receiptRead.current;
    },
    [],
  );
  useEffect(() => {
    const changed = () => {
      const next = context();
      if (owner.current && !mfaSameContext(owner.current, next))
        authorityChanged();
      owner.current = next;
    };
    window.addEventListener("vectory:session-ended", changed);
    window.addEventListener("vectory:session-changed", changed);
    return () => {
      window.removeEventListener("vectory:session-ended", changed);
      window.removeEventListener("vectory:session-changed", changed);
    };
  }, []);
  useEffect(() => {
    if (
      showReview &&
      (review?.phase === "unknown" || review?.phase === "changed")
    )
      recoveryAction.current?.focus();
  }, [showReview, review?.phase]);
  useLayoutEffect(() => {
    if (!recoveryCodes.length && !setup) return;
    const leave = (event: Event) => {
      const message = recoveryCodes.length
        ? "You have not marked your recovery codes saved. Leave and discard this browser's only copy?"
        : "Leave authenticator setup? Its current QR code and key will be lost.";
      if (!window.confirm(message)) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("vectory:before-navigate", leave);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("vectory:before-navigate", leave);
      window.removeEventListener("beforeunload", unload);
    };
  }, [recoveryCodes.length, setup]);

  function open() {
    if (active.current || statusRead.current) return;
    if (
      (recoveryCodes.length || setup) &&
      (!secretOwner.current ||
        !mfaCanUseContext(secretOwner.current, context()))
    ) {
      authorityChanged();
      return;
    }
    if (recoveryCodes.length) {
      setShowCodes(true);
      return;
    }
    if (refreshingAfterAction) return;
    if (retained.current) {
      setShowReview(true);
      return;
    }
    if (setup) {
      setShowSetup(true);
      return;
    }
    if (!mfaCanUseContext(context(), context())) return;
    setNotice("");
    setFormError("");
    setPassword("");
    setCode("");
    setUseRecoveryCode(false);
    setAction(status.data.enabled ? "disable" : "setup");
  }
  function owns(request: Wait) {
    return (
      active.current === request &&
      !request.controller.signal.aborted &&
      mfaCanUseContext(request.review.context, context())
    );
  }
  function refreshAfterReceipt() {
    // The POST receipt establishes what happened at that instant. Hold the
    // action controls until a new status read resolves; pre-POST cache must not
    // override a later change made by another browser.
    const read = ++receiptRead.current;
    setRefreshingAfterAction(true);
    void status.reloadResult().finally(() => {
      if (receiptRead.current === read) setRefreshingAfterAction(false);
    });
  }
  async function submit(flow: Flow, confirmationCode = "") {
    if (active.current || retained.current || !currentUser.current.enabled)
      return;
    if (flow !== "confirm" && action !== flow) return;
    if (flow === "confirm" && (!setup || !showSetup)) return;
    const original = context();
    if (!mfaCanUseContext(original, context())) return;
    if (flow === "confirm" && !/^[0-9]{6}$/.test(confirmationCode)) return;
    if (flow === "disable" && !code.trim()) return;
    if (flow !== "confirm" && !password) return;
    const next: Review = {
      flow,
      context: original,
      phase: "sending",
      observed: null,
      error: "",
    };
    const request = { review: next, controller: new AbortController() };
    active.current = request;
    const body =
      flow === "setup"
        ? { password }
        : flow === "confirm"
          ? { code: confirmationCode }
          : {
              password,
              ...(useRecoveryCode
                ? { recovery_code: code.trim() }
                : { code: code.trim() }),
            };
    setPassword("");
    setCode("");
    setFormError("");
    setSetupError("");
    setAction(null);
    setShowSetup(false);
    remember(next);
    setShowReview(true);
    const options = (signal: AbortSignal) => ({
      method: "POST",
      body: JSON.stringify(body),
      signal,
      headers: { "X-CSRF-Token": original.csrfToken },
    });
    try {
      if (flow === "setup") {
        const result = await withRequestDeadline(
          (signal) => api("/mfa/setup", options(signal), MfaSetupSchema),
          30000,
          request.controller.signal,
        );
        if (!owns(request)) return;
        secretOwner.current = original;
        setSetup(result);
        setShowSetup(true);
      } else if (flow === "confirm") {
        const result = await withRequestDeadline(
          (signal) => api("/mfa/confirm", options(signal), MfaConfirmSchema),
          30000,
          request.controller.signal,
        );
        if (!owns(request)) return;
        secretOwner.current = original;
        setSetup(null);
        setRecoveryCodes(result.recovery_codes);
        setShowCodes(true);
      } else {
        await withRequestDeadline(
          (signal) => api("/mfa/disable", options(signal), MfaDisableSchema),
          30000,
          request.controller.signal,
        );
        if (!owns(request)) return;
        clearSecrets();
        notify(
          "Two-factor authentication disabled. Other browser sessions were revoked.",
        );
      }
      active.current = null;
      remember(null);
      setShowReview(false);
      refreshAfterReceipt();
    } catch (failure) {
      if (active.current !== request) return;
      active.current = null;
      if (!mfaCanUseContext(original, context())) {
        authorityChanged();
        return;
      }
      if (
        isDefinitiveAuthRejection(failure) &&
        (failure as { status: number }).status !== 409
      ) {
        remember(null);
        setShowReview(false);
        if (flow === "confirm") {
          setSetupError((failure as Error).message);
          setShowSetup(true);
        } else {
          setFormError((failure as Error).message);
          setAction(flow);
        }
      } else {
        clearSecrets();
        remember({ ...next, phase: "unknown" });
      }
    }
  }
  async function checkStatus() {
    const previous = retained.current;
    if (!previous || previous.phase !== "unknown" || statusRead.current) return;
    if (!mfaCanUseContext(previous.context, context())) {
      authorityChanged();
      return;
    }
    const controller = new AbortController();
    statusRead.current = controller;
    setChecking(true);
    remember({ ...previous, error: "" });
    try {
      const result = await withRequestDeadline(
        (signal) => api("/mfa", { signal }, MfaStatusSchema),
        30000,
        controller.signal,
      );
      if (statusRead.current !== controller || !retained.current) return;
      if (!mfaCanUseContext(previous.context, context())) {
        authorityChanged();
        return;
      }
      remember({ ...retained.current, observed: result.enabled, error: "" });
      void status.reload();
    } catch (failure) {
      if (statusRead.current !== controller || !retained.current) return;
      remember({
        ...retained.current,
        observed: null,
        error: (failure as Error).message,
      });
    } finally {
      if (statusRead.current === controller) {
        statusRead.current = null;
        setChecking(false);
      }
    }
  }
  function closeReview() {
    if (active.current) stopWaiting(true);
    else {
      statusRead.current?.abort();
      statusRead.current = null;
      setChecking(false);
      setShowReview(false);
    }
  }
  function startFresh() {
    const previous = retained.current;
    if (
      !previous ||
      previous.phase !== "unknown" ||
      previous.observed === null ||
      checking ||
      active.current
    )
      return;
    if (!mfaCanUseContext(previous.context, context())) {
      authorityChanged();
      return;
    }
    clearSecrets();
    remember(null);
    setShowReview(false);
    setFormError("");
    // A currently enabled authenticator must be deliberately disabled before
    // a new setup can issue codes; current status never proves the old result.
    setAction(previous.observed ? "disable" : "setup");
  }
  const buttonLabel = recoveryCodes.length
    ? "Show recovery codes"
    : refreshingAfterAction
      ? "Checking authenticator..."
      : review
        ? "Review authenticator change"
        : setup
          ? "Continue authenticator setup"
          : status.data.enabled
            ? "Disable authenticator"
            : "Set up authenticator";
  return (
    <>
      <section className="control-card">
        <div className="control-section-head">
          <h2>Your account</h2>
        </div>
        <div className="control-security-account">
          <div>
            <h3>{user.name}</h3>
            <p>{user.email}</p>
            <p>
              Two-factor authentication:{" "}
              {status.loading || refreshingAfterAction
                ? "Checking..."
                : status.error
                  ? "Unavailable"
                  : status.data.enabled
                    ? "Enabled"
                    : "Not enabled"}
            </p>
            {review?.phase === "unknown" && (
              <p role="status">Authenticator change not confirmed.</p>
            )}
            {recoveryCodes.length > 0 && (
              <p role="status">
                Recovery codes are ready to save in this browser.
              </p>
            )}
            {setup && !showSetup && (
              <p role="status">Authenticator setup is ready to continue.</p>
            )}
            {notice && <p role="status">{notice}</p>}
          </div>
          <Button
            variant="secondary"
            disabled={
              !review &&
              !setup &&
              !recoveryCodes.length &&
              (status.loading || !!status.error || refreshingAfterAction)
            }
            onClick={open}
          >
            {buttonLabel}
          </Button>
        </div>
        {status.error && (
          <ErrorBox message={status.error} retry={() => void status.reload()} />
        )}
      </section>
      <Modal
        open={!!action}
        onClose={() => {
          setAction(null);
          setPassword("");
          setCode("");
          setFormError("");
        }}
        title={
          action === "disable"
            ? "Disable two-factor authentication"
            : "Verify your password"
        }
        description="Re-enter your current password to change account authentication."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (action) void submit(action);
          }}
        >
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            <Field label="Current password">
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {action === "disable" && (
              <>
                <Field
                  label={
                    useRecoveryCode
                      ? "Recovery code"
                      : "Current authenticator code"
                  }
                >
                  <input
                    ref={mfaCodeInput}
                    key={useRecoveryCode ? "recovery" : "authenticator"}
                    inputMode={useRecoveryCode ? "text" : "numeric"}
                    autoComplete={useRecoveryCode ? "off" : "one-time-code"}
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={useRecoveryCode ? 80 : 6}
                    pattern={useRecoveryCode ? undefined : "[0-9]{6}"}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setUseRecoveryCode((value) => !value);
                    setCode("");
                    setFormError("");
                    requestAnimationFrame(() => mfaCodeInput.current?.focus());
                  }}
                >
                  {useRecoveryCode
                    ? "Use an authenticator code instead"
                    : "Use a recovery code instead"}
                </Button>
                <p>
                  Disabling invalidates your remaining recovery codes and signs
                  out your other sessions.
                </p>
              </>
            )}
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              onClick={() => {
                setAction(null);
                setPassword("");
                setCode("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={action === "disable" ? "danger" : undefined}
            >
              {action === "disable" ? "Disable authenticator" : "Continue"}
            </Button>
          </div>
        </form>
      </Modal>
      {setup && (
        <AuthenticatorSetup
          setup={setup}
          email={user.email}
          busy={false}
          error={setupError}
          expired={false}
          open={showSetup}
          onClose={() => setShowSetup(false)}
          onRestart={() => {
            setShowSetup(false);
            setSetup(null);
            secretOwner.current = null;
            setAction("setup");
            setSetupError("");
          }}
          onConfirm={(value) => void submit("confirm", value)}
        />
      )}
      <Modal
        open={showReview && !!review}
        onClose={closeReview}
        title={
          review?.phase === "sending"
            ? "Waiting for the server"
            : review?.phase === "changed"
              ? "Your sign-in changed"
              : "Authenticator change not confirmed"
        }
        description="Review the current state before another authenticator action."
      >
        <div className="modal-body">
          {review?.error && <ErrorBox message={review.error} />}
          {review?.phase === "sending" ? (
            <p role="status">
              Waiting for the server. You can stop waiting, but the action may
              still finish.
            </p>
          ) : review?.phase === "changed" ? (
            <p>
              Your sign-in changed. The earlier request may have completed. Sign
              in again and inspect your account before another change.
            </p>
          ) : (
            review && (
              <>
                <p>
                  The response did not confirm this action. Checking status
                  reads the current setting only; it cannot prove what happened
                  to the earlier request.
                </p>
                {review.flow === "setup" && (
                  <p>
                    A setup key from an unread response cannot be retrieved. A
                    new setup needs your password and can invalidate an earlier
                    QR code. If a new code is rejected, check status and start
                    again.
                  </p>
                )}
                {review.flow === "confirm" && (
                  <p>
                    If confirmation finished, the eight recovery codes from its
                    unread response cannot be shown again. Keep your working
                    authenticator. To obtain new codes, deliberately disable it
                    and set it up again.
                  </p>
                )}
                {review.flow === "disable" && (
                  <p>
                    Do not resend the same code. Disabling again can affect
                    sessions created after the first request. Review the current
                    state before any new attempt.
                  </p>
                )}
                {review.observed !== null && (
                  <p role="status">
                    {mfaStatusMeaning(review.flow, review.observed)}
                  </p>
                )}
              </>
            )
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={closeReview}>
            {review?.phase === "sending" ? "Stop waiting" : "Back to account"}
          </Button>
          {review?.phase === "unknown" && (
            <Button
              ref={recoveryAction}
              busy={checking}
              onClick={() => void checkStatus()}
            >
              Check current status
            </Button>
          )}
          {review?.phase === "unknown" && review.observed !== null && (
            <Button onClick={startFresh}>
              {review.observed
                ? "Review a new disable request"
                : "Review a new setup"}
            </Button>
          )}
          {review?.phase === "changed" && (
            <Button
              ref={recoveryAction}
              onClick={() => {
                remember(null);
                setShowReview(false);
                void status.reload();
              }}
            >
              Dismiss old review
            </Button>
          )}
        </div>
      </Modal>
      <Modal
        open={showCodes && recoveryCodes.length > 0}
        onClose={() => setShowCodes(false)}
        title="Save your recovery codes"
        description="These single-use codes are shown once by the server. Keep them outside Vectory in a secure place."
      >
        <div className="modal-body">
          <p>
            These codes came from your confirmed setup. A later authenticator
            change can make them unusable.
          </p>
          <pre className="control-command">{recoveryCodes.join("\n")}</pre>
          <Button
            variant="secondary"
            icon={Download}
            onClick={() =>
              download("vectory-recovery-codes.txt", recoveryCodes.join("\n"))
            }
          >
            Download recovery codes
          </Button>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setShowCodes(false)}>
            Hide for now
          </Button>
          <Button
            onClick={() => {
              setRecoveryCodes([]);
              setShowCodes(false);
              secretOwner.current = null;
            }}
          >
            I’ve saved my recovery codes
          </Button>
        </div>
      </Modal>
    </>
  );
}
