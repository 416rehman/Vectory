import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  ExternalLink,
  Github,
  Home,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  Radio,
  Search,
  Server,
  Settings,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { api, post, SessionSchema, setCSRF, type User } from "./api";
import {
  Badge,
  Breadcrumb,
  Button,
  ErrorBox,
  Field,
  IconButton,
  Modal,
  Spinner,
} from "./ui";
import Editor, { Configurations } from "./Editor";
import { Devices, Groups, Overview } from "./Fleet";
import {
  AuditLog,
  Deployments,
  Enrollment,
  Issues,
  Policies,
  Settings as InstanceSettings,
  UsersSecurity,
} from "./Control";

const navigation = [
  {
    label: "WORKSPACE",
    items: [
      { id: "overview", name: "Overview", icon: LayoutDashboard },
      { id: "devices", name: "Devices", icon: Server },
      { id: "groups", name: "Device groups", icon: Layers },
    ],
  },
  {
    label: "PIPELINES",
    items: [
      { id: "configurations", name: "Configurations", icon: Workflow },
      { id: "deployments", name: "Deployments", icon: Radio },
      { id: "schedules", name: "Schedules", icon: CalendarDays },
      { id: "policies", name: "Agent policies", icon: Settings2 },
    ],
  },
  {
    label: "MANAGE",
    items: [
      { id: "enrollment", name: "Agents & enrollment", icon: KeyRound },
      { id: "issues", name: "Issues", icon: Activity },
      { id: "audit", name: "Audit log", icon: BookOpen },
      { id: "users", name: "Users & security", icon: Users },
      { id: "settings", name: "Instance settings", icon: Settings },
    ],
  },
];
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "small" : ""}`}>
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <path d="m2 5 13 23h5L7 5zM20 5l-6 11 5 9L30 5z" fill="currentColor" />
      </svg>
      <strong>vectory</strong>
    </span>
  );
}

function Auth({
  initialized,
  error: connectionError,
  onAuthenticated,
  retry,
}: {
  initialized: boolean | null;
  error: string;
  onAuthenticated: (u: User) => void;
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
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await post<any>(initialized ? "/login" : "/bootstrap", {
        name,
        email,
        password,
        ...(!initialized ? { bootstrap_secret: secret } : {}),
        ...(totp
          ? recovery
            ? { recovery_code: totp }
            : { totp_code: totp }
          : {}),
      });
      const parsed = SessionSchema.parse(result);
      setCSRF(parsed.csrf_token);
      setPassword("");
      setSecret("");
      onAuthenticated(parsed.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <Brand />
        <div className="auth-story-content">
          <span className="eyebrow">THE OPEN-SOURCE VECTOR CONTROL PLANE</span>
          <h1>
            Every pipeline
            <br />
            needs a <span>home.</span>
          </h1>
          <p>
            Build it visually. Deploy it confidently.
            <br />
            Keep your entire fleet in sync.
          </p>
          <div className="auth-art" aria-hidden="true">
            <div className="art-label">YOUR DATA. YOUR DIRECTION.</div>
            <div className="auth-art-grid">
              <div className="art-tile tile-blue">
                <Workflow size={59} strokeWidth={1.2} />
                <span>BUILD</span>
              </div>
              <div className="art-tile tile-orange">
                <ArrowRight size={67} strokeWidth={1.2} />
                <span>DEPLOY</span>
              </div>
              <div className="art-tile tile-cream">
                <Radio size={57} strokeWidth={1.3} />
                <span>OBSERVE</span>
              </div>
            </div>
            <div className="art-caption">
              <span>[ SOURCES → TRANSFORMS → SINKS ]</span>
              <span>01 — ∞</span>
            </div>
          </div>
        </div>
        <div className="auth-footer">
          <ShieldCheck size={16} /> Self-hosted. Outbound only. Fully yours.
        </div>
      </div>
      <main className="auth-form-side">
        <div className="auth-top">
          <span>Independent. Open source.</span>
          <Badge status="neutral">APACHE 2.0</Badge>
        </div>
        <div className="auth-form">
          <span className="auth-form-eyebrow">LET’S GET THINGS FLOWING</span>
          <h2>
            {initialized === false
              ? "A fresh start."
              : initialized === true
                ? "Welcome back."
                : "Your control plane."}
          </h2>
          <p>
            {initialized === false
              ? "Create the first administrator for your Vectory instance."
              : initialized === true
                ? "Sign in to manage your pipelines and devices."
                : "Connecting to your Vectory server…"}
          </p>
          {connectionError && (
            <ErrorBox message={connectionError} retry={retry} />
          )}
          <form onSubmit={submit}>
            {error && <ErrorBox message={error} />}
            <fieldset disabled={initialized === null || busy}>
              {initialized === false && (
                <>
                  <Field
                    label="One-time bootstrap secret"
                    hint="Read the locally provisioned secret on your server. No default password is created."
                  >
                    <input
                      required
                      autoComplete="off"
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="Your local initialization secret"
                    />
                  </Field>
                  <Field label="Your name">
                    <input
                      autoComplete="name"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Alex Morgan"
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
                  placeholder="you@your-company.com"
                />
              </Field>
              <Field
                label="Password"
                hint={
                  initialized === false
                    ? "Use at least 12 characters."
                    : undefined
                }
              >
                <input
                  required
                  type="password"
                  minLength={initialized === false ? 12 : undefined}
                  autoComplete={
                    initialized === false ? "new-password" : "current-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                />
              </Field>
              {initialized && (
                <Field
                  label={
                    recovery
                      ? "Recovery code"
                      : "Authenticator code (if enabled)"
                  }
                >
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={recovery ? 80 : 6}
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                    placeholder={
                      recovery ? "One-time recovery code" : "6-digit code"
                    }
                  />
                </Field>
              )}
              {initialized && (
                <button
                  className="text-link auth-recovery"
                  type="button"
                  onClick={() => {
                    setRecovery((v) => !v);
                    setTotp("");
                  }}
                >
                  {recovery
                    ? "Use an authenticator code"
                    : "Use a recovery code instead"}
                </button>
              )}
              <Button
                type="submit"
                icon={ArrowRight}
                busy={busy}
                className="full-width auth-submit"
              >
                {initialized === false
                  ? "Initialize workspace"
                  : "Sign in to Vectory"}
              </Button>
            </fieldset>
          </form>
          <div className="auth-note">
            <LockIcon />
            <p>
              Your browser session stays on this instance.
              <br />
              No external identity provider required.
            </p>
          </div>
        </div>
        <footer className="auth-legal">
          Vectory is an independent project for Vector by Datadog.
        </footer>
      </main>
    </div>
  );
}
function LockIcon() {
  return <ShieldCheck size={16} />;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [initialized, setInitialized] = useState<boolean | null>(null),
    [connectionError, setConnectionError] = useState(""),
    [checking, setChecking] = useState(true),
    [route, setRoute] = useState(location.hash.slice(2) || "overview"),
    [toast, setToast] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [dark, setDark] = useState(
      localStorage.getItem("vectory-theme") === "dark",
    ),
    [commandOpen, setCommandOpen] = useState(false),
    [query, setQuery] = useState(""),
    [help, setHelp] = useState(false);
  const [instanceName, setInstanceName] = useState("My workspace");
  useEffect(() => {
    if (!user) return;
    let active = true;
    api<{ instance_name: string }>("/settings")
      .then((value) => {
        if (active) setInstanceName(value.instance_name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.id]);
  const notify = useCallback((message: string) => setToast(message), []);
  const initialize = useCallback(async () => {
    setChecking(true);
    setConnectionError("");
    try {
      const status = await api<{ initialized: boolean }>("/status");
      setInitialized(status.initialized);
      if (status.initialized) {
        try {
          const session = await api("/session", {}, SessionSchema);
          setCSRF(session.csrf_token);
          setUser(session.user);
        } catch {
          setUser(null);
        }
      }
    } catch (e) {
      setConnectionError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("vectory-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const changed = () => {
      if (
        !window.dispatchEvent(
          new Event("vectory:before-navigate", { cancelable: true }),
        )
      ) {
        history.replaceState(null, "", "#/" + route);
        return;
      }
      setRoute(location.hash.slice(2) || "overview");
      setSidebar(false);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [route]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const navigate = useCallback((path: string) => {
    location.hash = "/" + path;
    setCommandOpen(false);
    setSidebar(false);
  }, []);
  async function logout() {
    if (
      !window.dispatchEvent(
        new Event("vectory:before-navigate", { cancelable: true }),
      )
    )
      return;
    try {
      await post("/logout");
      setUser(null);
      setCSRF("");
      notify("Signed out.");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  if (checking)
    return (
      <div className="app-loading">
        <Brand />
        <Spinner />
        <p>Connecting to your control plane</p>
      </div>
    );
  if (!user)
    return (
      <Auth
        initialized={initialized}
        error={connectionError}
        onAuthenticated={(u) => {
          setInitialized(true);
          setUser(u);
        }}
        retry={() => void initialize()}
      />
    );
  const [page, id] = route.split("/");
  const title =
    navigation.flatMap((g) => g.items).find((n) => n.id === page)?.name ||
    "Workspace";
  const allowed = (item: { id: string }) =>
    item.id !== "enrollment" || user.role === "admin";
  return (
    <div className={`app-shell ${sidebar ? "sidebar-open" : ""}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to main content
      </a>
      <aside className="sidebar">
        <button
          className="brand-link"
          onClick={() => navigate("overview")}
          aria-label="Vectory overview"
        >
          <Brand />
        </button>
        <button
          className="workspace-switch"
          onClick={() => navigate("settings")}
        >
          <span className="workspace-initial">V</span>
          <span>
            <strong title={instanceName}>{instanceName}</strong>
            <small>Self-hosted instance</small>
          </span>
          <ChevronRight size={15} />
        </button>
        <button className="sidebar-search" onClick={() => setCommandOpen(true)}>
          <Search size={15} />
          <span>Jump to…</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Main navigation">
          {navigation.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.filter(allowed).map((item) => (
                <button
                  aria-current={page === item.id ? "page" : undefined}
                  key={item.id}
                  className={page === item.id ? "active" : ""}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon size={18} strokeWidth={1.7} />
                  <span>{item.name}</span>
                  {page === item.id && <span className="nav-active-dot" />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            <span>A little guidance</span>
            <ArrowRight size={15} />
          </button>
          <div className="sidebar-instance">
            <span className="live-dot" />
            <span>Your infrastructure. Your rules.</span>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="app-main">
        <header className="topbar">
          <div>
            <IconButton
              icon={Menu}
              label="Toggle navigation"
              className="mobile-menu"
              onClick={() => setSidebar((v) => !v)}
            />
            <Breadcrumb>
              {title}
              {id && (
                <>
                  <ChevronRight size={12} />
                  Editor
                </>
              )}
            </Breadcrumb>
          </div>
          <div className="topbar-actions">
            <span className="instance-pill">
              <span className="live-dot" />
              SELF-HOSTED WORKSPACE
            </span>
            <span className="topbar-divider" />
            <IconButton
              icon={dark ? Sun : Moon}
              label={dark ? "Use light theme" : "Use dark theme"}
              onClick={() => setDark((v) => !v)}
            />
            <IconButton
              icon={CircleHelp}
              label="Help and documentation"
              onClick={() => setHelp(true)}
            />
            <div className="user-menu">
              <span className="user-avatar">
                {user.name?.slice(0, 2).toUpperCase() || "V"}
              </span>
              <div>
                <strong>{user.name}</strong>
                <small>{user.role}</small>
              </div>
              <IconButton
                icon={LogOut}
                label="Sign out"
                onClick={() => void logout()}
              />
            </div>
          </div>
        </header>
        <main
          key={route}
          id="main-content"
          tabIndex={-1}
          className={`page-content ${page === "configurations" && id ? "editor-content" : ""}`}
        >
          {page === "overview" ? (
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
                key={id}
                id={id}
                user={user}
                notify={notify}
                navigate={navigate}
              />
            ) : (
              <Configurations user={user} notify={notify} navigate={navigate} />
            )
          ) : page === "deployments" || page === "schedules" ? (
            <Deployments
              user={user}
              scheduled={page === "schedules"}
              notify={notify}
              navigate={navigate}
            />
          ) : page === "policies" ? (
            <Policies user={user} notify={notify} />
          ) : page === "enrollment" && user.role === "admin" ? (
            <Enrollment user={user} notify={notify} navigate={navigate} />
          ) : page === "issues" ? (
            <Issues navigate={navigate} />
          ) : page === "audit" ? (
            <AuditLog />
          ) : page === "users" ? (
            <UsersSecurity user={user} notify={notify} />
          ) : page === "settings" ? (
            <InstanceSettings />
          ) : (
            <ErrorBox message="This page is unavailable for your account." />
          )}
        </main>
      </div>
      {toast && (
        <div role="status" className="toast">
          <Check size={18} />
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
        onClose={() => setCommandOpen(false)}
        title="Jump to a page"
        description="Find a workspace view. Keyboard shortcut: Control or Command + K."
      >
        <div className="modal-body command-palette">
          <div className="search-field">
            <Search size={17} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Where would you like to go?"
              aria-label="Find a page"
            />
          </div>
          {navigation
            .flatMap((g) => g.items)
            .filter(allowed)
            .filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
            .map((item) => (
              <button key={item.id} onClick={() => navigate(item.id)}>
                <item.icon size={18} />
                {item.name}
                <ArrowRight size={16} />
              </button>
            ))}
        </div>
      </Modal>
      <Modal
        open={help}
        onClose={() => setHelp(false)}
        title="A little guidance"
        description="From your first device to a confidently deployed pipeline."
      >
        <div className="modal-body help-content">
          <p>
            <strong>1. Connect a device.</strong> Download an available native
            agent, create a scoped enrollment token, and enroll over verified
            HTTPS.
          </p>
          <p>
            <strong>2. Build a pipeline.</strong> Create a configuration,
            connect components visually, or import YAML, JSON, or TOML. Unknown
            fields are preserved.
          </p>
          <p>
            <strong>3. Publish and deploy.</strong> Publish an immutable
            version, select devices or groups, and review conflicts before
            activating.
          </p>
          <p>
            <strong>4. Observe what actually happened.</strong> The agent
            validates, applies, and verifies. An offline or verification-unknown
            device is never counted as a successful rollout.
          </p>
          <div className="hint-box">
            <ShieldCheck size={20} />
            <span>
              For installation, backups, recovery, and native compatibility, use
              the documentation shipped in this repository’s <code>docs/</code>{" "}
              directory.
            </span>
          </div>
          <a
            className="text-link"
            target="_blank"
            rel="noreferrer"
            href="https://vector.dev/docs/"
          >
            Vector documentation <ExternalLink size={14} />
          </a>
        </div>
      </Modal>
    </div>
  );
}
