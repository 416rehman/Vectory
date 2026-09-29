import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import {
  APIError,
  api,
  LoginSchema,
  SessionSchema,
  setCSRF,
  withRequestDeadline,
  type LoginChallenge,
  type User,
} from "./api";
import {
  authAuthorityUnchanged,
  authUserMatches,
  isUncertainOutcome,
  rememberSignInEmail,
  retryDelay,
  signedOutRecently,
  useAuthRequest,
  type AuthRequest,
} from "./authRequests";
import {
  AuthField,
  OtpInput,
  PasswordField,
  Unconfirmed,
  formatCountdown,
  useCountdown,
} from "./authControls";
import { Button, Modal, Spinner } from "./ui";
import { isSigningOut } from "./signOutSession";
import "./auth.css";

const REASONS: Record<string, [string, string]> = {
  expired: [
    "Your session expired",
    "Sessions last 12 hours. Sign in to pick up where you left off.",
  ],
  signed_out: [
    "You signed out in another tab",
    "Sign in to keep working here.",
  ],
  signed_out_elsewhere: [
    "You were signed out from another browser",
    "Sign in to keep working here.",
  ],
  password_changed: [
    "Your password was changed",
    "Sign in with your new password to continue.",
  ],
  access_changed: [
    "Your access changed",
    "An administrator updated your account. Sign in to continue.",
  ],
  mfa_changed: [
    "Your two-factor settings changed",
    "Sign in again to continue.",
  ],
  mfa_reset: [
    "Your two-factor authentication was reset",
    "Sign in with your password, then set it up again.",
  ],
};
const ENDED: [string, string] = [
  "Your session ended",
  "Sign in to continue where you left off.",
];

/**
 * Shown over the workspace when the session ends. Nothing underneath unmounts,
 * so unsaved work survives; pages read again once the session resumes.
 */
export default function SessionRenewal({
  user,
  onRenewed,
  onSignInAgain,
}: {
  user: User;
  onRenewed: (user: User) => void;
  onSignInAgain: () => void;
}) {
  const [open, setOpen] = useState(true);
  // A deliberate sign-out in this tab expects the session to end.
  const [signingOut, setSigningOutState] = useState(isSigningOut);
  const [phase, setPhase] = useState<"checking" | "password" | "mfa">(
    "checking",
  );
  const [reason, setReason] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [alert, setAlert] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [other, setOther] = useState("");
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);
  // Submissions and passive session reads are claimed separately, so a read
  // started by a focus change never blocks a deliberate sign-in.
  const requests = useAuthRequest();
  const probes = useAuthRequest();
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const reopen = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<React.RefObject<HTMLInputElement | null> | null>(
    null,
  );
  const throttle = useCountdown(throttledUntil);
  const throttled = throttle !== null && throttle > 0;
  const [headline, explanation] = (reason && REASONS[reason]) || ENDED;

  function renewed(session: { user: User; csrf_token: string }): boolean {
    if (session.user.id !== user.id || !session.user.enabled) return false;
    setCSRF(session.csrf_token);
    setPassword("");
    setCode("");
    onRenewed(session.user);
    return true;
  }
  /** Read the current session once. A matching, enabled session is adopted. */
  async function readSession(
    tracker: ReturnType<typeof useAuthRequest>,
    request: AuthRequest,
  ) {
    try {
      const session = await withRequestDeadline(
        (signal) => api("/session", { signal }, SessionSchema),
        30000,
        request.controller.signal,
      );
      if (!tracker.current(request)) return "stale";
      if (renewed(session)) return "renewed";
      setOther(session.user.email);
      return "other";
    } catch (failure) {
      if (!tracker.current(request)) return "stale";
      if (failure instanceof APIError && failure.status === 401) {
        setReason(
          failure.reason ?? (signedOutRecently() ? "signed_out" : null),
        );
        return "absent";
      }
      return "unknown";
    }
  }
  async function check() {
    const request = probes.claim();
    if (!request) return;
    await readSession(probes, request);
    if (probes.finish(request))
      setPhase((current) => (current === "checking" ? "password" : current));
  }
  useEffect(() => {
    void check();
    // Another tab may sign in again first; this tab then only needs to notice.
    const changed = (event: StorageEvent) => {
      if (event.key === "vectory-session-change") void check();
    };
    const focused = () => void check();
    window.addEventListener("storage", changed);
    window.addEventListener("focus", focused);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", focused);
    };
  }, []);
  useEffect(() => {
    const changed = () => setSigningOutState(isSigningOut());
    window.addEventListener("vectory:sign-out-activity", changed);
    return () =>
      window.removeEventListener("vectory:sign-out-activity", changed);
  }, []);
  useEffect(() => {
    if (busy || !focusNext.current) return;
    const target = focusNext.current;
    focusNext.current = null;
    requestAnimationFrame(() => target.current?.focus());
  }, [busy]);
  useEffect(() => {
    if (throttle === 0) {
      setThrottledUntil(null);
      setAlert("");
    }
  }, [throttle]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() =>
      (phase === "mfa" ? codeInput : passwordInput).current?.focus(),
    );
  }, [phase, open]);

  function fail(failure: unknown, wrong: string) {
    const failed = failure instanceof APIError ? failure.code : "";
    const wait = retryDelay(failure);
    if (wait) {
      setThrottledUntil(Date.now() + wait * 1000);
      setAlert("Too many attempts for this account.");
    } else if (failed === "UNAUTHENTICATED" || failed === "INVALID_MFA_CODE")
      setError(wrong);
    else if (
      failed === "MFA_TOO_MANY_ATTEMPTS" ||
      failed === "MFA_CHALLENGE_EXPIRED"
    ) {
      setChallenge(null);
      setPhase("password");
      setAlert(
        failed === "MFA_TOO_MANY_ATTEMPTS"
          ? "Too many incorrect codes. Enter your password again."
          : "That verification timed out. Enter your password again.",
      );
    } else setAlert((failure as Error).message);
  }
  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    if (throttled || !password) return;
    const request = requests.claim();
    if (!request) return;
    const submitted = password;
    setBusy(true);
    setError("");
    setAlert("");
    setUncertain(false);
    try {
      const login = await withRequestDeadline(
        (signal) =>
          api(
            "/login",
            {
              method: "POST",
              body: JSON.stringify({ email: user.email, password: submitted }),
              signal,
            },
            LoginSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      setPassword("");
      if (!authAuthorityUnchanged(request))
        throw new Error("The browser's sign-in state changed while waiting.");
      if ("mfa_required" in login) {
        setChallenge(login);
        setCode("");
        setRecovery(false);
        setPhase("mfa");
        return;
      }
      const session = SessionSchema.parse(login);
      if (!authUserMatches(session.user, user.email) || !renewed(session))
        throw new Error("The returned account did not match.");
    } catch (failure) {
      if (!requests.current(request)) return;
      setPassword("");
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        const outcome = await readSession(requests, request);
        if (outcome !== "renewed" && outcome !== "stale") setUncertain(true);
        return;
      }
      fail(failure, "That password didn't work. Try again.");
      focusNext.current = passwordInput;
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }
  async function submitCode(submitted = code) {
    if (!challenge || busy || throttled) return;
    const factor = recovery
      ? submitted.trim()
      : submitted.replace(/\D/g, "").slice(0, 6);
    if (!factor || (!recovery && factor.length !== 6)) return;
    const request = requests.claim();
    if (!request) return;
    setBusy(true);
    setError("");
    setAlert("");
    setUncertain(false);
    try {
      const session = await withRequestDeadline(
        (signal) =>
          api(
            "/login/mfa",
            {
              method: "POST",
              body: JSON.stringify({
                challenge_token: challenge.challenge_token,
                ...(recovery
                  ? { recovery_code: factor }
                  : { totp_code: factor }),
              }),
              signal,
            },
            SessionSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      if (!authAuthorityUnchanged(request) || !renewed(session))
        throw new Error("The returned account did not match.");
    } catch (failure) {
      if (!requests.current(request)) return;
      setCode("");
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        const outcome = await readSession(requests, request);
        if (outcome !== "renewed" && outcome !== "stale") setUncertain(true);
        return;
      }
      fail(
        failure,
        recovery
          ? "That recovery code didn't work. Try another unused code."
          : "That code didn't work. Enter the current code from your app.",
      );
      focusNext.current = codeInput;
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }
  function someoneElse() {
    // Leaving discards this page's unsaved work, so ask the page first.
    if (
      !window.dispatchEvent(
        new Event("vectory:before-navigate", { cancelable: true }),
      )
    )
      return;
    rememberSignInEmail("");
    onSignInAgain();
  }

  const initials = (user.name.trim() || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();
  if (signingOut) return null;
  return (
    <>
      {!open && (
        <div className="session-paused" role="status">
          <span>You're signed out. Your work is still here.</span>
          <Button
            ref={reopen}
            variant="secondary compact"
            onClick={() => setOpen(true)}
          >
            Sign in
          </Button>
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={headline}
        description={explanation}
        className="session-renewal"
        returnFocusRef={reopen}
      >
        <div className="modal-body">
          <div className="signin-identity">
            <span aria-hidden="true">{initials}</span>
            <div>
              <strong>{user.name || user.email}</strong>
              <small>{user.email}</small>
            </div>
          </div>
          <p className="signin-notice success" role="note">
            <Check size={16} aria-hidden="true" />
            <span>Your unsaved work on this page is still here.</span>
          </p>
          {other && (
            <p className="signin-notice">
              This browser is now signed in as {other} in another tab. Sign in
              as {user.email} here to keep this work, or choose Sign in as
              someone else.
            </p>
          )}
          {alert && (
            <div className="signin-alert" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>
                {alert}
                {throttled && (
                  <>
                    {" "}
                    Try again in{" "}
                    <span className="signin-countdown">
                      {formatCountdown(throttle ?? 0)}
                    </span>
                    .
                  </>
                )}
              </span>
            </div>
          )}
          {uncertain && (
            <Unconfirmed>
              <p>
                We couldn't confirm your sign-in.{" "}
                {phase === "mfa"
                  ? "Enter the current code to try again."
                  : "Enter your password to try again."}
              </p>
            </Unconfirmed>
          )}
          {phase === "checking" ? (
            <div className="signin-loading" role="status">
              <Spinner />
              Checking your session…
            </div>
          ) : phase === "password" ? (
            <form onSubmit={submitPassword} noValidate>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={user.email}
                readOnly
                hidden
              />
              <fieldset disabled={busy}>
                <PasswordField
                  label="Password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  inputRef={passwordInput}
                  error={error}
                  labelAction={
                    <a
                      className="auth-field-link"
                      href="/#/reset"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Forgot password?
                    </a>
                  }
                />
                <div className="session-renewal-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={someoneElse}
                  >
                    Sign in as someone else
                  </button>
                  <Button type="submit" busy={busy} disabled={throttled}>
                    Sign in
                  </Button>
                </div>
              </fieldset>
            </form>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitCode();
              }}
              noValidate
            >
              <fieldset disabled={busy || throttled}>
                {recovery ? (
                  <AuthField label="Recovery code" error={error}>
                    {({ id, describedBy, invalid }) => (
                      <input
                        ref={codeInput}
                        id={id}
                        name="recovery-code"
                        className="auth-mono"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={code}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        onChange={(event) => setCode(event.target.value)}
                      />
                    )}
                  </AuthField>
                ) : (
                  <OtpInput
                    label="Authenticator code"
                    value={code}
                    onChange={setCode}
                    onComplete={(complete) => void submitCode(complete)}
                    inputRef={codeInput}
                    error={error}
                    disabled={busy || throttled}
                  />
                )}
                <div className="session-renewal-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      setRecovery(!recovery);
                      setCode("");
                      setError("");
                      requestAnimationFrame(() => codeInput.current?.focus());
                    }}
                  >
                    {recovery
                      ? "Use your authenticator app"
                      : "Use a recovery code"}
                  </button>
                  <Button type="submit" busy={busy}>
                    Verify
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
        </div>
      </Modal>
    </>
  );
}
