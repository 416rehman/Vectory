import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Non-modal help: hover bridges the trigger/popup; only keyboard focus retains it. */
export function useHoverDisclosure() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null),
    contentRef = useRef<HTMLDivElement>(null),
    isOpen = useRef(false),
    mode = useRef<"pointer" | "keyboard" | "touch">("pointer"),
    pointerInside = useRef({ trigger: false, content: false }),
    ignoreFocus = useRef(false),
    pointerFocus = useRef(false),
    closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    focusFrame = useRef<number | undefined>(undefined);

  const clearClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);
  const update = useCallback((next: boolean) => {
    isOpen.current = next;
    setOpen(next);
  }, []);
  const close = useCallback(
    (returnFocus = false) => {
      clearClose();
      if (focusFrame.current !== undefined)
        cancelAnimationFrame(focusFrame.current);
      update(false);
      if (returnFocus) {
        ignoreFocus.current = true;
        triggerRef.current?.focus();
        ignoreFocus.current = false;
      }
    },
    [clearClose, update],
  );
  function scheduleClose() {
    if (closeTimer.current !== undefined) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined;
      const focused = document.activeElement;
      if (
        pointerInside.current.trigger ||
        pointerInside.current.content ||
        mode.current === "touch" ||
        (mode.current === "keyboard" &&
          (focused === triggerRef.current ||
            contentRef.current?.contains(focused)))
      )
        return;
      close();
    }, 180);
  }
  function pointerDown(event: ReactPointerEvent<HTMLElement>) {
    mode.current = event.pointerType === "touch" ? "touch" : "pointer";
    // Focus caused by pointerdown is not keyboard intent, even after click.
    pointerFocus.current = true;
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      pointerFocus.current = false;
    }, 0);
  }
  function enter(
    part: "trigger" | "content",
    event: ReactPointerEvent<HTMLElement>,
  ) {
    if (event.pointerType !== "mouse") return;
    mode.current = "pointer";
    pointerInside.current[part] = true;
    clearClose();
    update(true);
  }
  function leave(
    part: "trigger" | "content",
    event: ReactPointerEvent<HTMLElement>,
  ) {
    if (event.pointerType !== "mouse") return;
    pointerInside.current[part] = false;
    scheduleClose();
  }
  function keyboardFocus() {
    if (ignoreFocus.current || pointerFocus.current) return;
    mode.current = "keyboard";
    clearClose();
    update(true);
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
      clearTimeout(closeTimer.current);
      clearTimeout(focusTimer.current);
      if (focusFrame.current !== undefined)
        cancelAnimationFrame(focusFrame.current);
    },
    [],
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
      pointerInside.current = {
        trigger: within(triggerRef.current, event),
        content: within(contentRef.current, event),
      };
      if (pointerInside.current.trigger || pointerInside.current.content)
        clearClose();
      else scheduleClose();
    };
    const outside = (event: PointerEvent) => {
      if (
        !triggerRef.current?.contains(event.target as Node) &&
        !contentRef.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);
  return {
    open,
    triggerRef,
    contentRef,
    close,
    onOpenChange: (next: boolean) => (next ? update(true) : close()),
    onEscapeKeyDown,
    triggerProps: {
      onPointerEnter: (event: ReactPointerEvent<HTMLButtonElement>) =>
        enter("trigger", event),
      onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) =>
        leave("trigger", event),
      onPointerDown: pointerDown,
      onFocus: keyboardFocus,
      onBlur: scheduleClose,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        // Radix must know the real trigger, but should not toggle hover-open help.
        event.preventDefault();
        clearClose();
        if (mode.current === "touch") update(!isOpen.current);
        else {
          mode.current = event.detail === 0 ? "keyboard" : "pointer";
          update(true);
        }
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        mode.current = "keyboard";
        pointerFocus.current = false;
        if (event.key === "Escape") onEscapeKeyDown(event);
        else if (event.key === "ArrowDown") {
          event.preventDefault();
          clearClose();
          update(true);
          focusFrame.current = requestAnimationFrame(() =>
            contentRef.current?.focus(),
          );
        }
      },
    },
    contentProps: {
      onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) =>
        enter("content", event),
      onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) =>
        leave("content", event),
      onPointerDownCapture: pointerDown,
      onFocusCapture: keyboardFocus,
      onBlurCapture: scheduleClose,
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        mode.current = "keyboard";
        pointerFocus.current = false;
        if (event.key === "Escape") onEscapeKeyDown(event);
      },
    },
  };
}

export default useHoverDisclosure;
