import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CircleCheck,
  ExternalLink,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { z } from "zod";
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
  isMissingSession,
  isUncertainOutcome,
  retryDelay,
  useAuthRequest,
  type AuthRequest,
} from "./authRequests";
import {
  AuthField,
  OtpInput,
  PasswordField,
  CopyLine,
  Unconfirmed,
  formatCountdown,
  useCountdown,
} from "./authControls";
import { passwordIssue } from "./passwordStrength";
import { Button, Spinner } from "./ui";
import { Brand } from "./App";

const SetupHintSchema = z.object({
  source: z.enum(["file", "environment", "unknown"]),
  variable: z.string().nullable(),
  container: z.boolean(),
  path: z.string().nullable(),
});
type SetupHint = z.infer<typeof SetupHintSchema>;
const StatusSchema = z.object({
  initialized: z.boolean(),
  version: z.string(),
  instance_name: z.string().optional(),
  setup_hint: SetupHintSchema.optional(),
});
const InvitePreviewSchema = z.object({
  email: z.string(),
  name: z.string(),
  expires_at: z.string(),
  instance_name: z.string().optional(),
});
const ResetReceiptSchema = z.object({
  ok: z.literal(true),
  email: z.string().optional(),
});

type Notice = { tone: "info" | "success"; text: string };
type Fields = Partial<
  Record<
    "email" | "password" | "confirm" | "secret" | "name" | "code" | "otp",
    string
  >
>;
type View =
  | { kind: "signin" }
  | { kind: "mfa"; challenge: LoginChallenge; email: string }
  | { kind: "setup" }
  | { kind: "setup-done"; user: User }
  | { kind: "reset"; code: string }
  | { kind: "reset-done"; email: string }
  | { kind: "invite"; code: string }
  | { kind: "welcome"; user: User };

/** The auth routes live in the fragment, so codes never reach server logs. */
function linkRoute(): { kind: "reset" | "invite"; code: string } | null {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  if (path !== "reset" && path !== "invite") return null;
  const code = (new URLSearchParams(query).get("code") || "").trim();
  return { kind: path, code };
}
function initialView(initialized: boolean | null): View {
  if (initialized === false) return { kind: "setup" };
  const route = linkRoute();
  if (route?.kind === "reset") return { kind: "reset", code: route.code };
  if (route?.kind === "invite") return { kind: "invite", code: route.code };
  return { kind: "signin" };
}
function initials(value: string) {
  return (
    value
      .trim()
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toLocaleUpperCase() || "?"
  );
}
/** "sudo cat /srv/vectory/bootstrap" for the setup screen. Never the value. */
export function setupCommand(hint: SetupHint | undefined) {
  if (!hint || hint.source !== "file" || !hint.path) return null;
  if (hint.container)
    return {
      where: "From your deploy folder, run:",
      command: `docker compose exec server cat ${hint.path}`,
    };
  if (/^[A-Za-z]:\\/.test(hint.path))
    return {
      where: "On the server, run:",
      command: `Get-Content "${hint.path}"`,
    };
  return {
    where: "On the server, run:",
    command: `sudo cat ${hint.path}`,
  };
}

export default function AuthScreen({
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
  const [view, setView] = useState<View>(() => initialView(initialized));
  const [status, setStatus] = useState<z.infer<typeof StatusSchema> | null>(
    null,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [codeFailures, setCodeFailures] = useState(0);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [fields, setFields] = useState<Fields>({});
  const [alert, setAlert] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<ReactNode>(null);
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);
  const [invite, setInvite] = useState<
    z.infer<typeof InvitePreviewSchema> | "invalid" | null
  >(null);
  const requests = useAuthRequest();
  const destination = useRef(
    linkRoute() ? "#/overview" : location.hash || "#/overview",
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  // Focus after a failed request waits until the form is enabled again.
  const focusNext = useRef<React.RefObject<HTMLInputElement | null> | null>(
    null,
  );
  const throttle = useCountdown(throttledUntil);
  const throttled = throttle !== null && throttle > 0;
  const instance = status?.instance_name?.trim() || "Vectory";

  useEffect(() => {
    const controller = new AbortController();
    void withRequestDeadline(
      (signal) => api("/status", { signal }, StatusSchema),
      30000,
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setStatus(next);
      })
      .catch(() => {
        /* The name, version and setup hint are conveniences. */
      });
    return () => controller.abort();
  }, [initialized]);
  useEffect(() => {
    if (initialized === false) setView({ kind: "setup" });
    else if (initialized === true && view.kind === "setup")
      setView({ kind: "signin" });
  }, [initialized]);
  useEffect(() => {
    const changed = () => {
      const route = linkRoute();
      if (!route || initialized === false) return;
      clearMessages();
      setView(
        route.kind === "reset"
          ? { kind: "reset", code: route.code }
          : { kind: "invite", code: route.code },
      );
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [initialized]);
  useEffect(() => {
    document.title = {
      signin: `Sign in · ${instance}`,
      mfa: `Two-factor authentication · ${instance}`,
      setup: "Set up Vectory",
      "setup-done": "Vectory is ready",
      reset: `Reset password · ${instance}`,
      "reset-done": `Password updated · ${instance}`,
      invite: `Join ${instance}`,
      welcome: `Welcome · ${instance}`,
    }[view.kind];
  }, [view.kind, instance]);
  useEffect(() => {
    if (busy || checking || !focusNext.current) return;
    const target = focusNext.current;
    focusNext.current = null;
    requestAnimationFrame(() => target.current?.focus());
  }, [busy, checking]);
  useEffect(() => {
    if (throttle === 0) {
      setThrottledUntil(null);
      setAlert("");
    }
  }, [throttle]);
  // Invitation preview: who it is for, before anyone chooses a password.
  useEffect(() => {
    if (view.kind !== "invite") return;
    setInvite(null);
    if (!/^[a-fA-F0-9]{64}$/.test(view.code)) {
      setInvite("invalid");
      return;
    }
    const controller = new AbortController();
    void withRequestDeadline(
      (signal) =>
        api(
          "/invite/preview",
          {
            method: "POST",
            body: JSON.stringify({ code: view.code }),
            signal,
          },
          InvitePreviewSchema,
        ),
      30000,
      controller.signal,
    )
      .then((preview) => {
        if (controller.signal.aborted) return;
        setInvite(preview);
        setEmail(preview.email);
        setName(preview.name);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof APIError && failure.code === "INVITE_INVALID")
          setInvite("invalid");
        else
          setAlert(
            "We couldn't open this invite. Check your connection and reload the page.",
          );
      });
    return () => controller.abort();
  }, [view.kind === "invite" ? view.code : null]);
  useEffect(() => {
    // Keep focus with the task after a view change.
    requestAnimationFrame(() => {
      if (view.kind === "mfa") codeInput.current?.focus();
      else if (view.kind === "setup") secretInput.current?.focus();
      else if (view.kind === "signin")
        (email ? passwordInput : emailInput).current?.focus();
      else heading.current?.focus();
    });
  }, [view.kind]);

  function clearMessages() {
    setFields({});
    setAlert("");
    setUnconfirmed(null);
  }
  function toSignIn(next?: Notice, signInEmail?: string) {
    if (signInEmail !== undefined) setEmail(signInEmail);
    setPassword("");
    setConfirm("");
    setCode("");
    setRecovery(false);
    setCodeFailures(0);
    clearMessages();
    setNotice(next || null);
    if (linkRoute()) location.hash = destination.current.replace(/^#/, "");
    setView({ kind: "signin" });
    requestAnimationFrame(() =>
      (signInEmail || email ? passwordInput : emailInput).current?.focus(),
    );
  }
  function adopt(session: z.infer<typeof SessionSchema>) {
    setCSRF(session.csrf_token);
    setPassword("");
    setConfirm("");
    setSecret("");
    setCode("");
    onAuthenticated(session.user);
  }
  function go(path: string, user: User) {
    location.hash = "/" + path;
    onAuthenticated(user);
  }
  function applyThrottle(failure: unknown, message: string) {
    const wait = retryDelay(failure);
    if (!wait) return false;
    setThrottledUntil(Date.now() + wait * 1000);
    setAlert(message);
    return true;
  }
  /**
   * After a lost or unreadable response, read the current session (and for
   * setup, the instance status) once. Reads never resend credentials.
   */
  async function resolveUncertain(
    kind: "login" | "mfa" | "setup" | "invite",
    intended: string,
    request: AuthRequest,
  ): Promise<"adopted" | "initialized" | "absent" | "unknown"> {
    setChecking(true);
    try {
      const result = await withRequestDeadline(
        async (signal) => {
          try {
            return {
              session: await api("/session", { signal }, SessionSchema),
            };
          } catch (failure) {
            if (!isMissingSession(failure)) throw failure;
            if (kind !== "setup") return {};
            const current = await api("/status", { signal }, StatusSchema);
            return { initialized: current.initialized };
          }
        },
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return "unknown";
      if (result.session) {
        if (
          authAuthorityUnchanged(request) &&
          authUserMatches(result.session.user, intended)
        ) {
          if (kind === "setup") {
            setCSRF(result.session.csrf_token);
            setView({ kind: "setup-done", user: result.session.user });
          } else if (kind === "invite") {
            setCSRF(result.session.csrf_token);
            setView({ kind: "welcome", user: result.session.user });
          } else adopt(result.session);
          return "adopted";
        }
        setAlert(
          `This browser is signed in as ${result.session.user.email}. Reload the page to continue as them, or sign in again.`,
        );
        return "unknown";
      }
      return result.initialized ? "initialized" : "absent";
    } catch {
      return "unknown";
    } finally {
      if (requests.current(request)) setChecking(false);
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (initialized === null || connectionError || throttled) return;
    const intended = email.trim();
    if (!intended.includes("@")) {
      setFields({ email: "Enter the email address for your account." });
      emailInput.current?.focus();
      return;
    }
    const request = requests.claim();
    if (!request) return;
    setBusy(true);
    clearMessages();
    setNotice(null);
    const submitted = password;
    try {
      const login = await withRequestDeadline(
        (signal) =>
          api(
            "/login",
            {
              method: "POST",
              body: JSON.stringify({ email: intended, password: submitted }),
              signal,
            },
            LoginSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      if (!authAuthorityUnchanged(request))
        throw new Error("The browser's sign-in state changed while waiting.");
      setPassword("");
      if ("mfa_required" in login) {
        setCode("");
        setRecovery(false);
        setCodeFailures(0);
        setView({ kind: "mfa", challenge: login, email: intended });
        return;
      }
      const session = SessionSchema.parse(login);
      if (!authUserMatches(session.user, intended))
        throw new Error("The returned account did not match this sign-in.");
      adopt(session);
    } catch (failure) {
      if (!requests.current(request)) return;
      setPassword("");
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        const outcome = await resolveUncertain("login", intended, request);
        if (outcome !== "adopted" && requests.current(request))
          setUnconfirmed(
            <Unconfirmed>
              <p>
                We couldn't confirm your sign-in. Enter your password to try
                again.
              </p>
            </Unconfirmed>,
          );
        return;
      }
      const code = failure instanceof APIError ? failure.code : "";
      if (code === "UNAUTHENTICATED")
        setAlert("That email and password don't match. Try again.");
      else if (code === "EMAIL_INVALID")
        setFields({ email: "Enter a valid email address." });
      else if (
        !applyThrottle(
          failure,
          code === "SIGNIN_THROTTLED"
            ? "Too many failed attempts for this account."
            : "Too many sign-in attempts.",
        )
      )
        setAlert((failure as Error).message);
      focusNext.current = passwordInput;
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }

  async function verify(submitted = code) {
    if (view.kind !== "mfa" || busy || throttled) return;
    const factor = recovery
      ? submitted.trim()
      : submitted.replace(/\D/g, "").slice(0, 6);
    if (!recovery && factor.length !== 6) {
      setFields({ otp: "Enter the 6-digit code from your app." });
      return;
    }
    if (recovery && !factor) return;
    const request = requests.claim();
    if (!request) return;
    const { challenge, email: intended } = view;
    setBusy(true);
    clearMessages();
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
      if (!authAuthorityUnchanged(request))
        throw new Error("The browser's sign-in state changed while waiting.");
      if (!authUserMatches(session.user, intended))
        throw new Error("The returned account did not match this sign-in.");
      adopt(session);
    } catch (failure) {
      if (!requests.current(request)) return;
      setCode("");
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        const outcome = await resolveUncertain("mfa", intended, request);
        if (outcome !== "adopted" && requests.current(request))
          setUnconfirmed(
            <Unconfirmed>
              <p>
                We couldn't confirm that code.{" "}
                {recovery
                  ? "Try another unused recovery code."
                  : "Enter the current code from your app to try again."}
              </p>
            </Unconfirmed>,
          );
        return;
      }
      const failed = failure instanceof APIError ? failure.code : "";
      if (failed === "MFA_TOO_MANY_ATTEMPTS")
        toSignIn({
          tone: "info",
          text: "Too many incorrect codes. For your security, sign in with your password again.",
        });
      else if (failed === "MFA_CHALLENGE_EXPIRED")
        toSignIn({
          tone: "info",
          text: "That verification timed out. Sign in again to continue.",
        });
      else if (failed === "INVALID_MFA_CODE") {
        setCodeFailures((count) => count + 1);
        setFields({
          otp: recovery
            ? "That recovery code didn't work. Check it, or try another unused code."
            : "That code didn't work. Enter the current code from your app.",
        });
      } else if (!applyThrottle(failure, "Too many attempts for this account."))
        setAlert((failure as Error).message);
      focusNext.current = codeInput;
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }

  async function setUp(event: React.FormEvent) {
    event.preventDefault();
    if (initialized !== false || connectionError) return;
    const intended = email.trim();
    const problems: Fields = {};
    if (!secret.trim())
      problems.secret = "Paste the setup secret from your server.";
    if (!name.trim()) problems.name = "Enter your name.";
    if (!intended.includes("@"))
      problems.email = "Enter a valid email address.";
    const weak = passwordIssue(password, [intended, name]);
    if (weak) problems.password = weak;
    else if (password !== confirm)
      problems.confirm = "The passwords don't match.";
    if (Object.keys(problems).length) {
      setFields(problems);
      return;
    }
    const request = requests.claim();
    if (!request) return;
    setBusy(true);
    clearMessages();
    try {
      const session = await withRequestDeadline(
        (signal) =>
          api(
            "/bootstrap",
            {
              method: "POST",
              body: JSON.stringify({
                bootstrap_secret: secret.trim(),
                name: name.trim(),
                email: intended,
                password,
              }),
              signal,
            },
            SessionSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      if (
        !authAuthorityUnchanged(request) ||
        !authUserMatches(session.user, intended)
      )
        throw new Error("The returned account did not match this setup.");
      setCSRF(session.csrf_token);
      setSecret("");
      setPassword("");
      setConfirm("");
      setView({ kind: "setup-done", user: session.user });
    } catch (failure) {
      if (!requests.current(request)) return;
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        setSecret("");
        setPassword("");
        setConfirm("");
        const outcome = await resolveUncertain("setup", intended, request);
        if (!requests.current(request) || outcome === "adopted") return;
        if (outcome === "initialized") {
          onSetupDetected();
          toSignIn(
            {
              tone: "info",
              text: "Vectory is set up. Sign in with the account you just created.",
            },
            intended,
          );
        } else
          setUnconfirmed(
            <Unconfirmed>
              <p>
                {outcome === "absent"
                  ? "Setup didn't finish. Paste the setup secret and choose your password again."
                  : "We couldn't reach Vectory to check. Paste the setup secret and choose your password again to retry."}
              </p>
            </Unconfirmed>,
          );
        return;
      }
      const failed = failure instanceof APIError ? failure.code : "";
      const message = (failure as Error).message;
      if (failed === "ALREADY_INITIALIZED") {
        onSetupDetected();
        toSignIn(
          { tone: "info", text: "This workspace is already set up. Sign in." },
          intended,
        );
      } else if (failed === "SETUP_SECRET_INVALID") {
        setFields({
          secret:
            "That setup secret doesn't match this server's. Copy it again and check for extra characters.",
        });
        secretInput.current?.focus();
      } else if (failed === "PASSWORD_TOO_WEAK")
        setFields({ password: message });
      else if (failed === "EMAIL_INVALID")
        setFields({ email: "Enter a valid email address." });
      else if (failed === "NAME_INVALID") setFields({ name: message });
      else if (!applyThrottle(failure, "Too many setup attempts."))
        setAlert(message);
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }

  async function resetPassword(event: React.FormEvent) {
    event.preventDefault();
    if (view.kind !== "reset") return;
    const resetCode = (view.code || code).trim().toLowerCase();
    const problems: Fields = {};
    if (!/^[a-f0-9]{64}$/.test(resetCode))
      problems.code =
        "Paste the full reset code from your administrator (64 characters).";
    const weak = passwordIssue(password);
    if (weak) problems.password = weak;
    else if (password !== confirm)
      problems.confirm = "The passwords don't match.";
    if (Object.keys(problems).length) {
      setFields(problems);
      return;
    }
    const request = requests.claim();
    if (!request) return;
    setBusy(true);
    clearMessages();
    try {
      const receipt = await withRequestDeadline(
        (signal) =>
          api(
            "/password-reset",
            {
              method: "POST",
              body: JSON.stringify({ code: resetCode, new_password: password }),
              signal,
            },
            ResetReceiptSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      setPassword("");
      setConfirm("");
      setCode("");
      if (receipt.email) setEmail(receipt.email);
      setView({ kind: "reset-done", email: receipt.email || "" });
    } catch (failure) {
      if (!requests.current(request)) return;
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        // There is no reset status to read. The new password may be saved.
        setPassword("");
        setConfirm("");
        toSignIn({
          tone: "info",
          text: "We couldn't confirm your new password was saved. Try signing in with it. If that doesn't work, ask your administrator for a new reset code.",
        });
        return;
      }
      const failed = failure instanceof APIError ? failure.code : "";
      if (failed === "RESET_CODE_INVALID")
        setFields({
          code: "This reset code is invalid, expired or already used. Ask your administrator for a new one.",
        });
      else if (failed === "PASSWORD_TOO_WEAK")
        setFields({ password: (failure as Error).message });
      else if (!applyThrottle(failure, "Too many reset attempts."))
        setAlert((failure as Error).message);
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }

  async function acceptInvite(event: React.FormEvent) {
    event.preventDefault();
    if (view.kind !== "invite" || !invite || invite === "invalid") return;
    const weak = passwordIssue(password, [invite.email, invite.name]);
    if (weak) {
      setFields({ password: weak });
      return;
    }
    if (password !== confirm) {
      setFields({ confirm: "The passwords don't match." });
      return;
    }
    const request = requests.claim();
    if (!request) return;
    setBusy(true);
    clearMessages();
    try {
      const session = await withRequestDeadline(
        (signal) =>
          api(
            "/invite/accept",
            {
              method: "POST",
              body: JSON.stringify({ code: view.code, new_password: password }),
              signal,
            },
            SessionSchema,
          ),
        30000,
        request.controller.signal,
      );
      if (!requests.current(request)) return;
      if (
        !authAuthorityUnchanged(request) ||
        !authUserMatches(session.user, invite.email)
      )
        throw new Error("The returned account did not match this invite.");
      setCSRF(session.csrf_token);
      setPassword("");
      setConfirm("");
      setView({ kind: "welcome", user: session.user });
    } catch (failure) {
      if (!requests.current(request)) return;
      if (isUncertainOutcome(failure) || !authAuthorityUnchanged(request)) {
        setPassword("");
        setConfirm("");
        const outcome = await resolveUncertain("invite", invite.email, request);
        if (outcome !== "adopted" && requests.current(request))
          toSignIn(
            {
              tone: "info",
              text: "We couldn't confirm your account was set up. Try signing in with the password you chose. If that doesn't work, ask for a new invite.",
            },
            invite.email,
          );
        return;
      }
      const failed = failure instanceof APIError ? failure.code : "";
      if (failed === "INVITE_INVALID") setInvite("invalid");
      else if (failed === "PASSWORD_TOO_WEAK")
        setFields({ password: (failure as Error).message });
      else if (!applyThrottle(failure, "Too many attempts."))
        setAlert((failure as Error).message);
    } finally {
      if (requests.finish(request)) setBusy(false);
    }
  }

  const disabled =
    busy || checking || initialized === null || !!connectionError;
  const alertBox = (alert || connectionError) && (
    <div className="signin-alert" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <span>
        {connectionError || alert}
        {throttled && (
          <>
            {" "}
            Try again in{" "}
            <span className="signin-countdown">
              {formatCountdown(throttle ?? 0)}
            </span>
            {view.kind === "signin" &&
              ", or ask an administrator for a password reset"}
            .
          </>
        )}
      </span>
      {connectionError && (
        <Button variant="secondary compact" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
  const noticeBox = notice && (
    <p className={`signin-notice ${notice.tone}`} role="status">
      {notice.tone === "success" ? (
        <CircleCheck size={16} aria-hidden="true" />
      ) : null}
      <span>{notice.text}</span>
    </p>
  );
  const helpPath =
    view.kind === "setup" || view.kind === "setup-done"
      ? "/help/administer/#start-a-new-server"
      : "/help/getting-started/";
  const footer = (
    <footer className="signin-footer">
      <span>{status ? `Vectory ${status.version}` : "Vectory"}</span>
      <a href={helpPath} target="_blank" rel="noopener noreferrer">
        Help
        <ExternalLink size={13} aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </footer>
  );
  const shell = (content: ReactNode, wide = false) => (
    <main className="signin">
      <div className={`signin-card ${wide ? "wide" : ""}`}>
        <Brand />
        {content}
        {footer}
      </div>
    </main>
  );
  const title = (text: string) => (
    <h1 ref={heading} tabIndex={-1}>
      {text}
    </h1>
  );

  if (view.kind === "setup-done" || view.kind === "welcome") {
    const user = view.user;
    const setup = view.kind === "setup-done";
    return shell(
      <>
        <div className="setup-done-mark" aria-hidden="true">
          <Check size={22} />
        </div>
        {title(
          setup
            ? "Vectory is ready"
            : `Welcome, ${user.name.split(/\s+/)[0] || user.name}`,
        )}
        <p className="signin-lede">
          {setup
            ? "You're signed in as the first administrator. Three quick steps secure your workspace:"
            : `Your account is ready. You're signed in as ${user.email}.`}
        </p>
        <ol className="checklist">
          <li>
            <span className="checklist-mark" aria-hidden="true">
              {setup ? "1" : <ShieldCheck size={14} />}
            </span>
            <span className="checklist-copy">
              <strong>Turn on two-factor authentication</strong>
              <span>
                {setup
                  ? "Protect the administrator account with an authenticator app."
                  : "Add an authenticator app so a password alone can't open your account."}
              </span>
            </span>
            <Button
              variant="secondary compact"
              onClick={() => go("users?setup=two-factor", user)}
            >
              Set up
            </Button>
          </li>
          {setup && (
            <>
              <li>
                <span className="checklist-mark" aria-hidden="true">
                  2
                </span>
                <span className="checklist-copy">
                  <strong>Invite a teammate</strong>
                  <span>
                    Send a single-use link. They choose their own password.
                  </span>
                </span>
                <Button
                  variant="secondary compact"
                  onClick={() => go("users?add=person", user)}
                >
                  Invite
                </Button>
              </li>
              <li>
                <span className="checklist-mark" aria-hidden="true">
                  3
                </span>
                <span className="checklist-copy">
                  <strong>Add your first device</strong>
                  <span>Install the agent on a machine that runs Vector.</span>
                </span>
                <Button
                  variant="secondary compact"
                  onClick={() => go("enrollment", user)}
                >
                  Add device
                </Button>
              </li>
            </>
          )}
        </ol>
        <Button className="signin-submit" onClick={() => go("overview", user)}>
          {setup ? "Go to Overview" : "Continue to Vectory"}
        </Button>
      </>,
      true,
    );
  }

  if (view.kind === "reset-done")
    return shell(
      <>
        <div className="setup-done-mark" aria-hidden="true">
          <Check size={22} />
        </div>
        {title("Password updated")}
        <p className="signin-lede">
          Sign in with your new password
          {view.email ? (
            <>
              {" "}
              as <strong>{view.email}</strong>
            </>
          ) : null}
          . Other browsers were signed out.
        </p>
        <Button
          className="signin-submit"
          onClick={() => toSignIn(undefined, view.email || email)}
        >
          Sign in
        </Button>
      </>,
    );

  if (view.kind === "reset") {
    const fromLink = /^[a-fA-F0-9]{64}$/.test(view.code);
    return shell(
      <>
        {title("Reset your password")}
        <p className="signin-lede">
          {fromLink
            ? "Choose a new password for your account."
            : "Paste the reset code from your administrator, then choose a new password."}
        </p>
        {alertBox}
        <form onSubmit={resetPassword} noValidate>
          <fieldset disabled={disabled}>
            {!fromLink && (
              <AuthField label="Reset code" error={fields.code}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    name="reset-code"
                    className="auth-mono"
                    autoComplete="one-time-code"
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus
                    value={code}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\s+/g, ""))
                    }
                  />
                )}
              </AuthField>
            )}
            {fromLink && fields.code && (
              <div className="signin-alert" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{fields.code}</span>
              </div>
            )}
            <PasswordField
              label="New password"
              name="new-password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              error={fields.password}
              autoFocus={fromLink}
              showStrength
              revealed={revealed}
              onReveal={setRevealed}
            />
            <PasswordField
              label="Confirm new password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={setConfirm}
              error={fields.confirm}
              revealed={revealed}
              onReveal={setRevealed}
            />
            <Button type="submit" busy={busy} className="signin-submit">
              Save new password
            </Button>
          </fieldset>
        </form>
        <div className="signin-links">
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => toSignIn()}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back to sign in
          </button>
        </div>
      </>,
    );
  }

  if (view.kind === "invite") {
    if (invite === "invalid")
      return shell(
        <>
          {title("This invite link can't be used")}
          <p className="signin-lede">
            It has expired or was already used. Ask your administrator for a new
            invite link.
          </p>
          <Button
            variant="secondary"
            className="signin-submit"
            onClick={() => toSignIn()}
          >
            Go to sign in
          </Button>
        </>,
      );
    if (!invite)
      return shell(
        <>
          {title(`Join ${instance}`)}
          {alertBox}
          {!alert && (
            <div className="signin-loading" role="status">
              <Spinner />
              Opening your invite…
            </div>
          )}
        </>,
      );
    return shell(
      <>
        {title(`Join ${invite.instance_name?.trim() || instance}`)}
        <p className="signin-lede">
          Welcome, {invite.name.split(/\s+/)[0] || invite.name}. Choose a
          password for <strong>{invite.email}</strong>.
        </p>
        {alertBox}
        {checking && (
          <div className="signin-loading" role="status">
            <Spinner />
            Checking whether your account is ready…
          </div>
        )}
        <form onSubmit={acceptInvite} noValidate>
          <fieldset disabled={disabled}>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={invite.email}
              readOnly
              hidden
            />
            <PasswordField
              label="Password"
              name="new-password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              error={fields.password}
              autoFocus
              showStrength
              identity={[invite.email, invite.name]}
              revealed={revealed}
              onReveal={setRevealed}
            />
            <PasswordField
              label="Confirm password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={setConfirm}
              error={fields.confirm}
              revealed={revealed}
              onReveal={setRevealed}
            />
            <Button type="submit" busy={busy} className="signin-submit">
              Create my account
            </Button>
          </fieldset>
        </form>
      </>,
    );
  }

  if (view.kind === "setup") {
    const hint = status?.setup_hint;
    const command = setupCommand(hint);
    return shell(
      <>
        {title("Set up Vectory")}
        <p className="signin-lede">
          Create the first administrator account for this workspace.
        </p>
        <section className="setup-hint" aria-labelledby="setup-hint-title">
          <strong id="setup-hint-title">
            <KeyRound size={15} aria-hidden="true" />
            Find your setup secret
          </strong>
          {command ? (
            <>
              <p>
                This server reads it from the file set by{" "}
                <code>VECTORY_BOOTSTRAP_SECRET_FILE</code>. {command.where}
              </p>
              <CopyLine value={command.command} label="Command" wrap />
            </>
          ) : hint?.source === "environment" ? (
            <p>
              Use the value of <code>VECTORY_BOOTSTRAP_SECRET</code> from this
              server's environment.
            </p>
          ) : (
            <p>
              Use the secret this server was started with, from the file set by{" "}
              <code>VECTORY_BOOTSTRAP_SECRET_FILE</code>.
            </p>
          )}
          <p>It works once, to create this account.</p>
        </section>
        {alertBox}
        {unconfirmed}
        {checking && (
          <div className="signin-loading" role="status">
            <Spinner />
            Checking whether setup finished…
          </div>
        )}
        <form onSubmit={setUp} noValidate>
          <fieldset disabled={disabled}>
            <PasswordField
              label="Setup secret"
              name="setup-secret"
              autoComplete="off"
              mono
              value={secret}
              onChange={(value) => setSecret(value.replace(/[\r\n]/g, ""))}
              error={fields.secret}
              inputRef={secretInput}
              hint="Surrounding spaces and line breaks are ignored."
            />
            <div className="setup-section">Your administrator account</div>
            <AuthField label="Your name" error={fields.name}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </AuthField>
            <AuthField label="Email address" error={fields.email}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </AuthField>
            <PasswordField
              label="Password"
              name="new-password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              error={fields.password}
              showStrength
              identity={[email, name]}
              revealed={revealed}
              onReveal={setRevealed}
            />
            <PasswordField
              label="Confirm password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={setConfirm}
              error={fields.confirm}
              revealed={revealed}
              onReveal={setRevealed}
            />
            <Button type="submit" busy={busy} className="signin-submit">
              Create administrator account
            </Button>
          </fieldset>
        </form>
      </>,
      true,
    );
  }

  if (view.kind === "mfa") {
    const who = view.email;
    return shell(
      <>
        {title("Two-factor authentication")}
        <p className="signin-lede">
          {recovery
            ? "Enter one of your unused recovery codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <div className="signin-identity">
          <span aria-hidden="true">{initials(who)}</span>
          <div>
            <small>Signing in as</small>
            <strong>{who}</strong>
          </div>
        </div>
        {alertBox}
        {unconfirmed}
        {checking && (
          <div className="signin-loading" role="status">
            <Spinner />
            Checking whether you're signed in…
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
          noValidate
        >
          <fieldset disabled={disabled || throttled}>
            {recovery ? (
              <AuthField label="Recovery code" error={fields.otp}>
                {({ id, describedBy, invalid }) => (
                  <input
                    ref={codeInput}
                    id={id}
                    name="recovery-code"
                    className="auth-mono"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx"
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
                onComplete={(complete) => void verify(complete)}
                inputRef={codeInput}
                error={fields.otp}
                disabled={disabled || throttled}
              />
            )}
            {!recovery && codeFailures >= 2 && (
              <p className="signin-otp-hint">
                Codes change every 30 seconds. If they keep failing, check that
                your phone sets its time automatically.
              </p>
            )}
            <Button type="submit" busy={busy} className="signin-submit">
              Verify
            </Button>
          </fieldset>
        </form>
        <div className="signin-links">
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => toSignIn(undefined, who)}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
              clearMessages();
              requestAnimationFrame(() => codeInput.current?.focus());
            }}
          >
            {recovery ? "Use your authenticator app" : "Use a recovery code"}
          </button>
        </div>
      </>,
    );
  }

  return shell(
    <>
      {title(`Sign in to ${instance}`)}
      <p className="signin-lede">Use your Vectory account to continue.</p>
      {noticeBox}
      {alertBox}
      {unconfirmed}
      {checking && (
        <div className="signin-loading" role="status">
          <Spinner />
          Checking whether you're signed in…
        </div>
      )}
      <form onSubmit={signIn} noValidate>
        <fieldset disabled={disabled}>
          <AuthField label="Email address" error={fields.email}>
            {({ id, describedBy, invalid }) => (
              <input
                ref={emailInput}
                id={id}
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </AuthField>
          <PasswordField
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            inputRef={passwordInput}
            labelAction={
              <a className="auth-field-link" href="#/reset">
                Forgot password?
              </a>
            }
          />
          <Button
            type="submit"
            busy={busy}
            disabled={throttled}
            className="signin-submit"
          >
            {throttled ? (
              <>
                Try again in{" "}
                <span className="signin-countdown">
                  {formatCountdown(throttle ?? 0)}
                </span>
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </fieldset>
      </form>
    </>,
  );
}
