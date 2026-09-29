import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "./api";
import { roleAllows } from "./roleAccess";
import { ShellContext } from "./ui";
import AccountMenu from "./AccountMenu";
import CommandPalette from "./CommandPalette";
import DeploymentRecoveryCenter from "./DeploymentRecovery";
import {
  initialsFor,
  KeyboardShortcuts,
  MobileHeader,
  NotFound,
  PageSkeleton,
  Sidebar,
  useGlobalShortcuts,
} from "./Shell";
import { routeTitle, sectionOf, shellInfo } from "./navigation";
import { notifyToast, toast, ToastViewport, type Notify } from "./toast";
import type { Appearance } from "./appearance";
import PageBoundary from "./PageBoundary";
import { loadPage } from "./pageLoading";
import SessionRenewal from "./SessionRenewal";
import PermissionNote from "./PermissionNote";
import Brand from "./Brand";
import type { DeploymentQuery } from "./Deployments";
import { readDeploymentQuery } from "./deploymentRouting";
import { readAuditQuery, type AuditQuery } from "./auditModel";
import type { PipelineLibraryQuery } from "./PipelineLibrary";
import { readPipelineDestination } from "./pipelineDestination";

// Every page loads when its route opens, so the shell downloads only what it shows.
const Editor = lazy(() => loadPage(() => import("./Editor")));
const Configurations = lazy(() => loadPage(() => import("./PipelineLibrary")));
const Documentation = lazy(() => loadPage(() => import("./Documentation")));
const Overview = lazy(() =>
  loadPage(() => import("./Overview").then((m) => ({ default: m.Overview }))),
);
const Devices = lazy(() =>
  loadPage(() => import("./Fleet").then((m) => ({ default: m.Devices }))),
);
const Groups = lazy(() =>
  loadPage(() => import("./Fleet").then((m) => ({ default: m.Groups }))),
);
const Policies = lazy(() =>
  loadPage(() => import("./Control").then((m) => ({ default: m.Policies }))),
);
const InstanceSettings = lazy(() =>
  loadPage(() => import("./Control").then((m) => ({ default: m.Settings }))),
);
const Enrollment = lazy(() =>
  loadPage(() =>
    import("./Enrollment").then((m) => ({ default: m.Enrollment })),
  ),
);
const Deployments = lazy(() => loadPage(() => import("./Deployments")));
const AuditLog = lazy(() => loadPage(() => import("./AuditLog")));
const Issues = lazy(() => loadPage(() => import("./Issues")));
const UsersSecurity = lazy(() =>
  loadPage(() =>
    import("./UsersSecurity").then((m) => ({ default: m.UsersSecurity })),
  ),
);
const Notifications = lazy(() => loadPage(() => import("./Notifications")));

/** The new page's title, or its main region when the title can't take focus. */
function arrivalTarget() {
  const main = document.getElementById("main-content");
  if (!main) return null;
  // A loading skeleton's title is about to be replaced: wait for the page's.
  const title = [...main.querySelectorAll<HTMLElement>("h1")].find(
    (heading) => !heading.closest("[data-page-skeleton]"),
  );
  if (!title) return null;
  return title.hasAttribute("tabindex") ? title : main;
}

/**
 * After in-app navigation. When the focused control left with the old page
 * (a section tab, a row link, "Open rollout"), focus the new page's title, so
 * the next Tab continues from there and a screen reader reads where it is.
 * Otherwise (the sidebar, search, a shortcut) focus stays put and a polite
 * live region names the new page. Returns that region's text.
 */
function usePageArrival(pageKey: string) {
  const [announcement, setAnnouncement] = useState("");
  const lastFocused = useRef<Element | null>(null);
  const first = useRef(true);
  useEffect(() => {
    const record = (event: FocusEvent) => {
      if (event.target instanceof Element) lastFocused.current = event.target;
    };
    document.addEventListener("focusin", record);
    return () => document.removeEventListener("focusin", record);
  }, []);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    const lost =
      (!active || active === document.body) &&
      !!lastFocused.current &&
      !lastFocused.current.isConnected;
    const timers: number[] = [];
    let observer: MutationObserver | null = null;
    if (lost) {
      const place = () => {
        // Someone moved focus meanwhile: theirs wins.
        if (document.activeElement && document.activeElement !== document.body)
          return true;
        const target = arrivalTarget();
        target?.focus({ preventScroll: true });
        return !!target;
      };
      if (!place()) {
        // A lazy page renders its title once its files arrive.
        observer = new MutationObserver(() => {
          if (place()) observer?.disconnect();
        });
        const main = document.getElementById("main-content");
        if (main) observer.observe(main, { childList: true, subtree: true });
        timers.push(window.setTimeout(() => observer?.disconnect(), 15000));
      }
    } else {
      // Clear, then write, so a repeated name is announced again. The page
      // names itself (document.title) as it renders.
      setAnnouncement("");
      timers.push(
        window.setTimeout(() => {
          setAnnouncement(document.title.split(" · ")[0] || "");
          timers.push(window.setTimeout(() => setAnnouncement(""), 10000));
        }, 350),
      );
    }
    return () => {
      observer?.disconnect();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pageKey]);
  return announcement;
}

/**
 * Everything a signed-in person sees around the page: navigation, search,
 * account menu, shortcuts, notifications and recovery reminders. It loads as
 * its own chunk, so the sign-in screen downloads none of it.
 */
export default function SignedInShell({
  user,
  route,
  navigateTo,
  appearance,
  onAppearanceChange,
  sessionEnded,
  onSessionRenewed,
  onSignInAgain,
  onUserChanged,
  onSignedOut,
  onReload,
}: {
  user: User;
  route: string;
  /** Changes the route; the shell closes its own overlays around it. */
  navigateTo: (path: string) => void;
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
  sessionEnded: boolean;
  onSessionRenewed: (user: User) => void;
  onSignInAgain: () => void;
  onUserChanged: (user: User | null) => void;
  onSignedOut: () => void;
  onReload: () => void;
}) {
  const [sidebar, setSidebar] = useState(false),
    [commandOpen, setCommandOpen] = useState(false),
    [shortcutsOpen, setShortcutsOpen] = useState(false),
    [accountOpen, setAccountOpen] = useState(false);
  const accountOpenRef = useRef(accountOpen);
  accountOpenRef.current = accountOpen;
  // A new route closes the navigation drawer and the account menu.
  const [shownRoute, setShownRoute] = useState(route);
  if (shownRoute !== route) {
    setShownRoute(route);
    setSidebar(false);
    setAccountOpen(false);
  }
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
  // Signing out unmounts the shell: its notifications go with it.
  useEffect(() => () => toast.clear(), []);
  useEffect(() => {
    if (!mobileNavigation || !sidebar) return;
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
  }, [mobileNavigation, sidebar, user.id]);
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
    (query: AuditQuery) => setAuditView({ userId: user.id, query }),
    [user.id],
  );
  const rememberDeployments = useCallback(
    (query: DeploymentQuery) =>
      setDeploymentViews((old) => ({
        ...(old?.userId === user.id ? old : {}),
        userId: user.id,
        deployments: query,
      })),
    [user.id],
  );
  const rememberSchedules = useCallback(
    (query: DeploymentQuery) =>
      setDeploymentViews((old) => ({
        ...(old?.userId === user.id ? old : {}),
        userId: user.id,
        schedules: query,
      })),
    [user.id],
  );
  const rememberLibraryView = useCallback(
    (query: PipelineLibraryQuery) => setLibraryView({ userId: user.id, query }),
    [user.id],
  );
  const notify = useCallback<Notify>((message, options) => {
    notifyToast(message, options);
  }, []);
  const navigate = useCallback(
    (path: string) => {
      navigateTo(path);
      setCommandOpen(false);
      setShortcutsOpen(false);
      setSidebar(false);
      setAccountOpen(false);
    },
    [navigateTo],
  );
  function beforeSignOut() {
    return window.dispatchEvent(
      new Event("vectory:before-navigate", { cancelable: true }),
    );
  }
  function signedOut() {
    setAccountOpen(false);
    setSidebar(false);
    onSignedOut();
  }
  const routePath = route.split("?")[0];
  const [page, id] = routePath.split("/");
  const query = route.split("?")[1] || "";
  const selectedDeviceId =
    new URLSearchParams(query).get("device") || undefined;
  const pipelineDestination = readPipelineDestination(query);
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
    enabled: true,
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
    document.title = routeTitle(page);
  }, [page, user.id]);
  const shell = useMemo(() => shellInfo(page, id), [page, id]);
  const section = sectionOf(page);
  // The page element: a rollout and its list share one, as do audit views.
  const mainKey =
    page === "deployments" || page === "schedules" || page === "audit"
      ? page
      : routePath;
  const arrival = usePageArrival(mainKey);
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
              onThemeChange={onAppearanceChange}
              onNavigate={navigate}
              onBeforeSignOut={beforeSignOut}
              onSignedOut={signedOut}
              onReload={onReload}
              onShowShortcuts={() => openShellModal("shortcuts")}
              mobile={mobileNavigation}
              currentPage={page}
            />
          }
        />
        <div className="app-main" inert={mobileMenuOpen}>
          {/* The session prompt has one mount point, above the page. */}
          {sessionEnded && (
            <SessionRenewal
              user={user}
              onRenewed={onSessionRenewed}
              onSignInAgain={() => {
                setAccountOpen(false);
                onSignInAgain();
              }}
            />
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
            key={mainKey}
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
                      readDeploymentQuery(query) ??
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
                    <PermissionNote
                      user={user}
                      needs="operate"
                      title="Add device"
                      action="Adding devices"
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
                      readAuditQuery(query) ??
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
                    onUserChanged={onUserChanged}
                    onSignIn={signedOut}
                    onReload={onReload}
                  />
                ) : page === "settings" ? (
                  <InstanceSettings />
                ) : page === "notifications" && !id ? (
                  <Notifications
                    user={user}
                    notify={notify}
                    query={route.split("?")[1] || ""}
                  />
                ) : (
                  <NotFound onSearch={() => openShellModal("search")} />
                )}
              </Suspense>
            </PageBoundary>
          </main>
        </div>
        <ToastViewport />
        <div
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
          data-route-announcer=""
        >
          {arrival}
        </div>
        <CommandPalette
          open={commandOpen}
          onOpenChange={setCommandOpen}
          returnFocusRef={shellModalReturnFocus}
          user={user}
          currentPage={page}
          navigate={navigate}
          theme={resolvedTheme}
          onToggleTheme={() =>
            onAppearanceChange(resolvedTheme === "dark" ? "light" : "dark")
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
