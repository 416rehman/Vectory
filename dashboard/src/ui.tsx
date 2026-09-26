import {
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
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, when } from "./api";

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
    requestId = useRef(0);
  currentPath.current = path;
  initialValue.current = initial;
  const load = useCallback(async () => {
    if (!path || !mounted.current || currentPath.current !== path) return;
    const id = ++requestId.current;
    const current = () =>
      mounted.current &&
      currentPath.current === path &&
      requestId.current === id;
    try {
      const result = await api<T>(path);
      if (current())
        setState({ path, data: result, loading: false, error: "" });
    } catch (e) {
      if (current())
        setState((previous) => ({
          path,
          data: previous.path === path ? previous.data : initialValue.current,
          loading: false,
          error: (e as Error).message,
        }));
    }
  }, [path]);
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
    const timer = path ? setInterval(() => void load(), 15000) : undefined;
    return () => {
      mounted.current = false;
      ++requestId.current;
      clearInterval(timer);
    };
  }, [path, refresh, load]);
  // Hide old-resource data during the render before the new path's effect runs.
  const visible =
    state.path === path ? state : { data: initial, loading: !!path, error: "" };
  return {
    data: visible.data,
    loading: visible.loading,
    error: visible.error,
    reload: load,
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
  variant?: string;
  busy?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      {...props}
      className={`button ${variant} ${props.className || ""}`}
      disabled={props.disabled || busy}
    >
      {busy ? <Spinner /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
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
      <i />
      {children || status?.replaceAll("_", " ") || "Unknown"}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
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
      {retry && (
        <button onClick={retry}>
          Try again <RefreshCw size={14} />
        </button>
      )}
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
      <div className="empty-icon">
        <Icon size={25} />
      </div>
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
}: {
  title: string;
  description?: string;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal ${wide ? "wide" : ""}`}>
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
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-field">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
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
