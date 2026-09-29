import { useEffect, useRef } from "react";

/**
 * A small command bus for the command palette and keyboard shortcuts. Pages
 * register what they can do ("pipeline.create"); running a command whose page
 * isn't mounted navigates there first and runs it once the page registers.
 */
type Handler = () => void;
const handlers = new Map<string, Handler>();
const pending = new Map<string, number>();
const PENDING_MS = 10000;

export function registerCommand(name: string, handler: Handler) {
  handlers.set(name, handler);
  const requested = pending.get(name);
  if (requested !== undefined) {
    pending.delete(name);
    if (Date.now() - requested < PENDING_MS) setTimeout(handler, 0);
  }
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

/** Run now if available, else open `route` and run when its page is ready. */
export function runCommand(name: string, route?: string) {
  const handler = handlers.get(name);
  if (handler) {
    handler();
    return true;
  }
  if (!route) return false;
  const requested = Date.now();
  pending.set(name, requested);
  window.location.hash = `/${route}`;
  // A page with unsaved work can refuse the navigation (the hash is put back).
  // Then nothing should run later, on some unrelated visit to that page.
  const path = `#/${route.split("?")[0]}`;
  setTimeout(() => {
    const arrived =
      window.location.hash === path ||
      window.location.hash.startsWith(`${path}?`) ||
      window.location.hash.startsWith(`${path}/`);
    if (!arrived && pending.get(name) === requested) pending.delete(name);
  }, 0);
  return true;
}

export function useCommand(name: string, handler: Handler, enabled = true) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerCommand(name, () => latest.current());
  }, [name, enabled]);
}
