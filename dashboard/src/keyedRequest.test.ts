import { describe, expect, it, vi } from "vitest";
import { APIError } from "./api";
import type { AccountContext } from "./accountAuthority";
import {
  createKeyedRequest,
  NotSent,
  type KeyedHandlers,
  type KeyedRequest,
  type Resolution,
} from "./keyedRequest";

type Target = { email: string };
type Result = { id: string };

/** A fake sign-in: `sign` swaps who is signed in, `valid` ends the session. */
function harness(handlers: Partial<KeyedHandlers<Target, Result>> = {}) {
  const account = {
    userId: "admin-1",
    role: "admin" as AccountContext["role"],
    epoch: 1,
    valid: true,
  };
  const context = (): AccountContext => ({
    userId: account.userId,
    role: account.role,
    enabled: true,
    csrfToken: "csrf",
    csrfVersion: 1,
    epoch: account.epoch,
    valid: account.valid,
  });
  const done = vi.fn();
  const full: KeyedHandlers<Target, Result> = {
    read: vi.fn(async () => ({ kind: "pending" }) as Resolution<Result>),
    cancel: vi.fn(async () => ({ kind: "retry" }) as Resolution<Result>),
    done,
    ...handlers,
  };
  const phases: (string | null)[] = [];
  let open = false;
  const machine = createKeyedRequest<Target, Result>({
    authority: {
      context,
      usable: (original, admin = false) => {
        const now = context();
        return (
          (!admin || (original.role === "admin" && now.role === "admin")) &&
          original.userId === now.userId &&
          original.epoch === now.epoch &&
          now.valid
        );
      },
    },
    handlers: () => full,
    onRequest: (request) => phases.push(request?.phase ?? null),
    onOpen: (value) => {
      open = value;
    },
  });
  return {
    machine,
    account,
    handlers: full,
    done,
    phases,
    get open() {
      return open;
    },
  };
}
const unavailable = () =>
  new APIError("UNAVAILABLE", "Service temporarily unavailable", 503, true);
const rejected = () =>
  new APIError("EMAIL_TAKEN", "That email is taken", 409, true);

describe("keyed administrator requests", () => {
  it("adopts a receipt once and closes", async () => {
    const h = harness();
    expect(h.machine.begin({ email: "ada@example.com" })).toBe(true);
    expect(h.open).toBe(true);
    const id = h.machine.request!.id;
    await h.machine.send(
      async (request) => ({ id: request.id }),
      () => ({}),
    );
    expect(h.done).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      { id },
      "receipt",
    );
    expect(h.machine.request).toBeNull();
    expect(h.open).toBe(false);
    expect(h.phases).toEqual(["form", "sending", null]);
  });

  it("turns a definitive rejection into field errors with a new identity", async () => {
    const h = harness();
    h.machine.begin({ email: "ada@example.com" });
    const first = h.machine.request!.id;
    await h.machine.send(
      async () => {
        throw rejected();
      },
      () => ({ email: "Already taken" }),
    );
    expect(h.machine.request).toMatchObject({
      phase: "form",
      fields: { email: "Already taken" },
    });
    expect(h.machine.request!.id).not.toBe(first);
    expect(h.handlers.read).not.toHaveBeenCalled();
  });

  it("keeps the form after a request that never left this browser", async () => {
    const h = harness();
    h.machine.begin({ email: "ada@example.com" });
    await h.machine.send(
      async () => {
        throw new NotSent("Couldn't prepare the request.");
      },
      () => ({}),
    );
    expect(h.machine.request).toMatchObject({
      phase: "form",
      fields: { form: "Couldn't prepare the request." },
    });
  });

  it("reads the status once after an uncertain outcome and never resends", async () => {
    const step = vi.fn(async () => {
      throw unavailable();
    });
    const h = harness({
      read: vi.fn(async () => ({ kind: "pending" }) as Resolution<Result>),
    });
    h.machine.begin({ email: "ada@example.com" });
    const id = h.machine.request!.id;
    await h.machine.send(step, () => ({}));
    expect(step).toHaveBeenCalledOnce();
    expect(h.handlers.read).toHaveBeenCalledOnce();
    expect(h.machine.request).toMatchObject({ id, phase: "pending" });
    // An unresolved attempt blocks a new form until it is fenced.
    expect(h.machine.begin({ email: "grace@example.com" })).toBe(false);
    expect(h.machine.request!.id).toBe(id);
  });

  it("finishes from the status read when the request committed", async () => {
    const h = harness({
      read: vi.fn(
        async (request: KeyedRequest<Target>) =>
          ({ kind: "done", result: { id: request.id } }) as Resolution<Result>,
      ),
    });
    h.machine.begin({ email: "ada@example.com" });
    const id = h.machine.request!.id;
    await h.machine.send(
      async () => {
        throw unavailable();
      },
      () => ({}),
    );
    expect(h.done).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      { id },
      "status",
    );
    expect(h.machine.request).toBeNull();
  });

  it("marks a failed status read unconfirmed, then retries only after a confirmed cancel", async () => {
    const read = vi.fn(async (): Promise<Resolution<Result>> => {
      throw unavailable();
    });
    const h = harness({ read });
    h.machine.begin({ email: "ada@example.com" });
    const id = h.machine.request!.id;
    await h.machine.send(
      async () => {
        throw unavailable();
      },
      () => ({}),
    );
    expect(h.machine.request).toMatchObject({ id, phase: "unconfirmed" });
    await h.machine.cancelAndRetry();
    expect(h.handlers.cancel).toHaveBeenCalledOnce();
    expect(h.machine.request).toMatchObject({ phase: "form" });
    expect(h.machine.request!.id).not.toBe(id);
  });

  it("keeps an unseen commit for review instead of offering a new form", async () => {
    const h = harness({
      read: vi.fn(async () => ({ kind: "unseen" }) as Resolution<Result>),
    });
    h.machine.begin({ email: "ada@example.com" });
    await h.machine.send(
      async () => {
        throw unavailable();
      },
      () => ({}),
    );
    expect(h.machine.request).toMatchObject({ phase: "unseen" });
  });

  it("never adopts a result after the sign-in changed", async () => {
    const h = harness();
    h.machine.begin({ email: "ada@example.com" });
    const sent = h.machine.send(
      async (request) => {
        h.account.epoch = 2; // Signed in again while the request was out.
        return { id: request.id };
      },
      () => ({}),
    );
    await sent;
    expect(h.done).not.toHaveBeenCalled();
    expect(h.machine.request).toMatchObject({ phase: "changed" });
  });

  it("rechecks after the same administrator signs in again", async () => {
    const h = harness({
      read: vi.fn(
        async (request: KeyedRequest<Target>) =>
          ({ kind: "done", result: { id: request.id } }) as Resolution<Result>,
      ),
    });
    h.machine.begin({ email: "ada@example.com" });
    await h.machine.send(
      async () => {
        h.account.epoch = 2;
        throw unavailable();
      },
      () => ({}),
    );
    expect(h.machine.request).toMatchObject({ phase: "changed" });
    // Another account may not pick it up.
    h.account.userId = "admin-2";
    await h.machine.recheck();
    expect(h.handlers.read).not.toHaveBeenCalled();
    h.account.userId = "admin-1";
    await h.machine.recheck();
    expect(h.done).toHaveBeenCalledOnce();
  });

  it("asks for a new sign-in before sending under a different account", async () => {
    const h = harness();
    h.machine.begin({ email: "ada@example.com" });
    h.account.userId = "admin-2";
    h.account.epoch = 2;
    const step = vi.fn(async () => ({ id: "x" }));
    await h.machine.send(step, () => ({}));
    expect(step).not.toHaveBeenCalled();
    expect(h.machine.request!.fields.form).toMatch(/Sign in again/);
  });

  it("closing forgets a form, reads a send in flight, and keeps the unresolved", async () => {
    const h = harness();
    h.machine.begin({ email: "ada@example.com" });
    h.machine.close();
    expect(h.machine.request).toBeNull();
    expect(h.open).toBe(false);

    h.machine.begin({ email: "ada@example.com" });
    let release: (value: Result) => void = () => {};
    const sending = h.machine.send(
      () => new Promise<Result>((resolve) => (release = resolve)),
      () => ({}),
    );
    await Promise.resolve();
    expect(h.machine.request).toMatchObject({ phase: "sending" });
    h.machine.close();
    release({ id: "late" });
    await sending;
    await Promise.resolve();
    // The late receipt is not adopted; the status read decides.
    expect(h.done).not.toHaveBeenCalled();
    expect(h.handlers.read).toHaveBeenCalledOnce();
  });

  it("an authority change marks unresolved work changed but keeps a typed form", async () => {
    const h = harness();
    h.machine.begin({ email: "ada@example.com" });
    h.machine.authorityChanged();
    expect(h.machine.request).toMatchObject({ phase: "form" });
    await h.machine.send(
      async () => {
        throw unavailable();
      },
      () => ({}),
    );
    expect(h.machine.request).toMatchObject({ phase: "pending" });
    h.machine.authorityChanged();
    expect(h.machine.request).toMatchObject({ phase: "changed" });
    h.machine.forget();
    expect(h.machine.request).toBeNull();
  });
});
