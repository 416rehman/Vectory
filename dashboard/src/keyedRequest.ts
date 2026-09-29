import { useLayoutEffect, useRef, useState } from "react";
import { withRequestDeadline } from "./api";
import { isUncertainOutcome } from "./authRequests";
import type { AccountContext, useAccountAuthority } from "./accountAuthority";

/**
 * What an exact status read (or a cancellation) says about a keyed request:
 * - `done`: its result is known, so the action finished.
 * - `pending`: nothing committed yet, but the lost request could still arrive;
 *   only a cancellation fence makes a second attempt safe.
 * - `unseen`: it committed, but its one-time result can't be shown again;
 *   cancel it before creating another.
 * - `retry`: it can no longer apply; the form can be used again.
 */
export type Resolution<R> =
  | { kind: "done"; result: R }
  | { kind: "pending" }
  | { kind: "unseen" }
  | { kind: "retry"; notice?: string };

/** Inline messages by field name; `form` is for the whole form. */
export type Fields = { [field: string]: string | undefined };

export type KeyedPhase =
  | "form"
  | "sending"
  | "checking"
  | "unconfirmed"
  | "pending"
  | "unseen"
  | "cancelling"
  | "changed";

export type KeyedRequest<T> = {
  target: T;
  /** The sign-in that owns this request; its result is adopted only while current. */
  context: AccountContext;
  /** One UUID per attempt: a new attempt always gets a new identity. */
  id: string;
  phase: KeyedPhase;
  fields: Fields;
  notice: string;
};

/** The request never left this browser; the form can simply be sent again. */
export class NotSent extends Error {}

/**
 * One-shot administrator requests with exact status reads (creating a person,
 * editing access, issuing a link). Passwords are the caller's to clear before
 * sending; nothing here is ever resent. An unconfirmed result is read once
 * automatically, and a second attempt needs a server-confirmed cancellation.
 */
export function useKeyedRequest<T, R>({
  authority,
  read,
  cancel,
  done,
}: {
  authority: ReturnType<typeof useAccountAuthority>;
  read: (
    request: KeyedRequest<T>,
    signal: AbortSignal,
  ) => Promise<Resolution<R>>;
  cancel: (
    request: KeyedRequest<T>,
    signal: AbortSignal,
  ) => Promise<Resolution<R>>;
  done: (
    request: KeyedRequest<T>,
    result: R,
    via: "receipt" | "status",
  ) => void;
}) {
  const [request, setRequest] = useState<KeyedRequest<T> | null>(null);
  const [open, setOpen] = useState(false);
  const current = useRef<KeyedRequest<T> | null>(null);
  const work = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const handlers = useRef({ read, cancel, done });
  handlers.current = { read, cancel, done };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      work.current?.abort();
      work.current = null;
    };
  }, []);

  function keep(next: KeyedRequest<T> | null) {
    current.current = next;
    setRequest(next);
  }
  function patch(changes: Partial<KeyedRequest<T>>) {
    if (current.current) keep({ ...current.current, ...changes });
  }
  function fresh(target: T, notice = ""): KeyedRequest<T> {
    return {
      target,
      context: authority.context(),
      id: crypto.randomUUID(),
      phase: "form",
      fields: {},
      notice,
    };
  }
  function stopWork() {
    work.current?.abort();
    work.current = null;
  }
  /** Runs `step` for the current attempt; false once it's no longer ours. */
  async function run<V>(
    phase: KeyedPhase,
    step: (request: KeyedRequest<T>, signal: AbortSignal) => Promise<V>,
  ): Promise<{ value: V } | { error: unknown } | null> {
    const attempt = current.current;
    if (!attempt) return null;
    stopWork();
    const controller = new AbortController();
    work.current = controller;
    const started = { ...attempt, phase, fields: {} };
    keep(started);
    const owns = () =>
      mounted.current &&
      work.current === controller &&
      current.current?.id === started.id &&
      current.current.phase === phase;
    try {
      const value = await withRequestDeadline(
        (signal) => step(started, signal),
        30000,
        controller.signal,
      );
      if (!owns()) return null;
      work.current = null;
      if (!authority.usable(started.context, true)) {
        patch({ phase: "changed" });
        return null;
      }
      return { value };
    } catch (error) {
      if (!owns()) return null;
      work.current = null;
      if (!authority.usable(started.context, true)) {
        patch({ phase: "changed" });
        return null;
      }
      return { error };
    }
  }
  function settle(resolution: Resolution<R>, attempt: KeyedRequest<T>) {
    if (resolution.kind === "done") {
      keep(null);
      setOpen(false);
      handlers.current.done(attempt, resolution.result, "status");
    } else if (resolution.kind === "retry")
      keep(fresh(attempt.target, resolution.notice));
    else patch({ phase: resolution.kind });
  }
  async function check() {
    const attempt = current.current;
    if (!attempt) return;
    const outcome = await run("checking", handlers.current.read);
    if (!outcome) return;
    if ("error" in outcome) patch({ phase: "unconfirmed" });
    else settle(outcome.value, attempt);
  }

  return {
    request,
    open,
    setOpen,
    /** A new form for `target`, unless an earlier attempt is still unresolved. */
    begin(target: T) {
      const previous = current.current;
      if (previous && previous.phase !== "form") {
        setOpen(true);
        return false;
      }
      keep(fresh(target));
      setOpen(true);
      return true;
    },
    edit(changes: { target?: T; fields?: Fields }) {
      patch(changes);
    },
    /** Sends once. Rejections become field errors; unknown results are read. */
    async send(
      step: (request: KeyedRequest<T>, signal: AbortSignal) => Promise<R>,
      rejected: (error: unknown) => Fields,
    ) {
      const attempt = current.current;
      if (!attempt || attempt.phase !== "form") return;
      if (!authority.usable(attempt.context, true)) {
        // Nothing was sent yet, so the form may continue under a new sign-in
        // by the same administrator (after re-signing in over this page).
        const now = authority.context();
        if (
          now.userId !== attempt.context.userId ||
          !authority.usable(now, true)
        ) {
          patch({
            fields: {
              form: "Your sign-in changed. Sign in again as an administrator to continue.",
            },
          });
          return;
        }
        patch({ context: now });
      }
      const outcome = await run("sending", step);
      if (!outcome) return;
      if ("value" in outcome) {
        keep(null);
        setOpen(false);
        handlers.current.done(attempt, outcome.value, "receipt");
      } else if (
        !(outcome.error instanceof NotSent) &&
        isUncertainOutcome(outcome.error)
      )
        await check();
      else
        keep({
          ...fresh(attempt.target),
          fields:
            outcome.error instanceof NotSent
              ? { form: outcome.error.message }
              : rejected(outcome.error),
        });
    },
    check,
    /** Fence the unresolved attempt, then offer the form again. */
    async cancelAndRetry() {
      const attempt = current.current;
      if (!attempt) return;
      const outcome = await run("cancelling", handlers.current.cancel);
      if (!outcome) return;
      if ("error" in outcome) patch({ phase: "unconfirmed" });
      else settle(outcome.value, attempt);
    },
    /** After a re-sign-in as the same administrator, check the original request. */
    async recheck() {
      const attempt = current.current;
      const now = authority.context();
      if (
        !attempt ||
        attempt.phase !== "changed" ||
        now.userId !== attempt.context.userId ||
        now.role !== "admin" ||
        !authority.usable(now, true)
      )
        return;
      keep({ ...attempt, context: now });
      await check();
    },
    /**
     * Hide the dialog. An unsent form is forgotten; waiting stops and the
     * result is read; anything unresolved stays for review on this page.
     */
    close() {
      const attempt = current.current;
      setOpen(false);
      if (!attempt) return;
      if (attempt.phase === "form") keep(null);
      else if (attempt.phase === "sending") {
        stopWork();
        void check();
      } else if (
        attempt.phase === "checking" ||
        attempt.phase === "cancelling"
      ) {
        stopWork();
        patch({ phase: "unconfirmed" });
      }
    },
    /** The account or session changed: nothing unresolved may be adopted now. */
    authorityChanged() {
      const attempt = current.current;
      // An unsent form stays as typed (its secrets are the caller's to clear);
      // it is bound to the current sign-in only when it is sent.
      if (!attempt || attempt.phase === "form") return;
      stopWork();
      patch({ phase: "changed" });
    },
    forget() {
      stopWork();
      keep(null);
      setOpen(false);
    },
  };
}
