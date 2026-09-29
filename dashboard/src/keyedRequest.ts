import { useLayoutEffect, useRef, useState } from "react";
import { withRequestDeadline } from "./api";
import { isUncertainOutcome } from "./authRequests";
import type { AccountContext, useAccountAuthority } from "./accountAuthority";

type Authority = Pick<
  ReturnType<typeof useAccountAuthority>,
  "context" | "usable"
>;
export type KeyedHandlers<T, R> = {
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
};

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
 * The keyed-request state machine without React: the hook below keeps its
 * state in React, and tests drive it directly. Passwords are the caller's to
 * clear before sending; nothing here is ever resent. An unconfirmed result is
 * read once automatically, and a second attempt needs a server-confirmed
 * cancellation.
 */
export function createKeyedRequest<T, R>({
  authority,
  handlers,
  onRequest,
  onOpen,
  isMounted = () => true,
}: {
  authority: Authority;
  handlers: () => KeyedHandlers<T, R>;
  onRequest: (request: KeyedRequest<T> | null) => void;
  onOpen: (open: boolean) => void;
  isMounted?: () => boolean;
}) {
  const current: { current: KeyedRequest<T> | null } = { current: null };
  const work: { current: AbortController | null } = { current: null };

  function keep(next: KeyedRequest<T> | null) {
    current.current = next;
    onRequest(next);
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
  /** Runs `step` for the current attempt; null once it's no longer ours. */
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
      isMounted() &&
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
      onOpen(false);
      handlers().done(attempt, resolution.result, "status");
    } else if (resolution.kind === "retry")
      keep(fresh(attempt.target, resolution.notice));
    else patch({ phase: resolution.kind });
  }
  async function check() {
    const attempt = current.current;
    if (!attempt) return;
    const outcome = await run("checking", handlers().read);
    if (!outcome) return;
    if ("error" in outcome) patch({ phase: "unconfirmed" });
    else settle(outcome.value, attempt);
  }

  return {
    get request() {
      return current.current;
    },
    stopWork,
    /** A new form for `target`, unless an earlier attempt is still unresolved. */
    begin(target: T) {
      const previous = current.current;
      if (previous && previous.phase !== "form") {
        onOpen(true);
        return false;
      }
      keep(fresh(target));
      onOpen(true);
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
        onOpen(false);
        handlers().done(attempt, outcome.value, "receipt");
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
      const outcome = await run("cancelling", handlers().cancel);
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
      onOpen(false);
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
      onOpen(false);
    },
  };
}

/**
 * One-shot administrator requests with exact status reads (creating a person,
 * editing access, issuing a link). See createKeyedRequest for the rules.
 */
export function useKeyedRequest<T, R>({
  authority,
  read,
  cancel,
  done,
}: {
  authority: ReturnType<typeof useAccountAuthority>;
} & KeyedHandlers<T, R>) {
  const [request, setRequest] = useState<KeyedRequest<T> | null>(null);
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  const handlers = useRef<KeyedHandlers<T, R>>({ read, cancel, done });
  handlers.current = { read, cancel, done };
  const latestAuthority = useRef(authority);
  latestAuthority.current = authority;
  const machine = useRef<ReturnType<typeof createKeyedRequest<T, R>> | null>(
    null,
  );
  machine.current ??= createKeyedRequest<T, R>({
    authority: {
      context: () => latestAuthority.current.context(),
      usable: (original, admin) =>
        latestAuthority.current.usable(original, admin),
    },
    handlers: () => handlers.current,
    onRequest: setRequest,
    onOpen: setOpen,
    isMounted: () => mounted.current,
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      machine.current?.stopWork();
    };
  }, []);
  const {
    begin,
    edit,
    send,
    check,
    cancelAndRetry,
    recheck,
    close,
    authorityChanged,
    forget,
  } = machine.current;
  return {
    request,
    open,
    setOpen,
    begin,
    edit,
    send,
    check,
    cancelAndRetry,
    recheck,
    close,
    authorityChanged,
    forget,
  };
}
