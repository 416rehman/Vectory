import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  api,
  getCSRFVersion,
  getSessionEpoch,
  invalidateSession,
  isSessionValid,
  SessionSchema,
  setCSRF,
  withRequestDeadline,
  type User,
} from "./api";
import { isMissingSession } from "./authRequests";
import { Button, Spinner } from "./ui";
import { helpHref } from "./DocLink";
import { useAppearance } from "./appearance";
import PageBoundary from "./PageBoundary";
import { loadPage } from "./pageLoading";
import Brand from "./Brand";

const Documentation = lazy(() => loadPage(() => import("./Documentation")));
const Auth = lazy(() => loadPage(() => import("./AuthScreen")));
// The signed-in app (navigation, search, account menu, every page) is one
// chunk of its own: the sign-in screen downloads none of it, and starts
// fetching it once someone begins signing in.
const loadShell = () => import("./SignedInShell");
const SignedInShell = lazy(() => loadPage(loadShell));

function AppLoading() {
  return (
    <div className="app-loading">
      <Brand />
      <Spinner />
      <p role="status">Loading Vectory…</p>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [initialized, setInitialized] = useState<boolean | null>(null),
    [connectionError, setConnectionError] = useState(""),
    [checking, setChecking] = useState(true),
    [route, setRoute] = useState(location.hash.slice(2) || "overview");
  const [appearance, setAppearance] = useAppearance();
  const [sessionEnded, setSessionEnded] = useState(false);
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
  }, []);
  // Someone starting to sign in will need the signed-in app next.
  useEffect(() => {
    if (user || checking) return;
    const warm = () => void loadShell().catch(() => {});
    window.addEventListener("keydown", warm, { once: true });
    window.addEventListener("pointerdown", warm, { once: true });
    return () => {
      window.removeEventListener("keydown", warm);
      window.removeEventListener("pointerdown", warm);
    };
  }, [user, checking]);
  const finishSignOut = useCallback(() => {
    setUser(null);
    setCSRF("");
  }, []);
  const reloadSignIn = useCallback(() => {
    finishSignOut();
    void initialize();
  }, [finishSignOut, initialize]);
  const renewed = useCallback((next: User) => {
    setSessionEnded(false);
    setUser(next);
  }, []);
  useEffect(() => {
    // The signed-in shell names its pages; everything before it is "Vectory".
    if (!user || checking) document.title = "Vectory";
  }, [user, checking]);
  const page = route.split("?")[0].split("/")[0];
  if (page === "docs" && !user) {
    return (
      <main className="app-loading">
        <Brand />
        <PageBoundary resetKey={`public:${route}`}>
          <Suspense fallback={<Spinner />}>
            <Documentation
              topic={route.split("?")[0].split("/")[1]}
              navigate={navigate}
            />
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
          Help center <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    );
  if (!user)
    return (
      <PageBoundary resetKey={`sign-in:${route}`}>
        <Suspense fallback={<AppLoading />}>
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
        </Suspense>
      </PageBoundary>
    );
  return (
    <PageBoundary resetKey={`shell:${user.id}:${route}`} standalone>
      <Suspense fallback={<AppLoading />}>
        <SignedInShell
          user={user}
          route={route}
          navigateTo={navigate}
          appearance={appearance}
          onAppearanceChange={setAppearance}
          sessionEnded={sessionEnded}
          onSessionRenewed={renewed}
          onSignInAgain={finishSignOut}
          onUserChanged={setUser}
          onSignedOut={finishSignOut}
          onReload={reloadSignIn}
        />
      </Suspense>
    </PageBoundary>
  );
}
