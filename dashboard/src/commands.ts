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

/** What a page can do to one thing the palette found by name. */
export type ThingCommand =
  | "rollout.pause"
  | "rollout.cancel"
  | "rollout.rollback"
  | "pipeline.deploy"
  | "pipeline.duplicate";

/**
 * The command a page registers for one rollout or pipeline: "rollout.pause"
 * for rollout `id`. The id is part of the name, so a page that shows one
 * rollout never answers for another.
 */
export const commandFor = (command: ThingCommand, id: string) =>
  `${command}:${id.toLowerCase()}`;

/**
 * Ends a request that was waiting for `name`, and says whether a fresh one was:
 * the page it opened cannot do it now, so it must not run later on a click that
 * had nothing to do with it.
 */
export function refuseCommand(name: string) {
  const requested = pending.get(name);
  pending.delete(name);
  return requested !== undefined && Date.now() - requested < PENDING_MS;
}

/**
 * Registers a page's command while it is `enabled`. A page that has what it
 * needs to decide, and cannot do the command now, passes `whenRefused`: a
 * request that was waiting for it ends there, and `whenRefused` says so.
 */
export function useCommand(
  name: string,
  handler: Handler,
  enabled = true,
  whenRefused?: () => void,
) {
  const latest = useRef(handler);
  latest.current = handler;
  const refused = useRef(whenRefused);
  refused.current = whenRefused;
  const settled = !!whenRefused;
  useEffect(() => {
    if (enabled) return registerCommand(name, () => latest.current());
    if (settled && refuseCommand(name)) refused.current?.();
  }, [name, enabled, settled]);
}
