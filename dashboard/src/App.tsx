import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalLink } from "lucide-react";
import {
  APIError,
  api,
  getCSRFVersion,
  getSessionEpoch,
  invalidateSession,
  isSessionValid,
  LoginSchema,
  SessionSchema,
  setCSRF,
  withRequestDeadline,
  type LoginChallenge,
  type User,
} from "./api";
import { roleAllows } from "./roleAccess";
import {
  authAuthorityUnchanged,
  authUserMatches,
  isDefinitiveAuthRejection,
  isMissingSession,
  useAuthRequest,
} from "./authRequests";
import { Button, ErrorBox, Field, ShellContext, Spinner } from "./ui";
import { helpHref } from "./DocLink";
import AccountMenu from "./AccountMenu";
import CommandPalette from "./CommandPalette";
import DeploymentRecoveryCenter from "./DeploymentRecovery";
import {
  initialsFor,
  KeyboardShortcuts,
  MobileHeader,
  NotFound,
  PageSkeleton,
  PermissionNeeded,
  Sidebar,
  useGlobalShortcuts,
} from "./Shell";
import { knownPages, routeTitle, sectionOf, shellInfo } from "./navigation";
import { notifyToast, toast, ToastViewport } from "./toast";
import { useAppearance } from "./appearance";
import PageBoundary from "./PageBoundary";
import { loadPage } from "./pageLoading";
const Editor = lazy(() => loadPage(() => import("./Editor")));
const Configurations = lazy(() => loadPage(() => import("./PipelineLibrary")));
const Documentation = lazy(() => loadPage(() => import("./Documentation")));
import { Devices, Groups, Overview } from "./Fleet";
import { Enrollment, Policies, Settings as InstanceSettings } from "./Control";
import Deployments, { type DeploymentQuery } from "./Deployments";
import { readDeploymentQuery } from "./deploymentRouting";
import AuditLog from "./AuditLog";
import { readAuditQuery, type AuditQuery } from "./auditModel";
import Issues from "./Issues";
import { UsersSecurity } from "./UsersSecurity";
import { PasswordReset } from "./AccountAccess";
import type { PipelineLibraryQuery } from "./PipelineLibrary";
import { readPipelineDestination } from "./pipelineDestination";
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "small" : ""}`}>
      <svg
        className="brand-mark"
        viewBox="0 0 28 30"
        fill="none"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="M1 3h6.2l7 18.6L21.2 3H27L16.4 28h-5.2L1 3Z"
        />
        <path fill="currentColor" d="M11.4 3H17l-2.8 7.3L11.4 3Z" />
      </svg>
      <span className="brand-word">Vectory</span>
    </span>
  );
}
function Auth({
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
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [initialized, setInitialized] = useState<boolean | null>(null),
    [connectionError, setConnectionError] = useState(""),
    [checking, setChecking] = useState(true),
    [route, setRoute] = useState(location.hash.slice(2) || "overview"),
    [sidebar, setSidebar] = useState(false),
    [commandOpen, setCommandOpen] = useState(false),
    [shortcutsOpen, setShortcutsOpen] = useState(false),
    [accountOpen, setAccountOpen] = useState(false);
  const [appearance, setAppearance] = useAppearance();
  const accountOpenRef = useRef(accountOpen);
  accountOpenRef.current = accountOpen;
  const [collapsedPreference, setCollapsedPreference] = useState<
    boolean | null
  >(() => {
    try {
      const saved = localStorage.getItem("vectory-sidebar-collapsed");
      return saved === "true" ? true : saved === "false" ? false : null;
    } catch {
      return null;
    }
  });
  const [mobileNavigation, setMobileNavigation] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const navigationRef = useRef<HTMLElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const shellModalReturnFocus = useRef<HTMLElement | null>(null);
  function openShellModal(kind: "search" | "shortcuts", opener?: HTMLElement) {
    if (!commandOpen && !shortcutsOpen) {
      shellModalReturnFocus.current = mobileNavigation
        ? opener?.closest(".mobile-header")
          ? opener
          : navigationToggle.current
        : opener ||
          (accountOpen
            ? navigationRef.current?.querySelector<HTMLButtonElement>(
                ".account-button",
              )
            : null) ||
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null);
    }
    setSidebar(false);
    setAccountOpen(false);
    setCommandOpen(kind === "search");
    setShortcutsOpen(kind === "shortcuts");
  }
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const changed = () => {
      setMobileNavigation(media.matches);
      setSidebar(false);
      setAccountOpen(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (mobileNavigation && !sidebar) setAccountOpen(false);
  }, [mobileNavigation, sidebar]);
  useEffect(() => {
    if (!user) {
      setSidebar(false);
      setAccountOpen(false);
      setCommandOpen(false);
      setShortcutsOpen(false);
      toast.clear();
    }
  }, [user]);
  useEffect(() => {
    if (!user || !mobileNavigation || !sidebar) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The header avatar opens the drawer with the account menu already open;
    // moving focus to the close button then would dismiss that menu.
    const frame = requestAnimationFrame(() => {
      if (accountOpenRef.current) return;
      navigationRef.current
        ?.querySelector<HTMLButtonElement>(".sidebar-close")
        ?.focus({ preventScroll: true });
    });
    const containFocus = (event: KeyboardEvent) => {
      if (accountOpenRef.current || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebar(false);
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        navigationRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !navigationRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !navigationRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", containFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", containFocus);
      document.body.style.overflow = overflow;
      navigationToggle.current?.focus();
    };
  }, [mobileNavigation, sidebar, user?.id]);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [libraryView, setLibraryView] = useState<{
    userId: string;
    query: PipelineLibraryQuery;
  } | null>(null);
  const [deploymentViews, setDeploymentViews] = useState<{
    userId: string;
    deployments?: DeploymentQuery;
    schedules?: DeploymentQuery;
  } | null>(null);
  const [auditView, setAuditView] = useState<{
    userId: string;
    query: AuditQuery;
  } | null>(null);
  const rememberAudit = useCallback(
    (query: AuditQuery) => {
      if (user) setAuditView({ userId: user.id, query });
    },
    [user?.id],
  );
  const rememberDeployments = useCallback(
    (query: DeploymentQuery) => {
      if (user)
        setDeploymentViews((old) => ({
          ...(old?.userId === user.id ? old : {}),
          userId: user.id,
          deployments: query,
        }));
    },
    [user?.id],
  );
  const rememberSchedules = useCallback(
    (query: DeploymentQuery) => {
      if (user)
        setDeploymentViews((old) => ({
          ...(old?.userId === user.id ? old : {}),
          userId: user.id,
          schedules: query,
        }));
    },
    [user?.id],
  );
  const rememberLibraryView = useCallback(
    (query: PipelineLibraryQuery) => {
      if (user) setLibraryView({ userId: user.id, query });
    },
    [user?.id],
  );
  useEffect(() => {
    if (!user) {
      setLibraryView(null);
      setDeploymentViews(null);
      setAuditView(null);
    }
  }, [user?.id]);
  useEffect(() => {
    const ended = () => {
      invalidateSession();
      setSessionEnded(true);
    };
    window.addEventListener("vectory:session-ended", ended);
    return () => window.removeEventListener("vectory:session-ended", ended);
  }, []);
  useEffect(() => {
    if (!user) return;
    const expectedUser = user.id;
    let active = true,
      requestId = 0;
    let controller: AbortController | null = null;
    async function refreshSession() {
      if (!isSessionValid()) return;
      controller?.abort();
      const currentController = new AbortController();
      controller = currentController;
      const request = ++requestId,
        version = getCSRFVersion(),
        epoch = getSessionEpoch();
      try {
        const session = await withRequestDeadline(
          (signal) => api("/session", { signal }, SessionSchema),
          30000,
          currentController.signal,
        );
        if (
          !active ||
          request !== requestId ||
          version !== getCSRFVersion() ||
          epoch !== getSessionEpoch() ||
          !isSessionValid()
        )
          return;
        if (session.user.id !== expectedUser || !session.user.enabled) {
          invalidateSession();
          setSessionEnded(true);
          return;
        }
        setCSRF(session.csrf_token);
        setUser((previous) =>
          previous && JSON.stringify(previous) === JSON.stringify(session.user)
            ? previous
            : session.user,
        );
        setSessionEnded(false);
      } catch {
        /* An expired session is handled by the shared API event. */
      }
    }
    const stored = (event: StorageEvent) => {
      if (event.key === "vectory-session-change") void refreshSession();
    };
    const focused = () => {
      void refreshSession();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refreshSession();
    };
    window.addEventListener("storage", stored);
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener("storage", stored);
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [user?.id]);
  const notify = useCallback((message: string) => {
    notifyToast(message);
  }, []);
  const initialization = useRef<AbortController | null>(null);
  const initialize = useCallback(async () => {
    initialization.current?.abort();
    const controller = new AbortController();
    initialization.current = controller;
    const epoch = getSessionEpoch(),
      version = getCSRFVersion();
    const current = () =>
      initialization.current === controller && !controller.signal.aborted;
    setChecking(true);
    setConnectionError("");
    try {
      const result = await withRequestDeadline(
        async (signal) => {
          const status = await api<{ initialized: boolean }>("/status", {
            signal,
          });
          if (!status.initialized) return { initialized: false, session: null };
          try {
            return {
              initialized: true,
              session: await api("/session", { signal }, SessionSchema),
            };
          } catch (failure) {
            if (!isMissingSession(failure)) throw failure;
            return { initialized: true, session: null };
          }
        },
        30000,
        controller.signal,
      );
      if (!current()) return;
      if (
        version !== getCSRFVersion() ||
        (result.session && epoch !== getSessionEpoch())
      )
        throw new Error("Sign-in state changed. Try connecting again.");
      if (result.session && !result.session.user.enabled)
        throw new Error(
          "This account is disabled. Ask an administrator to restore access.",
        );
      setInitialized(result.initialized);
      if (result.session) {
        setCSRF(result.session.csrf_token);
        setSessionEnded(false);
        setUser(result.session.user);
      } else {
        setUser(null);
      }
    } catch (e) {
      if (!current()) return;
      setInitialized(null);
      setConnectionError(
        `Could not connect to Vectory. ${(e as Error).message}`,
      );
    } finally {
      if (current()) {
        initialization.current = null;
        setChecking(false);
      }
    }
  }, []);
  useEffect(() => {
    void initialize();
    return () => {
      initialization.current?.abort();
      initialization.current = null;
    };
  }, [initialize]);
  useEffect(() => {
    const changed = () => {
      const nextRoute = location.hash.slice(2) || "overview";
      if (
        nextRoute !== route &&
        (nextRoute.split("?")[0] !== route.split("?")[0] ||
          /^(deployments|schedules|issues|audit)(?:[/?]|$)/.test(route)) &&
        !window.dispatchEvent(
          new Event("vectory:before-navigate", { cancelable: true }),
        )
      ) {
        history.replaceState(null, "", "#/" + route);
        return;
      }
      setRoute(nextRoute);
      setSidebar(false);
      setAccountOpen(false);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [route]);
  const navigate = useCallback((path: string) => {
    if (path.startsWith("docs/")) {
      window.open(helpHref(path.slice(5)), "_blank", "noopener,noreferrer");
    } else {
      location.hash = "/" + path;
    }
    setCommandOpen(false);
    setShortcutsOpen(false);
    setSidebar(false);
    setAccountOpen(false);
  }, []);
  function beforeSignOut() {
    return window.dispatchEvent(
      new Event("vectory:before-navigate", { cancelable: true }),
    );
  }
  function finishSignOut() {
    setUser(null);
    setCSRF("");
    setAccountOpen(false);
    setSidebar(false);
  }
  function reloadSignIn() {
    finishSignOut();
    void initialize();
  }
  const routePath = route.split("?")[0];
  const [page, id] = routePath.split("/");
  const selectedDeviceId =
    new URLSearchParams(route.split("?")[1] || "").get("device") || undefined;
  const pipelineDestination = readPipelineDestination(
    route.split("?")[1] || "",
  );
  const editorPage = page === "configurations" && !!id;
  const sidebarCollapsed = collapsedPreference ?? editorPage;
  const mobileMenuOpen = mobileNavigation && sidebar;
  const resolvedTheme =
    appearance === "auto"
      ? document.documentElement.dataset.theme === "dark"
        ? "dark"
        : "light"
      : appearance;
  function toggleSidebarWidth() {
    const next = !sidebarCollapsed;
    setCollapsedPreference(next);
    try {
      localStorage.setItem("vectory-sidebar-collapsed", String(next));
    } catch {
      /* The current choice still works when browser storage is unavailable. */
    }
  }
  useGlobalShortcuts({
    enabled: !!user,
    onPalette: () => {
      if (commandOpen) setCommandOpen(false);
      else openShellModal("search");
    },
    onShortcuts: () => openShellModal("shortcuts"),
    onToggleSidebar: () => {
      if (!mobileNavigation) toggleSidebarWidth();
    },
    navigate,
  });
  useEffect(() => {
    // Pages name themselves through PageHeader; this covers the first paint.
    if (user && !checking) document.title = routeTitle(page);
    else document.title = "Vectory";
  }, [page, user?.id, checking]);
  const shell = useMemo(() => shellInfo(page, id), [page, id]);
  if (page === "docs" && !user) {
    return (
      <main className="app-loading">
        <Brand />
        <PageBoundary resetKey={`public:${route}`}>
          <Suspense fallback={<Spinner />}>
            <Documentation topic={id} navigate={navigate} />
          </Suspense>
        </PageBoundary>
      </main>
    );
  }
  if (checking)
    return (
      <div className="app-loading">
        <Brand />
        <Spinner />
        <p role="status">Loading Vectory…</p>
        <Button variant="ghost" onClick={() => void initialize()}>
          Retry connection
        </Button>
        <a
          className="auth-help"
          href="/help/getting-started/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Vectory documentation <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    );
  if (!user)
    return (
      <Auth
        initialized={initialized}
        error={connectionError}
        onSetupDetected={() => setInitialized(true)}
        onAuthenticated={(u) => {
          setInitialized(true);
          setSessionEnded(false);
          setUser(u);
        }}
        retry={() => void initialize()}
      />
    );
  const section = sectionOf(page);
  const known = knownPages.has(page);
  return (
    <ShellContext.Provider value={shell}>
      <div
        className={`app-shell ${sidebar ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${editorPage ? "editor-shell" : ""}`}
      >
        <a
          className="skip-link"
          href="#main-content"
          tabIndex={mobileMenuOpen ? -1 : undefined}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("main-content")?.focus();
          }}
        >
          Skip to main content
        </a>
        {mobileMenuOpen && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            tabIndex={-1}
            onClick={() => setSidebar(false)}
          />
        )}
        <Sidebar
          brand={<Brand />}
          section={section}
          collapsed={sidebarCollapsed}
          mobile={mobileNavigation}
          mobileOpen={mobileMenuOpen}
          navigationRef={navigationRef}
          onSearch={(opener) => openShellModal("search", opener)}
          onToggleCollapsed={toggleSidebarWidth}
          onClose={() => setSidebar(false)}
          accountMenu={
            <AccountMenu
              key={user.id}
              user={user}
              open={accountOpen}
              onOpenChange={setAccountOpen}
              theme={appearance}
              onThemeChange={setAppearance}
              onNavigate={navigate}
              onBeforeSignOut={beforeSignOut}
              onSignedOut={finishSignOut}
              onReload={reloadSignIn}
              onShowShortcuts={() => openShellModal("shortcuts")}
              mobile={mobileNavigation}
              currentPage={page}
            />
          }
        />
        <div className="app-main" inert={mobileMenuOpen}>
          {/* The session prompt has one mount point, above the page. */}
          {sessionEnded && (
            <div className="session-ended" role="alert">
              <span>Your session ended. Sign in again to continue.</span>
              <Button
                variant="secondary"
                onClick={() => {
                  if (
                    !window.dispatchEvent(
                      new Event("vectory:before-navigate", {
                        cancelable: true,
                      }),
                    )
                  )
                    return;
                  setCSRF("");
                  setUser(null);
                  setAccountOpen(false);
                }}
              >
                Sign in again
              </Button>
            </div>
          )}
          <MobileHeader
            title={routeTitle(page).split(" · ")[0]}
            expanded={mobileMenuOpen}
            toggleRef={navigationToggle}
            initials={initialsFor(user)}
            onToggle={() => setSidebar((v) => !v)}
            onSearch={(opener) => openShellModal("search", opener)}
            onAccount={() => {
              setSidebar(true);
              setAccountOpen(true);
            }}
          />
          <DeploymentRecoveryCenter key={user.id} user={user} notify={notify} />
          <main
            key={
              page === "deployments" || page === "schedules" || page === "audit"
                ? page
                : routePath
            }
            id="main-content"
            tabIndex={-1}
            className={`page-content ${page === "configurations" && id ? "editor-content" : ""}`}
          >
            <PageBoundary resetKey={`${user.id}:${user.role}:${route}`}>
              <Suspense
                fallback={
                  <PageSkeleton
                    title={routeTitle(page).split(" · ")[0]}
                    editor={editorPage}
                  />
                }
              >
                {page === "docs" ? (
                  <Documentation topic={id} navigate={navigate} />
                ) : page === "overview" ? (
                  <Overview user={user} navigate={navigate} />
                ) : page === "devices" ? (
                  <Devices
                    user={user}
                    notify={notify}
                    navigate={navigate}
                    deviceId={id}
                  />
                ) : page === "groups" ? (
                  <Groups user={user} notify={notify} />
                ) : page === "configurations" ? (
                  id ? (
                    <Editor
                      initialDeviceId={selectedDeviceId}
                      destination={pipelineDestination}
                      key={`${user.id}:${user.role}:${id}`}
                      id={id}
                      user={user}
                      notify={notify}
                      navigate={navigate}
                    />
                  ) : (
                    <Configurations
                      key={`${user.id}:${user.role}`}
                      initialDeviceId={selectedDeviceId}
                      destination={pipelineDestination}
                      initialQuery={
                        libraryView?.userId === user.id
                          ? libraryView.query
                          : undefined
                      }
                      onQueryChange={rememberLibraryView}
                      user={user}
                      notify={notify}
                      navigate={navigate}
                    />
                  )
                ) : page === "deployments" || page === "schedules" ? (
                  <Deployments
                    key={page}
                    selectedDeploymentId={id || null}
                    routeKey={route}
                    routeQuery={
                      readDeploymentQuery(route.split("?")[1] || "") ??
                      (deploymentViews?.userId === user.id
                        ? deploymentViews[page]
                        : undefined)
                    }
                    initialQuery={
                      deploymentViews?.userId === user.id
                        ? deploymentViews[page]
                        : undefined
                    }
                    onQueryChange={
                      page === "schedules"
                        ? rememberSchedules
                        : rememberDeployments
                    }
                    user={user}
                    scheduled={page === "schedules"}
                    notify={notify}
                    navigate={navigate}
                  />
                ) : page === "policies" ? (
                  <Policies user={user} notify={notify} />
                ) : page === "enrollment" ? (
                  roleAllows(user, "operate") ? (
                    <Enrollment
                      user={user}
                      notify={notify}
                      navigate={navigate}
                    />
                  ) : (
                    <PermissionNeeded
                      title="Add device"
                      task="Adding devices"
                      role="Operator"
                      user={user}
                    />
                  )
                ) : page === "issues" ? (
                  <Issues
                    user={user}
                    notify={notify}
                    navigate={navigate}
                    deviceId={selectedDeviceId}
                  />
                ) : page === "audit" ? (
                  <AuditLog
                    selectedAuditId={id || null}
                    routeKey={route}
                    routeQuery={
                      readAuditQuery(route.split("?")[1] || "") ??
                      (auditView?.userId === user.id
                        ? auditView.query
                        : undefined)
                    }
                    initialQuery={
                      auditView?.userId === user.id
                        ? auditView.query
                        : undefined
                    }
                    initialDeviceId={selectedDeviceId}
                    onQueryChange={rememberAudit}
                    navigate={navigate}
                  />
                ) : page === "users" ? (
                  <UsersSecurity
                    user={user}
                    notify={notify}
                    onUserChanged={setUser}
                    onSignIn={finishSignOut}
                    onReload={reloadSignIn}
                  />
                ) : page === "settings" ? (
                  <InstanceSettings />
                ) : known ? (
                  <PermissionNeeded
                    title={routeTitle(page).split(" · ")[0]}
                    task="This page"
                    role="Administrator"
                    user={user}
                  />
                ) : (
                  <NotFound onSearch={() => openShellModal("search")} />
                )}
              </Suspense>
            </PageBoundary>
          </main>
        </div>
        <ToastViewport />
        <CommandPalette
          open={commandOpen}
          onOpenChange={setCommandOpen}
          returnFocusRef={shellModalReturnFocus}
          user={user}
          currentPage={page}
          navigate={navigate}
          theme={resolvedTheme}
          onToggleTheme={() =>
            setAppearance(resolvedTheme === "dark" ? "light" : "dark")
          }
          onShowShortcuts={() => openShellModal("shortcuts")}
          sidebarCollapsed={mobileNavigation ? undefined : sidebarCollapsed}
          onToggleSidebar={mobileNavigation ? undefined : toggleSidebarWidth}
        />
        <KeyboardShortcuts
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          returnFocusRef={shellModalReturnFocus}
        />
      </div>
    </ShellContext.Provider>
  );
}
