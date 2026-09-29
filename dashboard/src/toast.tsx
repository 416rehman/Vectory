import { useEffect, useRef, useSyncExternalStore } from "react";
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
  items = [
    ...items.filter((old) => old.message !== message || old.tone !== tone),
    item,
  ].slice(-MAX_TOASTS);
  emit();
  return item.id;
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
/** Compatibility for page `notify(message)` callbacks. */
export function notifyToast(message: string) {
  return /^(import failed|cannot |could ?n[o']t|failed|unable to)/i.test(
    message,
  )
    ? toast.error(message)
    : toast.info(message);
}
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
      role={item.tone === "error" ? "alert" : "status"}
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          resume();
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

/** The app's notification stack, bottom-right on desktop, above the safe area on phones. */
export function ToastViewport() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!list.length) return null;
  return (
    <section className="toast" aria-label="Notifications">
      {list.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </section>
  );
}
