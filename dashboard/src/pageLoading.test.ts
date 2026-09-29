import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPage, PageLoadError, pageFailureKind } from "./pageLoading";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

describe("bounded lazy page loading", () => {
  it("preserves the exact loaded module and removes the deadline after timely completion", async () => {
    vi.useFakeTimers();
    const module = { default: () => null };
    const source = deferred<typeof module>();
    const loader = vi.fn(() => source.promise);
    const loaded = loadPage(loader);
    await vi.advanceTimersByTimeAsync(29999);
    source.resolve(module);
    expect(await loaded).toBe(module);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await loaded).toBe(module);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("sanitizes asynchronous import rejection without retaining its original payload", async () => {
    vi.useFakeTimers();
    const privateMessage = "failed private-module-path?private-value";
    const original = new Error(privateMessage);
    const loader = vi.fn(() => Promise.reject(original));
    const error = await loadPage(loader).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PageLoadError);
    expect(error).not.toBe(original);
    expect(error).toMatchObject({
      kind: "load",
      message: "Page files could not be loaded.",
    });
    expect(String(error)).not.toContain(privateMessage);
    expect(error).not.toHaveProperty("cause");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns a synchronous loader throw into the same sanitized failure and clears its timer", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(() => {
      throw { unexpected: "private source content" };
    });
    const error = await loadPage(loader).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PageLoadError);
    expect(pageFailureKind(error)).toBe("load");
    expect(error).not.toHaveProperty("unexpected");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes branded load failures from arbitrary render errors and lookalikes", () => {
    expect(pageFailureKind(new PageLoadError("load"))).toBe("load");
    expect(pageFailureKind(new PageLoadError("timeout"))).toBe("timeout");
    for (const error of [
      new Error("Failed to fetch dynamically imported module"),
      Object.assign(new Error("Page files could not be loaded."), {
        name: "PageLoadError",
        kind: "load",
      }),
      { name: "PageLoadError", kind: "timeout" },
      "Page loading timed out.",
      null,
      undefined,
    ])
      expect(pageFailureKind(error)).toBe("render");
  });

  it("ends the default wait at thirty seconds without retrying the import", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(() => new Promise<never>(() => {}));
    const settled = vi.fn();
    const loaded = loadPage(loader).then(settled, (error: unknown) => {
      settled(error);
      return error;
    });
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await loaded).toMatchObject({
      kind: "timeout",
      message: "Page loading timed out.",
    });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish a module that arrives after its wait timed out", async () => {
    vi.useFakeTimers();
    const source = deferred<{ default: () => null }>();
    const loader = vi.fn(() => source.promise);
    const accepted = vi.fn();
    const loaded = loadPage(loader)
      .then(accepted)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30000);
    const failure = await loaded;
    source.resolve({ default: () => null });
    await vi.advanceTimersByTimeAsync(0);
    expect(await loaded).toBe(failure);
    expect(pageFailureKind(failure)).toBe("timeout");
    expect(accepted).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a late import rejection without replacing the original timeout or leaking an unhandled rejection", async () => {
    vi.useFakeTimers();
    const source = deferred<never>();
    const loader = vi.fn(() => source.promise);
    const rejected = vi.fn((error: unknown) => error);
    const loaded = loadPage(loader).catch(rejected);
    await vi.advanceTimersByTimeAsync(30000);
    const failure = await loaded;
    source.reject(new Error("late private-module-path rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await loaded).toBe(failure);
    expect(pageFailureKind(failure)).toBe("timeout");
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // Vitest also reports any unhandled rejection as a suite error.
  });
});
