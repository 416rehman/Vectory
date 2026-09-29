import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedAPI, boundedPost, withRequestDeadline } from "./api";
import { isDeploymentActionRejection } from "./deploymentRequests";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("bounded deployment requests", () => {
  it("cancels abandoned reads even when transport ignores abort and clears their deadlines", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = withRequestDeadline(
      (current) => {
        signal = current;
        return new Promise(() => {});
      },
      1000,
      parent.signal,
    ).catch((error: unknown) => error);
    parent.abort();
    expect(await pending).toBe(parent.signal.reason);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start a read already canceled by its owner", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    parent.abort();
    const request = vi.fn();
    await expect(
      withRequestDeadline(request, 1000, parent.signal),
    ).rejects.toBe(parent.signal.reason);
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases a stalled mutation into uncertainty even if transport ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finish!: (value: string) => void;
    const delivered = vi.fn();
    const pending = withRequestDeadline((current) => {
      signal = current;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    }, 1000)
      .then(delivered)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    expect(error).toMatchObject({ code: "REQUEST_TIMEOUT", status: 0 });
    expect(isDeploymentActionRejection(error)).toBe(false);
    expect(signal?.aborted).toBe(true);
    finish("late commit response");
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("covers a stalled response body, not only waiting for headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => new Promise(() => {}),
      }),
    );
    const pending = boundedPost(
      "/deployments",
      { request_id: "frozen" },
      1000,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ code: "REQUEST_TIMEOUT" });
  });
  it("keeps timely success and clears the deadline", async () => {
    vi.useFakeTimers();
    const result = {
      request_id: "00000000-0000-4000-8000-000000000001",
      found: false,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(result), { status: 200 }),
        ),
    );
    expect(
      await boundedAPI(
        "/deployments/requests/00000000-0000-4000-8000-000000000001",
        1000,
      ),
    ).toEqual(result);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves a non-keyed action rejection without leaving a timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '{"error":{"code":"INVALID_INPUT","message":"Review the request"}}',
            { status: 400 },
          ),
        ),
    );
    const error = await boundedPost(
      "/deployments/example/pause",
      {},
      1000,
    ).catch((failure: unknown) => failure);
    expect(isDeploymentActionRejection(error)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
