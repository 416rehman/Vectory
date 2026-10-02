/**
 * When non-modal help is open. Three reasons keep it open, each changed only by
 * its own events: a mouse pointer over the trigger or the help, keyboard focus
 * inside them, and a touch tap that opened it. A pointer event can therefore
 * never undo keyboard focus, and focus never depends on how a timer was ordered
 * against it. When the pointer or focus leaves, the help closes CLOSE_DELAY
 * later, if no reason holds at that moment.
 */
export const CLOSE_DELAY = 180;

export type HelpPart = "trigger" | "content";
export type PressKind = "mouse" | "pen" | "touch";

export type HoverDisclosureOptions = {
  /** Called when the help opens or closes. */
  onChange: (open: boolean) => void;
  /** Whether focus is on the trigger or inside the help right now. */
  focusInside: () => boolean;
  setTimer?: (run: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export function createHoverDisclosure({
  onChange,
  focusInside,
  setTimer = (run, delay) => setTimeout(run, delay),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: HoverDisclosureOptions) {
  let open = false,
    keyboard = false,
    touch = false,
    press: PressKind | null = null,
    timer: unknown;
  const pointer = { trigger: false, content: false };

  function stopTimer() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }
  function show() {
    stopTimer();
    if (open) return;
    open = true;
    onChange(true);
  }
  function close() {
    stopTimer();
    // The help leaves the page, and with it any pointer over it.
    pointer.content = false;
    keyboard = false;
    touch = false;
    if (!open) return;
    open = false;
    onChange(false);
  }
  function held() {
    return (
      pointer.trigger || pointer.content || touch || (keyboard && focusInside())
    );
  }
  /** Close after the delay unless something holds the help open then. */
  function closeLater() {
    stopTimer();
    if (!open) return;
    timer = setTimer(() => {
      timer = undefined;
      if (!held()) close();
    }, CLOSE_DELAY);
  }

  return {
    isOpen: () => open,
    /** A mouse pointer entered the trigger or the help. */
    pointerEnter(part: HelpPart) {
      pointer[part] = true;
      show();
    },
    /** A mouse pointer left the trigger or the help. */
    pointerLeave(part: HelpPart) {
      pointer[part] = false;
      if (!held()) closeLater();
    },
    /** Where a moving mouse pointer is, for parts that miss leave events. */
    pointerAt(trigger: boolean, content: boolean) {
      pointer.trigger = trigger;
      pointer.content = content;
      if (trigger || content) stopTimer();
      else if (!held()) closeLater();
    },
    /** A press began on the trigger or in the help: the pointer is in charge. */
    pressStart(kind: PressKind) {
      press = kind;
      keyboard = false;
    },
    /** That press finished, was cancelled, or a key was pressed. */
    pressEnd() {
      press = null;
    },
    /**
     * Focus arrived on the trigger or in the help from elsewhere. Focus that a
     * press caused is not keyboard intent; any other focus is.
     */
    focusEnter() {
      if (press) return;
      keyboard = true;
      show();
    },
    /** Focus moved to something outside the trigger and the help. */
    focusLeave() {
      keyboard = false;
      if (!held()) closeLater();
    },
    /** A key was pressed on the trigger or in the help. */
    keyboardUse() {
      press = null;
      keyboard = true;
    },
    /**
     * The trigger was activated. A key or a script opens the help and keeps it
     * while focused; a tap toggles it; a mouse click opens it without keeping it.
     */
    activate(byKeyboard: boolean) {
      if (byKeyboard) {
        keyboard = true;
        show();
      } else if (press === "touch") {
        if (open) close();
        else {
          touch = true;
          show();
        }
      } else {
        keyboard = false;
        pointer.trigger = true;
        show();
      }
    },
    /** Open on request (ArrowDown on the trigger). */
    openByKeyboard() {
      keyboard = true;
      show();
    },
    /** Escape, the Close button, an outside press, or a dismissal. */
    dismiss: close,
    /** The component is going away. */
    dispose: stopTimer,
  };
}

export type HoverDisclosure = ReturnType<typeof createHoverDisclosure>;
