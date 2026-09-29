import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  APIError,
  api,
  getCSRFVersion,
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
  isDefinitiveAuthRejection,
  isMissingSession,
  useAuthRequest,
} from "./authRequests";
import { Button, ErrorBox, Field } from "./ui";
import { Brand } from "./App";
import { PasswordReset } from "./AccountAccess";
export default function Auth({
  initialized,
  error: connectionError,
  onAuthenticated,
  onSetupDetected,
  retry,
}: {
  initialized: boolean | null;
  error: string;
  onAuthenticated: (u: User) => void;
  onSetupDetected: () => void;
  retry: () => void;
}) {
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [secret, setSecret] = useState(""),
    [totp, setTotp] = useState(""),
    [recovery, setRecovery] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [reset, setReset] = useState(false),
    [message, setMessage] = useState("");
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const requests = useAuthRequest();
  const [unknown, setUnknown] = useState<{
    kind: "login" | "mfa" | "setup";
    email: string;
  } | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [setupFound, setSetupFound] = useState(false);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (unknown) recoveryHeading.current?.focus();
  }, [unknown]);
  const codeInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [returnToPassword, setReturnToPassword] = useState(false);
  useEffect(() => {
    if (busy) return;
    if (challenge) codeInput.current?.focus();
    else if (returnToPassword) {
      passwordInput.current?.focus();
      setReturnToPassword(false);
    }
  }, [challenge, recovery, busy, returnToPassword]);
  function backToSignIn(notice = "") {
    setChallenge(null);
    setPassword("");
    setTotp("");
    setRecovery(false);
    setError("");
    setMessage(notice);
    setReturnToPassword(true);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (initialized === null || connectionError || unknown) return;
    const request = requests.claim();
    if (!request) return;
    const kind = challenge ? "mfa" : initialized ? "login" : "setup";
    const submittedEmail = email;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const path = challenge
        ? "/login/mfa"
        : initialized
          ? "/login"
          : "/bootstrap";
      const body = challenge
        ? {
            challenge_token: challenge.challenge_token,
            ...(recovery
              ? { recovery_code: totp.trim() }
              : { totp_code: totp.trim() }),
          }
        : {
            name,
            email,
            password,
            ...(!initialized ? { bootstrap_secret: secret } : {}),
          };
      const login = await withRequestDeadline(
        (signal) =>
          api(
            path,
            { method: "POST", body: JSON.stringify(body), signal },
            kind === "login" ? LoginSchema : SessionSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      if (!authAuthorityUnchanged(request))
        throw new Error("The browser's sign-in state changed while waiting.");
      if ("mfa_required" in login) {
        setPassword("");
        setTotp("");
        setRecovery(false);
        setChallenge(login);
        return;
      }
      const parsed = SessionSchema.parse(login);
      if (!authUserMatches(parsed.user, submittedEmail))
        throw new Error("The returned account did not match this sign-in.");
      setCSRF(parsed.csrf_token);
      setPassword("");
      setSecret("");
      setTotp("");
      setChallenge(null);
      onAuthenticated(parsed.user);
    } catch (e) {
      if (!requests.current(request)) return;
      if (!isDefinitiveAuthRejection(e) || !authAuthorityUnchanged(request)) {
        setPassword("");
        setSecret("");
        setTotp("");
        setChallenge(null);
        setRecovery(false);
        setRecoveryChecked(false);
        setSetupFound(false);
        setUnknown({ kind, email: submittedEmail });
        return;
      }
      if (
        challenge &&
        e instanceof APIError &&
        e.code === "MFA_CHALLENGE_EXPIRED"
      ) {
        backToSignIn(
          "This verification has expired. Sign in again to get a new one.",
        );
        return;
      }
      if (challenge && e instanceof APIError && e.code === "INVALID_MFA_CODE")
        setTotp("");
      setError(
        initialized && e instanceof APIError && e.code === "UNAUTHENTICATED"
          ? "Check your email and password."
          : challenge && e instanceof APIError && e.code === "INVALID_MFA_CODE"
            ? recovery
              ? "That recovery code is invalid or has already been used. Try an unused code."
              : "That code is invalid or has already been used. Enter a new code from your authenticator app."
            : (e as Error).message,
      );
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }
  async function checkSignIn() {
    if (!unknown) return;
    const request = requests.claim();
    if (!request) return;
    setBusy(true);
    setError("");
    setMessage("");
    setRecoveryChecked(false);
    try {
      const result = await withRequestDeadline(
        async (signal) => {
          try {
            return {
              session: await api("/session", { signal }, SessionSchema),
            };
          } catch (failure) {
            if (!isMissingSession(failure)) throw failure;
            // A 401 is a current cookie snapshot, not proof the earlier POST failed.
            if (unknown.kind === "setup") {
              const status = await api<{ initialized: boolean }>("/status", {
                signal,
              });
              return { initialized: status.initialized };
            }
            return { initialized: true };
          }
        },
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      if (result.session) {
        if (!authAuthorityUnchanged(request))
          throw new Error(
            "Sign-in state changed. Check again to read the current session.",
          );
        if (!authUserMatches(result.session.user, unknown.email)) {
          setMessage(
            result.session.user.enabled
              ? `This browser is signed in as ${result.session.user.email}, not ${unknown.email}. Start a new sign-in to choose your account.`
              : "This account is disabled. Ask an administrator to restore access.",
          );
          setSetupFound(unknown.kind === "setup");
          setRecoveryChecked(true);
          return;
        }
        setCSRF(result.session.csrf_token);
        onAuthenticated(result.session.user);
        return;
      }
      if (request.csrfVersion !== getCSRFVersion())
        throw new Error(
          "Sign-in state changed. Check again to read the current session.",
        );
      setRecoveryChecked(true);
      setSetupFound(unknown.kind === "setup" && result.initialized);
      setMessage(
        unknown.kind === "setup"
          ? result.initialized
            ? "This instance is set up. Sign in with your account to continue."
            : "No completed setup is visible yet. The earlier request may still finish. Check again before starting another setup."
          : "No active sign-in was found. The earlier request may still finish. Start a new sign-in with your password; use a fresh authenticator code or an unused recovery code if asked.",
      );
    } catch (failure) {
      if (requests.current(request))
        setError(
          `Could not check sign-in status. ${(failure as Error).message}`,
        );
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }
  if (reset && initialized)
    return (
      <main className="auth-page">
        <div className="auth-card">
          <Brand />
          <PasswordReset
            onBack={(text) => {
              setReset(false);
              setError("");
              setMessage(text || "");
            }}
          />
        </div>
      </main>
    );
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1 ref={recoveryHeading} tabIndex={unknown ? -1 : undefined}>
          {unknown
            ? unknown.kind === "setup"
              ? "Setup result unknown"
              : "Sign-in result unknown"
            : challenge
              ? "Verify your identity"
              : initialized === false
                ? "Set up Vectory"
                : "Sign in"}
        </h1>
        <p>
          {unknown
            ? "The server did not return a complete result. Check the current status before trying again."
            : challenge
              ? recovery
                ? `Enter an unused recovery code to finish signing in as ${email}.`
                : `Enter the code from your authenticator app to finish signing in as ${email}.`
              : initialized === false
                ? "Create the administrator account for this instance."
                : "Use your Vectory account to continue."}
        </p>
        {connectionError && (
          <ErrorBox message={connectionError} retry={retry} />
        )}
        {message && (
          <p className="account-notice" role="status">
            {message}
          </p>
        )}
        {unknown ? (
          <section className="auth-recovery" aria-label="Sign-in recovery">
            <p>
              {unknown.kind === "setup"
                ? "Your account may have been created. Checking status will not submit setup again."
                : unknown.kind === "mfa"
                  ? "You may already be signed in, and your verification code may have been used. Checking status will not submit it again."
                  : "You may already be signed in. Checking status will not send your password again."}
            </p>
            {error && <ErrorBox message={error} />}
            <Button
              busy={busy}
              className="full-width"
              onClick={() => void checkSignIn()}
            >
              {unknown.kind === "setup"
                ? "Check setup status"
                : "Check sign-in status"}
            </Button>
            {recoveryChecked && (
              <Button
                variant="ghost"
                className="full-width"
                disabled={busy}
                onClick={() => {
                  if (setupFound) onSetupDetected();
                  setUnknown(null);
                  setRecoveryChecked(false);
                  backToSignIn(
                    setupFound
                      ? "This instance is set up. Sign in with your account."
                      : "",
                  );
                }}
              >
                {unknown.kind === "setup"
                  ? setupFound
                    ? "Go to sign in"
                    : "Return to setup"
                  : "Start a new sign-in"}
              </Button>
            )}
          </section>
        ) : (
          <form onSubmit={submit}>
            {error && <ErrorBox message={error} />}
            <fieldset
              disabled={initialized === null || !!connectionError || busy}
            >
              {challenge ? (
                <>
                  <Field
                    label={recovery ? "Recovery code" : "Authenticator code"}
                  >
                    <input
                      key={recovery ? "recovery" : "authenticator"}
                      ref={codeInput}
                      required
                      type="text"
                      inputMode={recovery ? "text" : "numeric"}
                      autoComplete="one-time-code"
                      autoCapitalize="none"
                      spellCheck={false}
                      pattern={recovery ? undefined : "[0-9]{6}"}
                      maxLength={recovery ? 80 : 6}
                      value={totp}
                      onChange={(e) => setTotp(e.target.value)}
                    />
                  </Field>
                  <button
                    type="button"
                    className="text-link auth-method"
                    onClick={() => {
                      setRecovery(!recovery);
                      setTotp("");
                      setError("");
                    }}
                  >
                    {recovery
                      ? "Use an authenticator code"
                      : "Use a recovery code instead"}
                  </button>
                </>
              ) : (
                <>
                  {initialized === false && (
                    <>
                      <Field
                        label="Setup secret"
                        hint="The one-time secret provisioned on your server."
                      >
                        <input
                          required
                          type="password"
                          autoComplete="off"
                          value={secret}
                          onChange={(e) => setSecret(e.target.value)}
                        />
                      </Field>
                      <Field label="Your name">
                        <input
                          required
                          autoComplete="name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  <Field label="Email address">
                    <input
                      required
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Password"
                    hint={
                      initialized === false
                        ? "At least 12 characters."
                        : undefined
                    }
                  >
                    <input
                      ref={passwordInput}
                      required
                      type="password"
                      minLength={initialized === false ? 12 : undefined}
                      autoComplete={
                        initialized === false
                          ? "new-password"
                          : "current-password"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                </>
              )}
              <Button
                type="submit"
                busy={busy}
                className="full-width auth-submit"
              >
                {challenge
                  ? "Verify and sign in"
                  : initialized === false
                    ? "Create account"
                    : "Sign in"}
              </Button>
            </fieldset>
          </form>
        )}
        {!unknown &&
          (challenge ? (
            <Button
              variant="ghost"
              className="auth-reset-link"
              disabled={busy}
              onClick={() => backToSignIn()}
            >
              Back to sign in
            </Button>
          ) : (
            initialized && (
              <Button
                variant="ghost"
                className="auth-reset-link"
                disabled={busy}
                onClick={() => {
                  setPassword("");
                  setTotp("");
                  setReset(true);
                }}
              >
                Reset password
              </Button>
            )
          ))}
        <a
          className="auth-help"
          href="/help/getting-started/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Vectory documentation <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </main>
  );
}
