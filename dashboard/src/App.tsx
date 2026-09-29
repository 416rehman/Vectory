import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Home,
  Layers,
  Menu,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import {
  api,
  can,
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
import { Button, ErrorBox, IconButton, Modal, Spinner } from "./ui";
import { helpHref } from "./DocLink";
import TabLabel from "./TabLabel";
import AccountMenu from "./AccountMenu";
import PageFinder from "./PageFinder";
import DeploymentRecoveryCenter from "./DeploymentRecovery";
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
import Auth from "./AuthScreen";
import SessionRenewal from "./SessionRenewal";
import PermissionNote from "./PermissionNote";
import type { PipelineLibraryQuery } from "./PipelineLibrary";
import { readPipelineDestination } from "./pipelineDestination";
const primary = [
  { id: "overview", name: "Overview", icon: Home },
  { id: "configurations", name: "Pipelines", icon: Workflow },
  { id: "devices", name: "Devices", icon: Server },
  { id: "deployments", name: "Activity", icon: Activity },
];
const devicePages = [
  { id: "devices", name: "Devices", icon: Server },
  { id: "groups", name: "Groups", icon: Layers },
  { id: "policies", name: "Agent settings", icon: SlidersHorizontal },
];
const activityPages = [
  { id: "deployments", name: "Deployments", icon: Rocket },
  { id: "schedules", name: "Scheduled", icon: CalendarClock },
  { id: "issues", name: "Issues", icon: CircleAlert },
  { id: "audit", name: "Audit log", icon: ScrollText },
];
const settingsPages = [
  { id: "settings", name: "General", icon: Settings },
  { id: "users", name: "People & security", icon: UsersRound },
];
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
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [initialized, setInitialized] = useState<boolean | null>(null),
    [connectionError, setConnectionError] = useState(""),
    [checking, setChecking] = useState(true),
    [route, setRoute] = useState(location.hash.slice(2) || "overview"),
    [toast, setToast] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [commandOpen, setCommandOpen] = useState(false),
    [commandRequest, setCommandRequest] = useState(0),
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
  function openShellModal(kind: "search", opener?: HTMLElement) {
    if (!commandOpen) {
      shellModalReturnFocus.current = mobileNavigation
        ? navigationToggle.current
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
    setCommandRequest((request) => request + 1);
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
    }
  }, [user]);
  useEffect(() => {
    if (!user || !mobileNavigation || !sidebar) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() =>
      navigationRef.current
        ?.querySelector<HTMLButtonElement>(".sidebar-close")
        ?.focus({ preventScroll: true }),
    );
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
  const notify = useCallback((message: string) => setToast(message), []);
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
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (commandOpen) setCommandOpen(false);
        else openShellModal("search");
      }
      if (e.key === "Escape" && !accountOpenRef.current && !e.defaultPrevented)
        setSidebar(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [commandOpen, accountOpen, mobileNavigation]);
  const navigate = useCallback((path: string) => {
    if (path.startsWith("docs/")) {
      window.open(helpHref(path.slice(5)), "_blank", "noopener,noreferrer");
    } else {
      location.hash = "/" + path;
    }
    setCommandOpen(false);
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
  function toggleSidebarWidth() {
    const next = !sidebarCollapsed;
    setCollapsedPreference(next);
    try {
      localStorage.setItem("vectory-sidebar-collapsed", String(next));
    } catch {
      /* The current choice still works when browser storage is unavailable. */
    }
  }
  if (page === "docs" && !user) {
    return (
      <div className="public-docs">
        <header>
          <a href="#/overview" aria-label="Vectory sign in">
            <Brand />
          </a>
          <Button onClick={() => navigate("overview")}>Sign in</Button>
        </header>
        <main className="page-content">
          <PageBoundary resetKey={`public:${route}`}>
            <Suspense
              fallback={
                <div className="loading">
                  <Spinner />
                  Loading documentation
                </div>
              }
            >
              <Documentation topic={id} navigate={navigate} />
            </Suspense>
          </PageBoundary>
        </main>
      </div>
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
  const section = [...devicePages.map((p) => p.id), "enrollment"].includes(page)
    ? "devices"
    : activityPages.some((p) => p.id === page)
      ? "deployments"
      : settingsPages.some((p) => p.id === page)
        ? "settings"
        : page;
  const tabs =
    section === "devices" && !id && page !== "enrollment"
      ? devicePages
      : section === "deployments"
        ? activityPages
        : section === "settings"
          ? settingsPages
          : [];
  return (
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
      <aside
        id="main-navigation"
        ref={navigationRef}
        className="sidebar"
        role={mobileMenuOpen ? "dialog" : undefined}
        aria-modal={mobileMenuOpen && !accountOpen ? true : undefined}
        aria-label="Navigation"
      >
        <div className="sidebar-heading">
          <button
            className="brand-link"
            onClick={() => navigate("overview")}
            aria-label="Vectory overview"
          >
            <Brand />
          </button>
          <IconButton
            className="sidebar-close"
            icon={X}
            label="Close navigation"
            onClick={() => setSidebar(false)}
          />
        </div>
        <IconButton
          className="sidebar-collapse"
          icon={sidebarCollapsed ? ChevronRight : ChevronLeft}
          label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          aria-controls="main-navigation"
          onClick={toggleSidebarWidth}
        />
        <button
          className="sidebar-search"
          aria-label="Find a page"
          title="Find a page (Ctrl K)"
          onClick={(event) => openShellModal("search", event.currentTarget)}
        >
          <Search size={16} />
          <span>Find a page</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav aria-label="Main navigation">
          {primary.map((item) => (
            <button
              key={item.id}
              aria-current={section === item.id ? "page" : undefined}
              className={section === item.id ? "active" : ""}
              onClick={() => navigate(item.id)}
              aria-label={item.name}
              title={item.name}
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span className="nav-label">{item.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
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
            mobile={mobileNavigation}
            currentPage={page}
          />
        </div>
      </aside>
      <div className="app-main" inert={mobileMenuOpen}>
        {sessionEnded && (
          <SessionRenewal
            user={user}
            onRenewed={(next) => {
              setSessionEnded(false);
              setUser(next);
            }}
            onSignInAgain={() => {
              setCSRF("");
              setUser(null);
              setAccountOpen(false);
            }}
          />
        )}
        <header className="mobile-header">
          <button
            ref={navigationToggle}
            className="icon-button"
            aria-label="Toggle navigation"
            title="Toggle navigation"
            aria-expanded={mobileMenuOpen}
            aria-controls="main-navigation"
            onClick={() => setSidebar((v) => !v)}
          >
            <Menu size={17} />
          </button>
          <Brand small />
        </header>
        {tabs.length > 0 && (
          <nav
            className="section-tabs"
            aria-label={
              section === "devices"
                ? "Device sections"
                : section === "deployments"
                  ? "Activity sections"
                  : "Settings sections"
            }
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                aria-current={page === tab.id ? "page" : undefined}
                className={page === tab.id ? "active" : ""}
                onClick={() => navigate(tab.id)}
              >
                <TabLabel icon={tab.icon}>{tab.name}</TabLabel>
              </button>
            ))}
          </nav>
        )}
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
                <div className="loading">
                  <Spinner />
                  Loading page…
                </div>
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
              ) : page === "enrollment" && can(user, "operate") ? (
                <Enrollment user={user} notify={notify} navigate={navigate} />
              ) : page === "enrollment" ? (
                <PermissionNote
                  user={user}
                  needs="operate"
                  title="Add device"
                  action="Adding devices"
                />
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
                    auditView?.userId === user.id ? auditView.query : undefined
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
              ) : (
                <ErrorBox message="This page is unavailable for your account." />
              )}
            </Suspense>
          </PageBoundary>
        </main>
      </div>
      {toast && (
        <div role="status" className="toast">
          <span>{toast}</span>
          <IconButton
            icon={X}
            label="Dismiss notification"
            onClick={() => setToast("")}
          />
        </div>
      )}
      <Modal
        open={commandOpen}
        returnFocusRef={shellModalReturnFocus}
        onClose={() => setCommandOpen(false)}
        title="Find a page"
      >
        <PageFinder
          key={commandRequest}
          user={user}
          currentPage={page}
          navigate={navigate}
        />
      </Modal>
    </div>
  );
}
