import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  createHoverDisclosure,
  type HelpPart,
  type HoverDisclosure,
  type PressKind,
} from "./hoverDisclosureModel";

const pressKind = (pointerType: string): PressKind =>
  pointerType === "touch" ? "touch" : pointerType === "pen" ? "pen" : "mouse";

/** Non-modal help: hover bridges the trigger/popup; only keyboard focus retains it. */
export function useHoverDisclosure() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null),
    content = useRef<HTMLDivElement | null>(null),
    ignoreFocus = useRef(false),
    focusContentOnOpen = useRef(false),
    endPress = useRef<(() => void) | undefined>(undefined);
  const inside = (node: EventTarget | null) =>
    node instanceof Node &&
    (!!triggerRef.current?.contains(node) || !!content.current?.contains(node));
  const model = useRef<HoverDisclosure | null>(null);
  model.current ??= createHoverDisclosure({
    onChange: setOpen,
    focusInside: () => inside(document.activeElement),
  });
  const help = model.current;

  const close = useCallback(
    (returnFocus = false) => {
      focusContentOnOpen.current = false;
      help.dismiss();
      if (returnFocus) {
        ignoreFocus.current = true;
        triggerRef.current?.focus();
        ignoreFocus.current = false;
      }
    },
    [help],
  );
  // The help takes focus as it mounts when ArrowDown asked for it, in the same
  // commit, so no later frame can move focus a person has moved since.
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    content.current = node;
    if (node && focusContentOnOpen.current) {
      focusContentOnOpen.current = false;
      node.focus({ preventScroll: true });
    }
  }, []);
  /**
   * A press on the trigger or in the help lasts until its pointer is released
   * (for a tap, until its click, which comes after the focus it causes), is
   * cancelled, or a key is pressed. Focus during a press is the pointer's.
   */
  function startPress(event: ReactPointerEvent<HTMLElement>) {
    endPress.current?.();
    const kind = pressKind(event.pointerType);
    help.pressStart(kind);
    const owner = event.currentTarget.ownerDocument;
    // A tap focuses on its compatibility mousedown, after pointerup and before
    // its click, so a tap's press ends at the click (after the trigger's own
    // click handler, which reads it). A mouse or pen focuses before pointerup.
    const ends: [string, boolean][] = [
      ...(kind === "touch"
        ? []
        : ([
            ["pointerup", true],
            ["mouseup", true],
          ] as [string, boolean][])),
      ["click", false],
      ["pointercancel", true],
      ["contextmenu", true],
      ["dragstart", true],
      ["keydown", true],
    ];
    const finish = () => {
      for (const [type, capture] of ends)
        owner.removeEventListener(type, finish, capture);
      if (endPress.current === finish) endPress.current = undefined;
      help.pressEnd();
    };
    for (const [type, capture] of ends)
      owner.addEventListener(type, finish, capture);
    endPress.current = finish;
  }
  function enter(part: HelpPart, event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") help.pointerEnter(part);
  }
  function leave(part: HelpPart, event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") help.pointerLeave(part);
  }
  function focusEnter() {
    if (!ignoreFocus.current) help.focusEnter();
  }
  function focusLeave(event: ReactFocusEvent<HTMLElement>) {
    // Moving between the trigger and the help is not leaving; neither is the
    // window losing focus, which keeps the focused element.
    if (inside(event.relatedTarget) || inside(document.activeElement)) return;
    help.focusLeave();
  }
  function onEscapeKeyDown(event: {
    preventDefault(): void;
    stopPropagation(): void;
  }) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
  useEffect(
    () => () => {
      endPress.current?.();
      help.dispose();
    },
    [help],
  );
  useEffect(() => {
    if (!open) return;
    const within = (node: HTMLElement | null, event: PointerEvent) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      // Inert/disabled ancestors may suppress local pointerleave events.
      help.pointerAt(
        within(triggerRef.current, event),
        within(content.current, event),
      );
    };
    const outside = (event: PointerEvent) => {
      if (!inside(event.target)) close();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, help, close]);
  function keyDown(event: ReactKeyboardEvent<HTMLElement>, part: HelpPart) {
    help.keyboardUse();
    if (event.key === "Escape") onEscapeKeyDown(event);
    else if (part === "trigger" && event.key === "ArrowDown") {
      event.preventDefault();
      if (help.isOpen() && content.current)
        content.current.focus({ preventScroll: true });
      else {
        focusContentOnOpen.current = true;
        help.openByKeyboard();
      }
    }
  }
  return {
    open,
    triggerRef,
    contentRef,
    close,
    // Radix only asks to close: opening is decided by the trigger's click.
    onOpenChange: (next: boolean) => {
      if (!next) close();
    },
    onEscapeKeyDown,
    triggerProps: {
      onPointerEnter: (event: ReactPointerEvent<HTMLButtonElement>) =>
        enter("trigger", event),
      onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) =>
        leave("trigger", event),
      onPointerDown: startPress,
      onFocus: focusEnter,
      onBlur: focusLeave,
      onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
        // Radix must know the real trigger, but should not toggle hover-open help.
        event.preventDefault();
        help.activate(event.detail === 0);
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
        keyDown(event, "trigger"),
    },
    contentProps: {
      onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) =>
        enter("content", event),
      onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) =>
        leave("content", event),
      onPointerDownCapture: startPress,
      onFocusCapture: focusEnter,
      onBlurCapture: focusLeave,
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) =>
        keyDown(event, "content"),
    },
  };
}

export default useHoverDisclosure;
