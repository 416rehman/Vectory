import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { toastLift, type Box } from "./toastPlacement";
import "./toast.css";

export type ToastTone = "success" | "error" | "info";
export type ToastAction =
  | { label: string; onClick: () => void; href?: never }
  | { label: string; href: string; onClick?: never };
export type ToastOptions = {
  action?: ToastAction;
  /** Milliseconds before an automatic dismissal; errors persist by default. */
  duration?: number | null;
  /**
   * What the message is about. A newer message on the same topic replaces the
   * older one, and a page can dismiss the topic once it stops being true
   * ("Save to keep it" after the save).
   */
  topic?: string;
};
/** What a page's `notify` accepts: the tone is stated, never guessed. */
export type NotifyOptions = ToastOptions & { tone: ToastTone };
export type Notify = (message: string, options: NotifyOptions) => void;
/**
 * A refused gesture (a connection that can't be made, a drop while a dialog
 * is open): said as an error, gone after six seconds since nothing is lost.
 */
export const refusal = {
  tone: "error",
  duration: 6000,
} as const satisfies NotifyOptions;
export type ToastItem = {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
  duration: number | null;
  topic?: string;
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
    topic: options.topic,
    duration:
      options.duration !== undefined
        ? options.duration
        : tone === "error"
          ? null
          : DEFAULT_DURATION,
  };
  // Replace an identical visible message, or an earlier one on the same
  // topic, instead of stacking duplicates.
  items = evict([
    ...items.filter(
      (old) =>
        (old.message !== message || old.tone !== tone) &&
        (!options.topic || old.topic !== options.topic),
    ),
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
  /** Every message about `topic`: it has stopped being true. */
  dismissTopic(topic: string) {
    const next = items.filter((item) => item.topic !== topic);
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
/** The app's `notify`: every caller states the tone. */
export function notifyToast(message: string, options: NotifyOptions) {
  const { tone, ...rest } = options;
  return show(tone, message, rest);
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
 * What notifications must not cover at the bottom of the screen: the editor's
 * problems bar, and the buttons at the foot of an open dialog.
 */
const BOTTOM_UI = '.problems-panel, [role="dialog"] .modal-footer';

const boxOf = (element: Element): Box => {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
};

/**
 * Keeps the stack clear of the bottom bars, as they come, go and resize: the
 * stack rests where it always did and rises by `--toast-lift` while one is
 * under it.
 */
function useClearOfBottomBars(
  stack: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    const element = stack.current;
    if (!active || !element) return;
    let frame = 0;
    // The elements whose size is followed: a new one reports once, so the set
    // changes only when a bar comes or goes.
    const watched = new Set<Element>();
    const place = () => {
      frame = 0;
      const lifted =
        Number.parseFloat(element.style.getPropertyValue("--toast-lift")) || 0;
      const now = boxOf(element);
      const bars = [...document.querySelectorAll(BOTTOM_UI)].filter(
        (bar) => !element.contains(bar) && bar.getClientRects().length > 0,
      );
      // Where the stack rests: its box without the lift it has now.
      const lift = toastLift(
        { ...now, top: now.top + lifted, bottom: now.bottom + lifted },
        bars.map(boxOf),
      );
      if (lift !== lifted)
        element.style.setProperty("--toast-lift", `${lift}px`);
      const targets = [element, ...bars];
      for (const old of watched)
        if (!targets.includes(old)) {
          resizes.unobserve(old);
          watched.delete(old);
        }
      for (const target of targets)
        if (!watched.has(target)) {
          resizes.observe(target);
          watched.add(target);
        }
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    const resizes = new ResizeObserver(soon);
    const changes = new MutationObserver(soon);
    changes.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    place();
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      resizes.disconnect();
      window.removeEventListener("resize", soon);
    };
  }, [stack, active]);
}

type Region = "polite" | "assertive";
const REGIONS: Region[] = ["polite", "assertive"];
/** How long a spoken message stays in its region before it is wiped. */
const SPOKEN_LIFETIME = 10_000;

/**
 * The app's notification stack, bottom-right on desktop, above the safe area
 * on phones. Screen readers hear each new message through two live regions
 * that are always mounted: a region inserted together with its text is often
 * skipped, so the text is written into an existing, empty region instead.
 * The regions carry no role of their own, so they never show up as a second
 * "alert" or "status" beside the messages a page shows.
 */
export function ToastViewport() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [spoken, setSpoken] = useState<Record<Region, string>>({
    polite: "",
    assertive: "",
  });
  const announced = useRef(0);
  const stack = useRef<HTMLElement>(null);
  useClearOfBottomBars(stack, list.length > 0);
  const timers = useRef<
    Record<
      Region,
      {
        write?: ReturnType<typeof setTimeout>;
        wipe?: ReturnType<typeof setTimeout>;
      }
    >
  >({ polite: {}, assertive: {} });
  const say = (region: Region, text: string) =>
    setSpoken((current) => ({ ...current, [region]: text }));
  useEffect(() => {
    const newest = list[list.length - 1];
    if (!newest || newest.id <= announced.current) return;
    announced.current = newest.id;
    const region: Region = newest.tone === "error" ? "assertive" : "polite";
    const text = newest.action
      ? `${newest.message} ${newest.action.label} is available in the notification.`
      : newest.message;
    const own = timers.current[region];
    clearTimeout(own.write);
    clearTimeout(own.wipe);
    // Clear, then write, so a repeated message is announced again.
    say(region, "");
    own.write = setTimeout(() => {
      say(region, text);
      // Nothing is left behind for a screen reader's browse mode to find.
      own.wipe = setTimeout(() => say(region, ""), SPOKEN_LIFETIME);
    }, 100);
  }, [list]);
  useEffect(
    () => () => {
      for (const region of REGIONS) {
        clearTimeout(timers.current[region].write);
        clearTimeout(timers.current[region].wipe);
      }
    },
    [],
  );
  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {spoken.polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {spoken.assertive}
      </div>
      {list.length > 0 && (
        <section className="toast" aria-label="Notifications" ref={stack}>
          {list.map((item) => (
            <ToastCard key={item.id} item={item} />
          ))}
        </section>
      )}
    </>
  );
}
