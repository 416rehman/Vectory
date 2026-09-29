import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  Ban,
  CalendarClock,
  CalendarX,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CirclePlus,
  CircleX,
  Clock3,
  Copy,
  Eye,
  Info,
  LoaderCircle,
  Pause,
  Repeat2,
  RotateCw,
  RotateCcw,
  Search,
  SearchX,
  TriangleAlert,
  WifiOff,
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
import DocLink, {
  HelpLink,
  type DocTopic,
  type HelpDescriptor,
} from "./DocLink";
import {
  statusOf,
  type StatusDomain,
  type StatusIcon,
  type StatusTone,
} from "./status";
import { exactLocal, relativeTime } from "./time";
import { isSingleKey, useSingleKeyShortcuts } from "./shortcutPreference";

export const DEFAULT_POLL_INTERVAL = 15000;
const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Bounded, cancellable reads that poll while the tab is visible.
 * Background polls never supersede an in-flight read; an explicit refresh does.
 * A failed refresh keeps the last loaded data with an error.
 * `interval: 0` reads once (static data); changing the interval only
 * reschedules the next poll.
 */
export function useResource<T>(
  path: string | null,
  initial: T,
  refresh = 0,
  options: { interval?: number } = {},
) {
  const interval = options.interval ?? DEFAULT_POLL_INTERVAL;
  const [state, setState] = useState<{
    path: string | null;
    data: T;
    loading: boolean;
    error: string;
    /** The HTTP status of the failed read, when the server answered. */
    errorStatus: number | null;
    updatedAt: number | null;
  }>({
    path,
    data: initial,
    loading: !!path,
    error: "",
    errorStatus: null,
    updatedAt: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const currentPath = useRef(path),
    initialValue = useRef(initial),
    mounted = useRef(false),
    requestId = useRef(0),
    lastSuccess = useRef(0),
    activeRequest = useRef<{
      id: number;
      controller: AbortController;
      explicit: boolean;
    } | null>(null);
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
      activeRequest.current = { id, controller, explicit: !background };
      if (!background) setRefreshing(true);
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
          lastSuccess.current = Date.now();
          setState({
            path,
            data: result,
            loading: false,
            error: "",
            errorStatus: null,
            updatedAt: lastSuccess.current,
          });
          return result;
        }
      } catch (e) {
        // The re-sign-in dialog explains an ended session; keep this page as it
        // was and read again when the session resumes.
        if (isSessionInterruption(e)) return;
        if (current())
          setState((previous) => {
            const same = previous.path === path;
            const keep =
              same &&
              !(e instanceof APIError && e.code === "IDENTITY_MISMATCH");
            return {
              path,
              // A mismatched identity invalidates this resource's display until
              // a fresh matching read. Ordinary transient errors keep prior data.
              data: keep ? previous.data : initialValue.current,
              loading: false,
              error: (e as Error).message,
              errorStatus:
                e instanceof APIError && e.status > 0 ? e.status : null,
              updatedAt: keep ? previous.updatedAt : null,
            };
          });
      } finally {
        if (activeRequest.current?.id === id) {
          activeRequest.current = null;
          if (mounted.current) setRefreshing(false);
        }
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
    setState((previous) => {
      // A refresh of data already on screen is not a first load: keep the
      // data, its error and `loading: false` until the new read settles.
      const same = previous.path === path;
      const loaded = same && previous.updatedAt !== null;
      return {
        path,
        data: same ? previous.data : initialValue.current,
        loading: !!path && !loaded,
        error: loaded ? previous.error : "",
        errorStatus: loaded ? previous.errorStatus : null,
        updatedAt: same ? previous.updatedAt : null,
      };
    });
    void load();
    const renewed = () => {
      if (isSessionValid()) void load();
    };
    window.addEventListener("vectory:session-changed", renewed);
    return () => {
      mounted.current = false;
      ++requestId.current;
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      window.removeEventListener("vectory:session-changed", renewed);
    };
  }, [path, refresh, load]);
  useEffect(() => {
    if (!path || !(interval > 0)) return;
    // Hidden tabs stop polling; returning to the tab refreshes stale data.
    const timer = setInterval(() => {
      if (visible()) void load(true);
    }, interval);
    const returned = () => {
      if (visible() && Date.now() - lastSuccess.current > interval / 2)
        void load(true);
    };
    document.addEventListener("visibilitychange", returned);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [path, load, interval]);
  // Hide old-resource data during the render before the new path's effect runs.
  const shown =
    state.path === path
      ? state
      : {
          data: initial,
          loading: !!path,
          error: "",
          errorStatus: null,
          updatedAt: null,
        };
  return {
    data: shown.data,
    loading: shown.loading,
    error: shown.error,
    errorStatus: shown.errorStatus,
    updatedAt: shown.updatedAt,
    refreshing: refreshing && state.path === path,
    reload,
    reloadResult,
  };
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const changed = () => setMatches(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [query]);
  return matches;
}

/**
 * The current time, re-rendering on a cadence: every `every` ms (countdowns),
 * or one suited to a relative time ("4s ago") since `reference`.
 */
export function useNow(
  reference?: number | null,
  { every, active = true }: { every?: number; active?: boolean } = {},
) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const age = reference ? Date.now() - reference : 0;
    const timer = setTimeout(
      () => setNow(Date.now()),
      every ?? (age < 60000 ? 1000 : 15000),
    );
    return () => clearTimeout(timer);
  }, [reference, now, every, active]);
  return now;
}

export function Spinner({
  size = 16,
  label = "Loading",
}: {
  size?: number;
  label?: string;
}) {
  return <LoaderCircle className="spin" size={size} aria-label={label} />;
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
      {busy ? <Spinner size={15} /> : Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}
/** A read-only refresh action. Prefer LiveStatus in page headers. */
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
      icon={RotateCw}
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
  tooltip,
  shortcut,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  icon: LucideIcon;
  label: string;
  /** Show a styled tooltip instead of the native title. */
  tooltip?: boolean | "left" | "right" | "top" | "bottom";
  shortcut?: string[];
}) {
  const button = (
    <button
      {...props}
      type={props.type || "button"}
      title={tooltip ? undefined : label}
      aria-label={label}
      className={`icon-button ${props.className || ""}`}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
  return tooltip ? (
    <Tooltip
      content={label}
      shortcut={shortcut}
      side={tooltip === true ? "top" : tooltip}
    >
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/* ---------- Copy ---------- */

/**
 * The one copy action: the label turns into a confirmation, a status line
 * tells screen readers, and a refusal (no clipboard access) is said out loud
 * and, unless the caller shows its own fallback, written next to the button.
 */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  copiedMessage,
  failedMessage = "Copy isn't available here. Select the text to copy it.",
  variant = "secondary compact",
  ariaLabel,
  onCopied,
  onFailed,
}: {
  /** Read when the button is pressed, so it can reflect the latest value. */
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  /** What assistive tech hears after a copy; defaults to the label plus a period. */
  copiedMessage?: string;
  /** Empty when the caller shows its own selectable fallback (onFailed). */
  failedMessage?: string;
  variant?: string;
  /** A name that says what is copied, when the visible label cannot. */
  ariaLabel?: string;
  onCopied?: () => void;
  onFailed?: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <button
        type="button"
        className={`button ${variant} copy-button`}
        aria-label={ariaLabel}
        onClick={async () => {
          clearTimeout(timer.current);
          let next: "copied" | "failed" = "copied";
          try {
            await navigator.clipboard.writeText(
              typeof text === "function" ? text() : text,
            );
          } catch {
            next = "failed";
          }
          setState(next);
          if (next === "copied") onCopied?.();
          else onFailed?.();
          timer.current = setTimeout(
            () => setState("idle"),
            next === "copied" ? 2400 : 8000,
          );
        }}
      >
        {state === "copied" ? (
          <Check size={15} aria-hidden="true" />
        ) : (
          <Copy size={15} aria-hidden="true" />
        )}
        {state === "copied" ? copiedLabel : label}
      </button>
      <span
        className={
          state === "failed" && failedMessage ? "copy-note" : "sr-only"
        }
        role="status"
      >
        {state === "copied"
          ? (copiedMessage ?? `${copiedLabel}.`)
          : state === "failed"
            ? failedMessage
            : ""}
      </span>
    </>
  );
}

/**
 * When the clipboard refuses a copy that has no button of its own (the
 * canvas copies steps from its toolbar or a shortcut), the text waits here,
 * selected, for the person to copy it themselves.
 */
export function CopyFallbackDialog({
  text,
  label,
  subject,
  onClose,
}: {
  text: string;
  /** Names the text field, e.g. "Vector YAML for 2 steps". */
  label: string;
  /** What the text is, as the sentence's subject: "The YAML". */
  subject: string;
  onClose: () => void;
}) {
  const keys = isMacPlatform() ? "⌘C" : "Ctrl+C";
  return (
    <Modal
      open
      onClose={onClose}
      title="Couldn’t copy"
      description={`This browser blocks clipboard access on this address. ${subject} is selected below. Press ${keys} to copy it.`}
      className="copy-fallback"
    >
      <div className="modal-body">
        <textarea
          className="copy-fallback-text"
          readOnly
          spellCheck={false}
          value={text}
          rows={Math.min(14, Math.max(4, text.split("\n").length))}
          aria-label={label}
          data-autofocus
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <div className="modal-footer">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

/* ---------- Keyboard hints ---------- */

export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}
const keyNames = (mac: boolean): Record<string, string> => ({
  mod: mac ? "⌘" : "Ctrl",
  shift: mac ? "⇧" : "Shift",
  alt: mac ? "⌥" : "Alt",
  enter: "↵",
  esc: "Esc",
  up: "↑",
  down: "↓",
});
/** "mod+K" style keys → the platform's labels, e.g. ⌘K or Ctrl K. */
export function shortcutLabel(keys: string[], mac = isMacPlatform()) {
  const names = keyNames(mac);
  const parts = keys.map((key) => names[key.toLowerCase()] ?? key);
  return mac && keys[0]?.toLowerCase() === "mod"
    ? parts.join("")
    : parts.join(" ");
}
export function Kbd({
  keys,
  className = "",
}: {
  keys: string | string[];
  className?: string;
}) {
  const list = Array.isArray(keys) ? keys : [keys];
  return (
    <kbd className={`kbd ${className}`.trim()} aria-hidden="true">
      {shortcutLabel(list)}
    </kbd>
  );
}

/* ---------- Tooltip ---------- */

type TooltipSide = "top" | "bottom" | "left" | "right";
let lastTooltipClosed = 0;
/**
 * Hover (after a short delay) or keyboard focus shows a label; Escape, leaving
 * or pressing the trigger hides it. The trigger keeps its own accessible name.
 */
export function Tooltip({
  content,
  side = "top",
  shortcut,
  children,
  disabled = false,
  delay = 450,
}: {
  content: ReactNode;
  side?: TooltipSide;
  shortcut?: string[];
  children: ReactElement<any>;
  disabled?: boolean;
  delay?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // A single-key hint is only true while single-key shortcuts are on.
  const [singleKeys] = useSingleKeyShortcuts();
  const keys =
    shortcut && (singleKeys || !isSingleKey(shortcut)) ? shortcut : undefined;
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    side: TooltipSide;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressed = useRef(false);
  const show = (immediate: boolean) => {
    if (disabled || suppressed.current) return;
    clearTimeout(timer.current);
    const wait = immediate || Date.now() - lastTooltipClosed < 400 ? 0 : delay;
    timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen((was) => {
      if (was) lastTooltipClosed = Date.now();
      return false;
    });
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !tip.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = tip.current.getBoundingClientRect();
    const gap = 8,
      margin = 8;
    const fits = (candidate: TooltipSide) =>
      candidate === "top"
        ? anchor.top - box.height - gap >= margin
        : candidate === "bottom"
          ? anchor.bottom + box.height + gap <= innerHeight - margin
          : candidate === "left"
            ? anchor.left - box.width - gap >= margin
            : anchor.right + box.width + gap <= innerWidth - margin;
    const opposite: Record<TooltipSide, TooltipSide> = {
      top: "bottom",
      bottom: "top",
      left: "right",
      right: "left",
    };
    const chosen = fits(side)
      ? side
      : fits(opposite[side])
        ? opposite[side]
        : side;
    let top =
      chosen === "top"
        ? anchor.top - box.height - gap
        : chosen === "bottom"
          ? anchor.bottom + gap
          : anchor.top + anchor.height / 2 - box.height / 2;
    let left =
      chosen === "left"
        ? anchor.left - box.width - gap
        : chosen === "right"
          ? anchor.right + gap
          : anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.min(Math.max(margin, left), innerWidth - box.width - margin);
    top = Math.min(Math.max(margin, top), innerHeight - box.height - margin);
    setPosition({ top, left, side: chosen });
  }, [open, side, content]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const scrolled = () => hide();
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [open]);
  if (!isValidElement(children)) return children;
  const element = children as ReactElement<Record<string, any>>;
  const props = element.props;
  const labelled =
    typeof content === "string" && props["aria-label"] === content;
  const call = (name: string, event: unknown) => props[name]?.(event);
  const childRef = props.ref;
  const setRef = (node: HTMLElement | null) => {
    trigger.current = node;
    if (typeof childRef === "function") childRef(node);
    else if (childRef && typeof childRef === "object") childRef.current = node;
  };
  return (
    <>
      {cloneElement(element, {
        ref: setRef,
        "aria-describedby":
          open && !labelled
            ? [props["aria-describedby"], id].filter(Boolean).join(" ")
            : props["aria-describedby"],
        "aria-keyshortcuts":
          props["aria-keyshortcuts"] ??
          (keys
            ? keys
                .join("+")
                .replace(/^mod/i, isMacPlatform() ? "Meta" : "Control")
            : undefined),
        onPointerEnter: (event: React.PointerEvent) => {
          call("onPointerEnter", event);
          if (event.pointerType === "mouse") show(false);
        },
        onPointerLeave: (event: React.PointerEvent) => {
          call("onPointerLeave", event);
          suppressed.current = false;
          hide();
        },
        onPointerDown: (event: React.PointerEvent) => {
          call("onPointerDown", event);
          suppressed.current = true;
          hide();
        },
        onFocus: (event: React.FocusEvent<HTMLElement>) => {
          call("onFocus", event);
          if (event.currentTarget.matches(":focus-visible")) show(true);
        },
        onBlur: (event: React.FocusEvent) => {
          call("onBlur", event);
          suppressed.current = false;
          hide();
        },
      })}
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="tooltip"
            data-side={position?.side ?? side}
            style={{
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
            }}
          >
            <span>{content}</span>
            {keys && <Kbd keys={keys} />}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ---------- Status ---------- */

const statusIcons: Record<StatusIcon, LucideIcon> = {
  check: CircleCheck,
  progress: LoaderCircle,
  clock: Clock3,
  pause: Pause,
  minus: CircleMinus,
  offline: WifiOff,
  online: CircleDot,
  x: CircleX,
  undo: RotateCcw,
  question: CircleHelp,
  ban: Ban,
  alert: TriangleAlert,
  calendar: CalendarClock,
  "calendar-x": CalendarX,
  eye: Eye,
  repeat: Repeat2,
  plus: CirclePlus,
  dot: CircleDot,
};
const toneIcons: Record<StatusTone, StatusIcon> = {
  success: "check",
  warning: "alert",
  danger: "x",
  info: "progress",
  neutral: "dot",
};
/**
 * The one way to show a state: icon + label, tinted by tone. A backend state
 * reads from status.ts (domain + value); a local outcome with no domain passes
 * its own tone and label.
 */
export function StatusBadge({
  domain,
  value = "",
  label,
  tone,
  icon,
  description,
  appearance = "chip",
  className = "",
}: {
  label?: ReactNode;
  tone?: StatusTone;
  icon?: StatusIcon;
  description?: string;
  appearance?: "chip" | "text";
  className?: string;
} & (
  | { domain: StatusDomain; value: string }
  | { domain?: undefined; value?: string; tone: StatusTone; label: ReactNode }
)) {
  const status = domain ? statusOf(domain, value) : null;
  const shownTone = tone ?? status?.tone ?? "neutral";
  const shownIcon = icon ?? status?.icon ?? toneIcons[shownTone];
  const Icon = statusIcons[shownIcon];
  const about = description ?? status?.description;
  // What the state means: a screen reader reads it as the badge's
  // description, a pointer sees it as a tooltip (a native title reached
  // neither keyboard nor assistive-technology users reliably).
  const badge = (
    <span
      className={`status-badge ${className}`.trim()}
      data-tone={shownTone}
      data-appearance={appearance}
      data-state={value || undefined}
      data-icon={shownIcon}
      aria-description={about || undefined}
    >
      <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
      <span>{label ?? status?.label}</span>
    </span>
  );
  return about ? <Tooltip content={about}>{badge}</Tooltip> : badge;
}

/* ---------- Page chrome ---------- */

export type ShellTab = {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
};
export type ShellInfo = {
  sectionLabel: string;
  sectionHref: string;
  tabs: ShellTab[];
  currentTab?: string;
  tabsLabel?: string;
};
/** Provided by the app shell so every PageHeader places crumbs and tabs alike. */
export const ShellContext = createContext<ShellInfo | null>(null);
export type Crumb = {
  label: string;
  href?: string;
  /** Handles a plain click in place (the href still opens in a new tab). */
  onClick?: () => void;
};
export type LiveState = {
  updatedAt: number | null;
  error?: string;
  loading?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
};

export function PageHeader({
  title,
  description,
  children,
  help,
  meta,
  breadcrumb,
  live,
  showTabs = true,
  titleAside,
  headingRef,
  documentTitle,
  loadingTitle = false,
}: {
  title: string;
  /** Beside the title, such as a version chip. */
  titleAside?: ReactNode;
  /** The title is not known yet: show a placeholder bar (the text stays for screen readers). */
  loadingTitle?: boolean;
  /** The title element; it is always focusable for moves after navigation. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** The browser tab title's leading part, when it differs from the title. */
  documentTitle?: string;
  description?: ReactNode;
  children?: ReactNode;
  help?: HelpDescriptor;
  meta?: ReactNode;
  breadcrumb?: Crumb[];
  live?: LiveState;
  showTabs?: boolean;
}) {
  const shell = useContext(ShellContext);
  const inSection =
    !!shell && shell.tabs.some((tab) => tab.id === shell.currentTab);
  // One rule everywhere: section tabs already say where you are, so only
  // drill-down pages (a device, a deployment) show a breadcrumb trail.
  const ancestors = breadcrumb ?? [];
  const crumbs: Crumb[] = ancestors.length
    ? [...ancestors, { label: title }]
    : [];
  const tabTitle = documentTitle ?? title;
  useEffect(() => {
    if (!shell) return;
    const parts = [tabTitle];
    if (shell.sectionLabel && shell.sectionLabel !== tabTitle)
      parts.push(shell.sectionLabel);
    document.title = [...parts, "Vectory"].join(" · ");
  }, [tabTitle, shell?.sectionLabel]);
  return (
    <>
      <div className="page-context">
        {crumbs.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className="page-breadcrumb">
              {crumbs.map((crumb, index) => (
                <li key={`${index}:${crumb.label}`}>
                  {index === crumbs.length - 1 ? (
                    <span aria-current="page">{crumb.label}</span>
                  ) : crumb.href ? (
                    <a
                      href={crumb.href}
                      onClick={
                        crumb.onClick
                          ? (event) => {
                              if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey
                              )
                                return;
                              event.preventDefault();
                              crumb.onClick!();
                            }
                          : undefined
                      }
                    >
                      {crumb.label}
                    </a>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {live && <LiveStatus {...live} />}
      </div>
      <header className="page-heading">
        <div>
          <div className="page-title-row">
            <h1 ref={headingRef} tabIndex={-1} className="page-title-focus">
              {loadingTitle ? (
                <>
                  <span className="sr-only">{title}</span>
                  <Skeleton width={220} height={20} />
                </>
              ) : (
                title
              )}
            </h1>
            {titleAside}
            {help && (
              <HelpLink {...help} label={help.label || `Help for ${title}`} />
            )}
          </div>
          {description && <p>{description}</p>}
          {meta && <div className="page-meta">{meta}</div>}
        </div>
        {children && <div className="page-actions">{children}</div>}
      </header>
      {showTabs && shell && inSection && shell.tabs.length > 1 && (
        <SectionTabs shell={shell} />
      )}
    </>
  );
}
function SectionTabs({ shell }: { shell: ShellInfo }) {
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    // Scroll only the strip. scrollIntoView would also move the sequential
    // focus start, so the first Tab would skip the skip link and the shell.
    const nav = list.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const left =
      active.getBoundingClientRect().left -
      nav.getBoundingClientRect().left +
      nav.scrollLeft;
    if (
      left < nav.scrollLeft ||
      left + active.offsetWidth > nav.scrollLeft + nav.clientWidth
    )
      nav.scrollLeft = Math.max(0, left - 16);
  }, [shell.currentTab]);
  return (
    <nav
      ref={list}
      className="page-tabs"
      aria-label={shell.tabsLabel || `${shell.sectionLabel} sections`}
    >
      {shell.tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          aria-current={shell.currentTab === tab.id ? "page" : undefined}
        >
          <span className="tab-label">
            <tab.icon size={15} aria-hidden="true" focusable="false" />
            <span>{tab.label}</span>
          </span>
        </a>
      ))}
    </nav>
  );
}

/** "● Live · updated 4s ago" with a refresh action; amber when a read failed. */
export function LiveStatus({
  updatedAt,
  error,
  loading,
  refreshing,
  onRefresh,
}: LiveState) {
  const now = useNow(updatedAt);
  const stale = !!error;
  const text =
    loading && !updatedAt
      ? "Connecting…"
      : stale
        ? updatedAt
          ? `Stale · last update ${relativeTime(updatedAt, now)}`
          : "Couldn't load"
        : updatedAt
          ? `Updated ${relativeTime(updatedAt, now)}`
          : "Waiting for data";
  return (
    <div
      className="live-status"
      data-state={stale ? "stale" : loading && !updatedAt ? "loading" : "live"}
    >
      <span className="live-status-dot" aria-hidden="true" />
      <span className="live-status-label">
        {!stale && updatedAt ? (
          <span className="live-status-live">Live</span>
        ) : null}
        <span
          title={
            updatedAt
              ? exactLocal(new Date(updatedAt).toISOString())
              : error || undefined
          }
        >
          {text}
        </span>
      </span>
      {onRefresh && (
        <Tooltip content="Refresh now" shortcut={["R"]} side="bottom">
          <button
            type="button"
            className="live-status-refresh"
            aria-label="Refresh now"
            aria-busy={refreshing || undefined}
            data-live-refresh=""
            // Stays enabled: a new explicit refresh replaces a slow one.
            onClick={() => onRefresh()}
          >
            <RotateCw
              size={14}
              className={refreshing ? "spin" : undefined}
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export function PageToolbar({
  search,
  children,
  filters,
  count,
}: {
  search?: ReactNode;
  children?: ReactNode;
  filters?: ReactNode;
  count?: ReactNode;
}) {
  return (
    <div className="page-toolbar">
      <div className="page-toolbar-row">
        <div className="page-toolbar-main">
          {search}
          {count && <span className="page-toolbar-count">{count}</span>}
        </div>
        {children && <div className="page-toolbar-side">{children}</div>}
      </div>
      {filters}
    </div>
  );
}

export type FilterChip = {
  id: string;
  label: ReactNode;
  text: string;
  onRemove: () => void;
};
export function FilterChips({
  chips,
  onClearAll,
  clearLabel = "Clear all",
  clearFrom = 2,
}: {
  chips: FilterChip[];
  onClearAll?: () => void;
  clearLabel?: string;
  /** Show the clear action once this many chips are active. */
  clearFrom?: number;
}) {
  if (!chips.length) return null;
  return (
    <div className="filter-chips" role="group" aria-label="Active filters">
      {chips.map((chip) => (
        <span key={chip.id} className="filter-chip">
          <span>{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove filter ${chip.text}`}
            onClick={chip.onRemove}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      {onClearAll && chips.length >= clearFrom && (
        <button
          type="button"
          className="filter-chips-clear"
          onClick={onClearAll}
        >
          {clearLabel}
        </button>
      )}
    </div>
  );
}

/** Quick filter presets shown as a segmented row of toggle chips. */
export function QuickFilters<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value: T | "";
  onChange: (value: T | "") => void;
}) {
  return (
    <div className="quick-filters" role="group" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? "" : option.value)}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="quick-filter-count">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Exactly one choice from a small set, as an inline radio group. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Why the choice is unavailable, shown when disabled. */
  hint?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  function move(from: number, step: number) {
    const next = (from + step + options.length) % options.length;
    onChange(options[next].value);
    group.current
      ?.querySelectorAll<HTMLButtonElement>("[role='radio']")
      [next]?.focus();
  }
  return (
    <div
      ref={group}
      className="segmented"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={disabled ? hint : undefined}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (["ArrowRight", "ArrowDown"].includes(event.key)) {
                event.preventDefault();
                move(index, 1);
              } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                move(index, -1);
              }
            }}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="segmented-count">
                {option.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Feedback ---------- */

export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <span>{message}</span>
      {retry && (
        <Button variant="ghost compact" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
/**
 * The one failed-read message: what couldn't load, how old the data on screen
 * is, the server's reason (inline when nothing else is shown, otherwise behind
 * Details), and one retry.
 */
export function InlineError({
  title,
  error,
  updatedAt,
  retry,
  retrying,
}: {
  title: string;
  error: string;
  updatedAt?: number | null;
  retry?: () => void;
  retrying?: boolean;
}) {
  const now = useNow(updatedAt);
  return (
    <div className="inline-error" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <div className="inline-error-copy">
        <strong>{title}</strong>
        {updatedAt ? (
          <span> Showing data from {relativeTime(updatedAt, now)}.</span>
        ) : (
          // Nothing else is on screen, so the reason is the message.
          error && <span> {error}</span>
        )}
        {updatedAt && error && (
          <details>
            <summary>Details</summary>
            <span>{error}</span>
          </details>
        )}
      </div>
      {retry && (
        <Button variant="secondary compact" busy={retrying} onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
export function EmptyState({
  variant = "first-run",
  icon: Icon,
  title,
  children,
  action,
  secondaryAction,
  learnMore,
}: {
  variant?: "first-run" | "filtered" | "error" | "quiet";
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  learnMore?: { topic: DocTopic; section?: string; label?: string };
}) {
  const Glyph =
    Icon ??
    (variant === "filtered"
      ? SearchX
      : variant === "error"
        ? AlertCircle
        : Info);
  return (
    <div className="empty-state" data-variant={variant}>
      <span className="empty-state-icon" aria-hidden="true">
        <Glyph size={variant === "first-run" ? 20 : 18} strokeWidth={1.8} />
      </span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {(action || secondaryAction) && (
        <div className="empty-state-actions">
          {action}
          {secondaryAction}
        </div>
      )}
      {learnMore && (
        <DocLink
          topic={learnMore.topic}
          section={learnMore.section}
          className="empty-state-link"
        >
          {learnMore.label || "Learn how"}
        </DocLink>
      )}
    </div>
  );
}
export function Skeleton({
  width = "100%",
  height = 12,
  radius,
  className = "",
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}) {
  return (
    <span
      className={`skeleton ${className}`.trim()}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

/* ---------- Disclosure and form controls ---------- */

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  meta,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={`disclosure ${className}`.trim()}
      open={defaultOpen || undefined}
    >
      <summary>
        <ChevronRight
          className="disclosure-chevron"
          size={15}
          aria-hidden="true"
        />
        <span className="disclosure-label">{summary}</span>
        {meta && <span className="disclosure-meta">{meta}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
export function Select({
  className = "",
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  ref?: React.Ref<HTMLSelectElement>;
}) {
  return <select {...props} className={`select ${className}`.trim()} />;
}

/* ---------- Dialog ---------- */

const focusable = (
  element: HTMLElement | null | undefined,
): element is HTMLElement =>
  !!element &&
  element.isConnected &&
  !element.matches(":disabled") &&
  !element.closest("[inert]") &&
  element.getClientRects().length > 0;
function initialTarget(content: HTMLElement) {
  const fields = content.querySelectorAll<HTMLElement>(
    '.modal-body :is(input:not([type="hidden"]):not([readonly]), select, textarea:not([readonly]), [role="combobox"], [data-autofocus])',
  );
  const field = [...fields].find(focusable);
  if (field) return field;
  const actions = [
    ...content.querySelectorAll<HTMLElement>(
      ".modal-footer .button, .modal-footer a.button",
    ),
  ].filter(focusable);
  const primary = actions
    .filter((action) => !action.matches(".secondary, .ghost"))
    .at(-1);
  // Never land on a destructive confirmation; prefer the safe choice.
  if (primary && !primary.matches(".danger, .danger-ghost")) return primary;
  return actions.find((action) => action.matches(".secondary, .ghost")) ?? null;
}
export function Modal({
  title,
  description,
  children,
  open,
  onClose,
  wide = false,
  size,
  returnFocusRef,
  initialFocus = "first-field",
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  initialFocus?: "first-field" | "none" | React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const unmounted = useRef(false);
  // Remember the opener while rendering the opening frame: a field with
  // autoFocus inside the dialog takes focus before any effect could look.
  if (open && !openRef.current) opener.current = null;
  if (open && !opener.current && typeof document !== "undefined") {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !content.current?.contains(active)
    )
      opener.current = active;
  }
  openRef.current = open;
  useEffect(() => {
    // StrictMode runs this cleanup and then the effect again on a live
    // dialog; only a cleanup with no rerun is a real unmount.
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);
  function restoreFocus() {
    // A development remount of the focus scope is not a real close.
    if (openRef.current && !unmounted.current && content.current?.isConnected)
      return;
    if (returnFocusRef) {
      const target = returnFocusRef.current;
      // A resolved reminder can remove its opener in the same commit that closes
      // this dialog. A null ref deliberately hands focus to the next dialog.
      if (!target) return;
      (focusable(target)
        ? target
        : document.getElementById("main-content")
      )?.focus();
      return;
    }
    const target = opener.current;
    if (
      document.activeElement &&
      document.activeElement !== document.body &&
      !content.current?.contains(document.activeElement)
    )
      return;
    (focusable(target)
      ? target
      : document.getElementById("main-content")
    )?.focus();
  }
  const sizeClass = wide
    ? "modal-xl"
    : size && size !== "md"
      ? `modal-${size}`
      : "";
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          ref={content}
          className={`modal ${wide ? "wide" : ""} ${sizeClass} ${className}`}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            if (
              !opener.current &&
              active instanceof HTMLElement &&
              active !== document.body &&
              !content.current?.contains(active)
            )
              opener.current = active;
            const node = content.current;
            if (!node) return;
            const target =
              typeof initialFocus === "object"
                ? initialFocus.current
                : initialFocus === "first-field"
                  ? initialTarget(node)
                  : null;
            event.preventDefault();
            (target ?? node).focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
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
  label,
  shortcut = false,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
  label?: string;
  /** Focus with "/" and show the hint. */
  shortcut?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [singleKeys] = useSingleKeyShortcuts();
  const hint = shortcut && singleKeys;
  return (
    <div className="search-field">
      <Search size={15} aria-hidden="true" />
      <input
        ref={inputRef}
        aria-label={label || placeholder}
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        data-page-search={shortcut ? "" : undefined}
        aria-keyshortcuts={hint ? "/" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? (
        <IconButton
          icon={X}
          label="Clear search"
          onClick={() => onChange("")}
        />
      ) : hint ? (
        <Kbd keys="/" className="search-field-kbd" />
      ) : null}
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
    <time dateTime={value || undefined} title={value ? exactLocal(value) : ""}>
      {when(value)}
    </time>
  );
}
/** A relative time ("4m ago") with the exact local time on hover. */
export function TimeAgo({
  value,
  fallback = "Never",
}: {
  value?: string | null;
  fallback?: string;
}) {
  const now = useNow(value ? Date.parse(value) : null);
  if (!value || !Number.isFinite(Date.parse(value)))
    return <span>{fallback}</span>;
  return (
    <time dateTime={value} title={exactLocal(value)}>
      {relativeTime(value, now)}
    </time>
  );
}
export function Pagination({
  count,
  page,
  onPage,
  size = 12,
  sizeOptions,
  onSize,
  noun = "results",
  alwaysShow = false,
}: {
  count: number;
  page: number;
  onPage: (n: number) => void;
  size?: number;
  sizeOptions?: number[];
  onSize?: (size: number) => void;
  noun?: string;
  /** Keep the controls when everything fits on one page. */
  alwaysShow?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(count / size));
  if (!alwaysShow && page <= 1 && pages <= 1) return null;
  return (
    <div className="pagination">
      <span>
        {count === 0
          ? `No ${noun}`
          : `${((page - 1) * size + 1).toLocaleString()}–${Math.min(page * size, count).toLocaleString()} of ${count.toLocaleString()}`}
      </span>
      <div>
        {sizeOptions && onSize && (
          <label>
            <span>Rows</span>
            <select
              aria-label="Rows per page"
              value={size}
              onChange={(event) => onSize(Number(event.target.value))}
            >
              {sizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}
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
