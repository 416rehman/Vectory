import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  LoaderCircle,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  APIError,
  isSessionInterruption,
  isSessionValid,
  when,
  withRequestDeadline,
} from "./api";
import { HelpLink, type HelpDescriptor } from "./DocLink";

export function useResource<T>(path: string | null, initial: T, refresh = 0) {
  const [state, setState] = useState({
    path,
    data: initial,
    loading: !!path,
    error: "",
  });
  const currentPath = useRef(path),
    initialValue = useRef(initial),
    mounted = useRef(false),
    requestId = useRef(0),
    activeRequest = useRef<{ id: number; controller: AbortController } | null>(
      null,
    );
  currentPath.current = path;
  initialValue.current = initial;
  const load = useCallback(
    async (background = false) => {
      if (!path || !mounted.current || currentPath.current !== path) return;
      // A slow read must get a chance to finish. Only an explicit refresh replaces
      // an in-flight request; polling never invalidates its eventual response.
      if (background && activeRequest.current) return;
      activeRequest.current?.controller.abort();
      const id = ++requestId.current;
      const controller = new AbortController();
      activeRequest.current = { id, controller };
      const current = () =>
        mounted.current &&
        currentPath.current === path &&
        requestId.current === id;
      try {
        const result = await withRequestDeadline(
          (signal) => api<T>(path, { signal }),
          30000,
          controller.signal,
        );
        if (current()) {
          setState({ path, data: result, loading: false, error: "" });
          return result;
        }
      } catch (e) {
        // The re-sign-in dialog explains an ended session; keep this page as it
        // was and read again when the session resumes.
        if (isSessionInterruption(e)) return;
        if (current())
          setState((previous) => ({
            path,
            // A mismatched identity invalidates this resource's display until a
            // fresh matching read. Ordinary transient errors retain prior data.
            data:
              previous.path === path &&
              !(e instanceof APIError && e.code === "IDENTITY_MISMATCH")
                ? previous.data
                : initialValue.current,
            loading: false,
            error: (e as Error).message,
          }));
      } finally {
        if (activeRequest.current?.id === id) activeRequest.current = null;
      }
    },
    [path],
  );
  const reload = useCallback(async () => {
    await load();
  }, [load]);
  const reloadResult = useCallback(() => load(), [load]);
  useEffect(() => {
    mounted.current = true;
    ++requestId.current;
    setState((previous) => ({
      path,
      data: previous.path === path ? previous.data : initialValue.current,
      loading: !!path,
      error: "",
    }));
    void load();
    const timer = path ? setInterval(() => void load(true), 15000) : undefined;
    return () => {
      mounted.current = false;
      ++requestId.current;
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      clearInterval(timer);
    };
  }, [path, refresh, load]);
  useEffect(() => {
    const resumed = () => {
      if (isSessionValid()) void load();
    };
    window.addEventListener("vectory:session-changed", resumed);
    return () => window.removeEventListener("vectory:session-changed", resumed);
  }, [load]);
  // Hide old-resource data during the render before the new path's effect runs.
  const visible =
    state.path === path ? state : { data: initial, loading: !!path, error: "" };
  return {
    data: visible.data,
    loading: visible.loading,
    error: visible.error,
    reload,
    reloadResult,
  };
}
export function Spinner() {
  return <LoaderCircle className="spin" size={17} aria-label="Loading" />;
}
export function Button({
  children,
  variant = "",
  busy = false,
  icon: Icon,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  variant?: string;
  busy?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      {...props}
      type={props.type || "button"}
      className={`button ${variant} ${props.className || ""}`}
      disabled={props.disabled || busy}
    >
      {busy ? <Spinner /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}
// Keep read-only refresh actions consistent across pages, toolbars and panels.
export function RefreshButton({
  children = "Refresh",
  busy = false,
  ...props
}: Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className"
> & {
  children?: string;
  busy?: boolean;
}) {
  return (
    <Button
      {...props}
      variant="ghost compact"
      className="refresh-button"
      busy={busy}
      aria-busy={busy || undefined}
    >
      {children}
    </Button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      {...props}
      type={props.type || "button"}
      title={label}
      aria-label={label}
      className={`icon-button ${props.className || ""}`}
    >
      <Icon size={17} />
    </button>
  );
}
export function Badge({
  status,
  children,
}: {
  status?: string;
  children?: ReactNode;
}) {
  const positive = [
    "verified",
    "online",
    "verified_applied",
    "completed",
    "success",
    "active",
    "valid",
  ];
  const warning = [
    "paused",
    "scheduled",
    "verification_unknown",
    "unmanaged",
    "desired",
    "applying",
    "written",
    "reload_requested",
    "stale",
  ];
  const negative = [
    "failed",
    "offline",
    "revoked",
    "conflict",
    "missed",
    "error",
  ];
  const kind = positive.includes(status || "")
    ? "positive"
    : warning.includes(status || "")
      ? "warning"
      : negative.includes(status || "")
        ? "negative"
        : "neutral";
  return (
    <span className={`badge ${kind}`}>
      {children ||
        (
          {
            verified: "Up to date",
            verified_applied: "Up to date",
            online: "Connected",
            verification_unknown: "Needs verification",
            desired: "Update pending",
            reload_requested: "Restarting",
            written: "Applying",
            unmanaged: "No pipeline",
            unassigned: "Removed",
          } as Record<string, string>
        )[status || ""] ||
        status?.replaceAll("_", " ") ||
        "Unknown"}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
  help,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
  help?: HelpDescriptor;
}) {
  return (
    <header className="page-heading">
      <div>
        <div className="page-title-row">
          <h1>{title}</h1>
          {help && (
            <HelpLink {...help} label={help.label || `Help for ${title}`} />
          )}
        </div>
        {description && <p>{description}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </header>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && <RefreshButton onClick={retry}>Try again</RefreshButton>}
    </div>
  );
}
export function Empty({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  open,
  onClose,
  wide = false,
  returnFocusRef,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "wide" : ""} ${className}`}
          onCloseAutoFocus={
            returnFocusRef
              ? (event) => {
                  event.preventDefault();
                  const target = returnFocusRef.current;
                  // A resolved reminder can remove its opener in the same
                  // commit that closes this dialog. Check at autofocus time.
                  // A null ref deliberately hands focus to the next dialog.
                  if (target)
                    (target.isConnected &&
                    !target.matches(":disabled") &&
                    !target.closest("[inert]") &&
                    target.getClientRects().length > 0
                      ? target
                      : document.getElementById("main-content")
                    )?.focus();
                }
              : undefined
          }
        >
          <div className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className={!description ? "sr-only" : ""}>
                {description || title}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton icon={X} label="Close dialog" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const control = isValidElement<{
    id?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
  }>(children)
    ? children
    : null;
  const controlId = control?.props.id || id;
  return (
    <label className="field" htmlFor={controlId}>
      <span id={`${id}-label`}>{label}</span>
      {control
        ? cloneElement(control, {
            id: controlId,
            "aria-labelledby": control.props["aria-label"]
              ? control.props["aria-labelledby"]
              : control.props["aria-labelledby"] || `${id}-label`,
            "aria-describedby":
              [control.props["aria-describedby"], hint ? `${id}-hint` : ""]
                .filter(Boolean)
                .join(" ") || undefined,
          })
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </label>
  );
}
export function SearchBox({
  value,
  onChange,
  maxLength,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <div className="search-field">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <IconButton
          icon={X}
          label="Clear search"
          onClick={() => onChange("")}
        />
      )}
    </div>
  );
}
export function Stat({
  label,
  value,
  caption,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  caption: string;
  icon: LucideIcon;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <small>{caption}</small>
    </div>
  );
}
export function Panel({
  title,
  aside,
  children,
  className = "",
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-title">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
export function DateCell({ value }: { value?: string | null }) {
  return (
    <time dateTime={value || undefined} title={value || ""}>
      {when(value)}
    </time>
  );
}
export function Step({
  number,
  title,
  description,
  done,
  action,
}: {
  number: number;
  title: string;
  description: string;
  done?: boolean;
  action: () => void;
}) {
  return (
    <button className={`setup-step ${done ? "done" : ""}`} onClick={action}>
      <span className="step-number">
        {done ? <Check size={15} /> : String(number).padStart(2, "0")}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ArrowRight size={17} />
    </button>
  );
}
export function Breadcrumb({ children }: { children: ReactNode }) {
  return (
    <div className="breadcrumb">
      Workspace <ChevronRight size={12} /> {children}
    </div>
  );
}
export function Pagination({
  count,
  page,
  onPage,
  size = 12,
}: {
  count: number;
  page: number;
  onPage: (n: number) => void;
  size?: number;
}) {
  const pages = Math.max(1, Math.ceil(count / size));
  return (
    <div className="pagination">
      <span>
        {count === 0
          ? "No results"
          : `${(page - 1) * size + 1}–${Math.min(page * size, count)} of ${count}`}
      </span>
      <div>
        <button disabled={page === 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          {page} / {pages}
        </span>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
