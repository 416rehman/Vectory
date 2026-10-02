import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_DELAY, createHoverDisclosure } from "./hoverDisclosureModel";

/** The model with fake timers and a focus position the test sets. */
function setup() {
  const changes: boolean[] = [];
  const page = { focusInside: false };
  const help = createHoverDisclosure({
    onChange: (open) => changes.push(open),
    focusInside: () => page.focusInside,
  });
  return { help, page, changes };
}

/** A mouse click on part: press, the focus it causes, release, click. */
function mouseClick(
  { help, page }: ReturnType<typeof setup>,
  activateTrigger: boolean,
) {
  help.pressStart("mouse");
  page.focusInside = true;
  help.focusEnter();
  help.pressEnd();
  if (activateTrigger) help.activate(false);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("hover", () => {
  it("opens on entry and closes the delay after the pointer leaves both parts", () => {
    const { help } = setup();
    help.pointerEnter("trigger");
    expect(help.isOpen()).toBe(true);
    help.pointerLeave("trigger");
    help.pointerEnter("content");
    vi.advanceTimersByTime(CLOSE_DELAY * 2);
    expect(help.isOpen()).toBe(true);
    help.pointerLeave("content");
    vi.advanceTimersByTime(CLOSE_DELAY - 1);
    expect(help.isOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(help.isOpen()).toBe(false);
  });

  it("measures the delay from the last departure", () => {
    const { help } = setup();
    help.pointerEnter("trigger");
    help.pointerLeave("trigger");
    vi.advanceTimersByTime(CLOSE_DELAY - 10);
    help.pointerEnter("trigger");
    help.pointerLeave("trigger");
    vi.advanceTimersByTime(CLOSE_DELAY - 10);
    expect(help.isOpen()).toBe(true);
    vi.advanceTimersByTime(10);
    expect(help.isOpen()).toBe(false);
  });

  it("reads the pointer position when a part missed its leave event", () => {
    const { help } = setup();
    help.pointerEnter("content");
    help.pointerAt(false, false);
    vi.advanceTimersByTime(CLOSE_DELAY);
    expect(help.isOpen()).toBe(false);
  });
});

describe("a mouse click does not keep help open", () => {
  it("closes after the pointer leaves, though the trigger has focus", () => {
    const state = setup();
    state.help.pointerEnter("trigger");
    mouseClick(state, true);
    expect(state.help.isOpen()).toBe(true);
    state.help.pointerLeave("trigger");
    vi.advanceTimersByTime(CLOSE_DELAY);
    expect(state.help.isOpen()).toBe(false);
  });

  it("hands keyboard-opened help to the pointer", () => {
    const { help, page } = setup();
    page.focusInside = true;
    help.focusEnter();
    help.pointerEnter("trigger");
    help.pressStart("mouse");
    help.pressEnd();
    help.activate(false);
    help.pointerLeave("trigger");
    vi.advanceTimersByTime(CLOSE_DELAY);
    expect(help.isOpen()).toBe(false);
  });
});

describe("keyboard focus keeps help open", () => {
  it("opens on focus and holds through any pointer events until focus leaves", () => {
    const { help, page } = setup();
    page.focusInside = true;
    help.focusEnter();
    expect(help.isOpen()).toBe(true);
    // Help that opens under a resting pointer gets enter and leave events
    // without the pointer moving; neither takes the help from the keyboard.
    help.pointerEnter("content");
    help.pointerLeave("content");
    help.pointerAt(false, false);
    vi.advanceTimersByTime(CLOSE_DELAY * 3);
    expect(help.isOpen()).toBe(true);
    page.focusInside = false;
    help.focusLeave();
    vi.advanceTimersByTime(CLOSE_DELAY);
    expect(help.isOpen()).toBe(false);
  });

  it("opens on keyboard focus right after a press elsewhere, with no timer run in between", () => {
    const state = setup();
    const { help, page } = state;
    // Help is open; a click on its Close button closes it and returns focus.
    help.pointerEnter("trigger");
    help.pointerLeave("trigger");
    help.pointerEnter("content");
    mouseClick(state, false);
    help.dismiss();
    expect(help.isOpen()).toBe(false);
    // Focus leaves and comes back from the keyboard before any timer runs.
    page.focusInside = false;
    help.focusLeave();
    page.focusInside = true;
    help.focusEnter();
    expect(help.isOpen()).toBe(true);
    vi.advanceTimersByTime(CLOSE_DELAY * 3);
    expect(help.isOpen()).toBe(true);
  });

  it("forgets a pointer over help that has closed", () => {
    const { help, page } = setup();
    help.pointerEnter("content");
    help.dismiss();
    page.focusInside = true;
    help.focusEnter();
    page.focusInside = false;
    help.focusLeave();
    vi.advanceTimersByTime(CLOSE_DELAY);
    expect(help.isOpen()).toBe(false);
  });

  it("does not count focus a press caused, even when the press is a tap", () => {
    const { help, page } = setup();
    help.pressStart("touch");
    page.focusInside = true;
    help.focusEnter();
    expect(help.isOpen()).toBe(false);
  });

  it("opens on activation by key or script and on ArrowDown", () => {
    const first = setup();
    first.page.focusInside = true;
    first.help.activate(true);
    vi.advanceTimersByTime(CLOSE_DELAY);
    expect(first.help.isOpen()).toBe(true);
    const second = setup();
    second.page.focusInside = true;
    second.help.openByKeyboard();
    expect(second.help.isOpen()).toBe(true);
  });

  it("a key pressed during a press ends it", () => {
    const { help, page } = setup();
    help.pressStart("mouse");
    help.keyboardUse();
    page.focusInside = true;
    help.focusEnter();
    expect(help.isOpen()).toBe(true);
  });
});

describe("dismissal", () => {
  it("closes at once and stays closed while the pointer rests and timers run", () => {
    const { help, page } = setup();
    help.pointerEnter("trigger");
    page.focusInside = true;
    help.keyboardUse();
    help.dismiss();
    expect(help.isOpen()).toBe(false);
    vi.advanceTimersByTime(CLOSE_DELAY * 3);
    expect(help.isOpen()).toBe(false);
  });

  it("cancels a pending close so it cannot fire later", () => {
    const { help, changes } = setup();
    help.pointerEnter("trigger");
    help.pointerLeave("trigger");
    help.dismiss();
    help.pointerEnter("trigger");
    vi.advanceTimersByTime(CLOSE_DELAY * 3);
    expect(help.isOpen()).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });
});

describe("touch", () => {
  it("toggles on taps and ignores the pointer leaving", () => {
    const { help, page } = setup();
    help.pressStart("touch");
    page.focusInside = true;
    help.focusEnter();
    help.activate(false);
    help.pressEnd();
    expect(help.isOpen()).toBe(true);
    page.focusInside = false;
    help.focusLeave();
    vi.advanceTimersByTime(CLOSE_DELAY * 3);
    expect(help.isOpen()).toBe(true);
    help.pressStart("touch");
    help.activate(false);
    help.pressEnd();
    expect(help.isOpen()).toBe(false);
  });
});

describe("order independence", () => {
  type Help = ReturnType<typeof createHoverDisclosure>;
  // What the browser may deliver between two steps, in any order: a late
  // leave for help that has gone, timers running, and, while help is open,
  // enter, leave and move events from help appearing under a resting pointer.
  const whileClosed: ((help: Help) => void)[] = [
    (help) => help.pointerLeave("content"),
    () => vi.advanceTimersByTime(0),
    () => vi.advanceTimersByTime(CLOSE_DELAY),
  ];
  const whileOpen: ((help: Help) => void)[] = [
    ...whileClosed,
    (help) => help.pointerEnter("content"),
    (help) => help.pointerAt(false, true),
    (help) => help.pointerAt(false, false),
  ];
  it("keyboard focus after a click on Close opens help and keeps it, whatever arrives between the steps", () => {
    let cases = 0;
    const closed = whileClosed.length + 1,
      opened = whileOpen.length + 1;
    for (let mask = 0; mask < closed * closed * opened * opened; mask++) {
      vi.clearAllTimers();
      const state = setup();
      const { help, page } = state;
      const slots = [
        mask % closed,
        Math.floor(mask / closed) % closed,
        Math.floor(mask / closed / closed) % opened,
        Math.floor(mask / closed / closed / opened) % opened,
      ];
      const between = (slot: number, events: ((help: Help) => void)[]) =>
        events[slots[slot]]?.(help);
      // Help is open under the pointer; its Close button is clicked.
      help.pointerEnter("content");
      mouseClick(state, false);
      help.dismiss();
      between(0, whileClosed);
      // Focus goes to another field, then back to the trigger by keyboard.
      page.focusInside = false;
      help.focusLeave();
      between(1, whileClosed);
      page.focusInside = true;
      help.focusEnter();
      expect(help.isOpen(), `slots ${slots.join(",")}`).toBe(true);
      between(2, whileOpen);
      between(3, whileOpen);
      vi.advanceTimersByTime(CLOSE_DELAY * 2);
      expect(help.isOpen(), `slots ${slots.join(",")}`).toBe(true);
      cases++;
    }
    expect(cases).toBe(closed * closed * opened * opened);
  });
});
