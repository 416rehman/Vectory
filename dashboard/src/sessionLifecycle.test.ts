import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  can,
  getSessionEpoch,
  invalidateSession,
  isSessionValid,
  setCSRF,
} from "./api";

beforeEach(() => setCSRF("synthetic-active-session"));

afterEach(() => {
  setCSRF("");
  vi.unstubAllGlobals();
});

describe("session expiration while requests are in flight", () => {
  it("immediately rejects a held mutation and blocks new protected reads and writes", async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input: unknown, options?: RequestInit) => {
      signal = options?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetch);
    const accepted = vi.fn();
    const pending = api("/deployments/held/unassign", {
      method: "POST",
      body: "{}",
    })
      .then(accepted)
      .catch((error) => error);
    invalidateSession();
    expect(await pending).toMatchObject({
      code: "SESSION_ENDED",
      status: 0,
      serverRejection: false,
    });
    expect(signal?.aborted).toBe(true);
    await expect(api("/deployments/held/summary")).rejects.toMatchObject({
      code: "SESSION_ENDED",
    });
    await expect(
      api("/deployments/held/unassign", { method: "POST" }),
    ).rejects.toMatchObject({ code: "SESSION_ENDED" });
    expect(fetch).toHaveBeenCalledOnce();
    finish(new Response(JSON.stringify({ id: "held", status: "unassigned" })));
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
  });
  it("rejects an old response body even after explicit reauthentication", async () => {
    let body!: (value: string) => void;
    const text = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          body = resolve;
        }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text });
    vi.stubGlobal("fetch", fetch);
    const accepted = vi.fn();
    const pending = api("/protected-recovery")
      .then(accepted)
      .catch((error) => error);
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
    const oldEpoch = getSessionEpoch();
    invalidateSession();
    expect(await pending).toMatchObject({ code: "SESSION_ENDED" });
    setCSRF("new-explicit-login");
    expect(getSessionEpoch()).toBeGreaterThan(oldEpoch);
    body(JSON.stringify({ saved: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ current: true })),
    );
    await expect(api("/protected-recovery")).resolves.toEqual({
      current: true,
    });
  });
  it("keeps public recovery available without letting a session probe revive old permission", async () => {
    const user = {
      id: "operator",
      name: "Operator",
      email: "operator@example.test",
      role: "operator" as const,
      enabled: true,
      revision: 1,
    };
    invalidateSession();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ initialized: true, version: "synthetic" }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(api("/status")).resolves.toEqual({
      initialized: true,
      version: "synthetic",
    });
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ user, csrf_token: "another-session" })),
    );
    await expect(api("/session")).resolves.toMatchObject({
      user: { id: "operator" },
    });
    expect(isSessionValid()).toBe(false);
    expect(can(user, "operate")).toBe(false);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ user, csrf_token: "explicit-sign-in" })),
    );
    const result = await api<{ csrf_token: string }>("/login", {
      method: "POST",
    });
    expect(isSessionValid()).toBe(false);
    setCSRF(result.csrf_token);
    expect(isSessionValid()).toBe(true);
    expect(can(user, "operate")).toBe(true);
  });
  it("keeps normal credential rotation in the current valid epoch", () => {
    const epoch = getSessionEpoch();
    setCSRF("same-user-password-rotation");
    expect(getSessionEpoch()).toBe(epoch);
    invalidateSession();
    const endedEpoch = getSessionEpoch();
    setCSRF("same-user-password-rotation");
    expect(getSessionEpoch()).toBeGreaterThan(endedEpoch);
    expect(isSessionValid()).toBe(true);
  });
  it("a current unauthorized request invalidates other held requests while retaining its own authoritative error", async () => {
    let heldSignal: AbortSignal | undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce((_path: unknown, options: RequestInit) => {
        heldSignal = options.signal ?? undefined;
        return new Promise<Response>(() => {});
      })
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "UNAUTHENTICATED", message: "Session expired" },
          }),
          { status: 401 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const held = api("/held").catch((error) => error);
    await expect(api("/account")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
    expect(await held).toMatchObject({ code: "SESSION_ENDED" });
    expect(heldSignal?.aborted).toBe(true);
    expect(isSessionValid()).toBe(false);
  });
  it("releases an aborted owner without waiting for a transport that ignores cancellation", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const pending = api("/held", { signal: controller.signal }).catch(
      (error) => error,
    );
    controller.abort(new Error("Owner closed"));
    expect(await pending).toBe(controller.signal.reason);
    invalidateSession();
  });
  it("announces rotation across tabs without persisting the token or repeating unchanged announcements", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      localStorage: { setItem },
    });
    setCSRF("synthetic-private-csrf-token");
    setCSRF("synthetic-private-csrf-token");
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem.mock.calls[0][0]).toBe("vectory-session-change");
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(
      "synthetic-private-csrf-token",
    );
  });
  it("does not let an old request expire a newly rotated session", async () => {
    const events = new EventTarget(),
      ended = vi.fn();
    events.addEventListener("vectory:session-ended", ended);
    vi.stubGlobal("window", events);
    let complete!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    setCSRF("before-password-change");
    const request = api("/mfa");
    const rejected = expect(request).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    setCSRF("fresh-session");
    complete(
      new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
      }),
    );
    await rejected;
    expect(ended).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]).toBeDefined();
  });

  it("only reports a revoked authenticated session, not rejected sign-in credentials", async () => {
    const events = new EventTarget(),
      ended = vi.fn();
    events.addEventListener("vectory:session-ended", ended);
    vi.stubGlobal("window", events);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    setCSRF("current-session");
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "WRONG_PASSWORD" } }), {
        status: 403,
      }),
    );
    await expect(
      api("/account/password", { method: "POST" }),
    ).rejects.toMatchObject({ code: "WRONG_PASSWORD" });
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
      }),
    );
    await expect(
      api("/password-reset", { method: "POST" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
      }),
    );
    await expect(api("/login/mfa", { method: "POST" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(ended).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
        status: 401,
      }),
    );
    await expect(api("/mfa")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(ended).toHaveBeenCalledOnce();
  });
});
