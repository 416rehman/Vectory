import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import "./toast.css";

export type ToastTone = "success" | "error" | "info";
export type ToastAction =
  | { label: string; onClick: () => void; href?: never }
  | { label: string; href: string; onClick?: never };
export type ToastOptions = {
  action?: ToastAction;
  /** Milliseconds before an automatic dismissal; errors persist by default. */
  duration?: number | null;
};
/** What a page's `notify` accepts: the tone is stated, never guessed. */
export type NotifyOptions = ToastOptions & { tone?: ToastTone };
export type Notify = (message: string, options?: NotifyOptions) => void;
export type ToastItem = {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
  duration: number | null;
};

const MAX_TOASTS = 3;
const DEFAULT_DURATION = 5000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
function show(tone: ToastTone, message: string, options: ToastOptions = {}) {
  const item: ToastItem = {
    id: nextId++,
    tone,
    message,
    action: options.action,
    duration:
      options.duration !== undefined
        ? options.duration
        : tone === "error"
          ? null
          : DEFAULT_DURATION,
  };
  // Replace an identical visible message instead of stacking duplicates.
  items = evict([
    ...items.filter((old) => old.message !== message || old.tone !== tone),
    item,
  ]);
  emit();
  return item.id;
}
/**
 * Keep at most three. The oldest message that dismisses itself goes first,
 * so a persistent error is not pushed out by newer confirmations.
 */
function evict(list: ToastItem[]) {
  const next = [...list];
  while (next.length > MAX_TOASTS) {
    const passing = next.findIndex((item) => item.duration !== null);
    next.splice(passing >= 0 && passing < next.length - 1 ? passing : 0, 1);
  }
  return next;
}
export const toast = {
  success: (message: string, options?: ToastOptions) =>
    show("success", message, options),
  error: (message: string, options?: ToastOptions) =>
    show("error", message, options),
  info: (message: string, options?: ToastOptions) =>
    show("info", message, options),
  dismiss(id: number) {
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return;
    items = next;
    emit();
  },
  clear() {
    if (!items.length) return;
    items = [];
    emit();
  },
};
/**
 * The app's `notify`. Callers state the tone; a call without one (the
 * pipeline editor still has some) falls back to reading the wording.
 */
export function notifyToast(message: string, options: NotifyOptions = {}) {
  const { tone = guessTone(message), ...rest } = options;
  return show(tone, message, rest);
}
export function guessTone(message: string): ToastTone {
  return /^(import failed|cannot |could ?n[o']t|failed|unable to)/i.test(
    message,
  )
    ? "error"
    : "info";
}
/** Test-only: the current stack. */
export const toastSnapshot = () => items;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => items;

function ToastCard({ item }: { item: ToastItem }) {
  const remaining = useRef(item.duration);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paused = useRef(false);
  const start = () => {
    if (remaining.current === null || paused.current) return;
    started.current = Date.now();
    timer.current = setTimeout(
      () => toast.dismiss(item.id),
      Math.max(0, remaining.current),
    );
  };
  const pause = () => {
    if (paused.current) return;
    paused.current = true;
    clearTimeout(timer.current);
    if (remaining.current !== null)
      remaining.current -= Date.now() - started.current;
  };
  const resume = () => {
    if (!paused.current) return;
    paused.current = false;
    start();
  };
  // Hovering or focusing the toast holds it. A toast that appears under a
  // resting pointer is not being hovered, so only real movement counts.
  const hovered = useRef(false),
    focused = useRef(false),
    entry = useRef<{ x: number; y: number } | null>(null);
  const sync = () => (hovered.current || focused.current ? pause() : resume());
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, []);
  const Icon =
    item.tone === "success"
      ? CircleCheck
      : item.tone === "error"
        ? CircleAlert
        : null;
  return (
    <div
      className="toast-item"
      data-tone={item.tone}
      onPointerEnter={(event) => {
        entry.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const from = entry.current;
        if (
          hovered.current ||
          (from &&
            Math.abs(event.clientX - from.x) +
              Math.abs(event.clientY - from.y) <
              2)
        )
          return;
        hovered.current = true;
        sync();
      }}
      onPointerLeave={() => {
        entry.current = null;
        hovered.current = false;
        sync();
      }}
      onFocus={() => {
        focused.current = true;
        sync();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        focused.current = false;
        sync();
      }}
    >
      {Icon && <Icon className="toast-icon" size={16} aria-hidden="true" />}
      <span className="toast-message">{item.message}</span>
      {item.action &&
        (item.action.href ? (
          <a
            className="toast-action"
            href={item.action.href}
            onClick={() => toast.dismiss(item.id)}
          >
            {item.action.label}
          </a>
        ) : (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              item.action?.onClick?.();
              toast.dismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        ))}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={() => toast.dismiss(item.id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The app's notification stack, bottom-right on desktop, above the safe area
 * on phones. Screen readers hear each new message through two live regions
 * that are always mounted: a region inserted together with its text is often
 * skipped, so the text is written into an existing, empty region instead.
 */
export function ToastViewport() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [spoken, setSpoken] = useState({ polite: "", assertive: "" });
  const announced = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const newest = list[list.length - 1];
    if (!newest || newest.id <= announced.current) return;
    announced.current = newest.id;
    const region = newest.tone === "error" ? "assertive" : "polite";
    const text = newest.action
      ? `${newest.message} ${newest.action.label} is available in the notification.`
      : newest.message;
    // Clear, then write, so a repeated message is announced again.
    setSpoken((current) => ({ ...current, [region]: "" }));
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setSpoken((current) => ({ ...current, [region]: text })),
      100,
    );
  }, [list]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {spoken.polite}
      </div>
      <div
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {spoken.assertive}
      </div>
      {list.length > 0 && (
        <section className="toast" aria-label="Notifications">
          {list.map((item) => (
            <ToastCard key={item.id} item={item} />
          ))}
        </section>
      )}
    </>
  );
}
