import { useSyncExternalStore } from "react";

/**
 * Whether single-key shortcuts (R, /, ?, [ and G then a letter) are on. Speech
 * input and switch users turn them off (WCAG 2.1.4); shortcuts with a modifier
 * (Ctrl K, Ctrl S) always work. Remembered in this browser, like appearance.
 */
export const SINGLE_KEY_STORAGE_KEY = "vectory-single-key-shortcuts";

/** Anything but an explicit "off" keeps them on. */
export function parseSingleKeyShortcuts(value: unknown): boolean {
  return value !== "off";
}

function read(): boolean {
  try {
    return parseSingleKeyShortcuts(
      window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY),
    );
  } catch {
    // Storage can be unavailable in private or restricted contexts.
    return true;
  }
}

let current = typeof window === "undefined" ? true : read();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/** The current choice, for code outside React (the shortcut handler). */
export function singleKeyShortcutsOn() {
  return current;
}

export function setSingleKeyShortcuts(on: boolean) {
  current = on;
  try {
    window.localStorage.setItem(SINGLE_KEY_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The choice still applies to this tab when it can't be remembered.
  }
  emit();
}

// Another tab changed it: follow along. One listener serves every subscriber.
let following = false;
function follow(event: StorageEvent) {
  if (event.key !== SINGLE_KEY_STORAGE_KEY && event.key !== null) return;
  const next = read();
  if (next === current) return;
  current = next;
  emit();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!following) {
    following = true;
    window.addEventListener("storage", follow);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** [on, set]: re-renders whenever the choice changes, in any tab. */
export function useSingleKeyShortcuts(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, singleKeyShortcutsOn, () => true);
  return [on, setSingleKeyShortcuts];
}

/** A shortcut without Ctrl or ⌘ ("R", "G D") is a single-key one. */
export function isSingleKey(keys: readonly string[]) {
  return keys[0]?.toLowerCase() !== "mod";
}
