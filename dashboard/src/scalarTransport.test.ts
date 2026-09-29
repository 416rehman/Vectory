import { afterEach, describe, expect, it, vi } from "vitest";
import { scalarFetch } from "./scalarTransport";

afterEach(() => {
  vi.unstubAllGlobals();
});
function environment() {
  vi.stubGlobal("window", {
    location: { origin: "https://vectory.example.test" },
  });
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("same-origin Scalar API execution", () => {
  it("rejects foreign origins and agent protocol before fetching credentials", async () => {
    const fetcher = environment();
    for (const target of [
      "https://foreign.example.test/api/v1/devices",
      "https://vectory.example.test/agent/v1/enroll",
      "https://vectory.example.test/api/v1/../../agent/v1/enroll",
      "https://name:password@vectory.example.test/api/v1/devices",
    ]) {
      await expect(
        scalarFetch(target, { method: "POST", body: "{}" }),
      ).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves request body and attaches only the current session CSRF", async () => {
    const fetcher = environment();
    fetcher.mockResolvedValueOnce(
      Response.json({ csrf_token: "current-session-token" }),
    );
    fetcher.mockResolvedValueOnce(Response.json({ accepted: true }));
    const request = new Request(
      "https://vectory.example.test/api/v1/deployments/preview",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "stale-user-input",
        },
        body: JSON.stringify({ selector: { device_ids: [] } }),
      },
    );
    await scalarFetch(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe("/api/v1/session");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    const sent = fetcher.mock.calls[1][0] as Request;
    expect(sent.headers.get("X-CSRF-Token")).toBe("current-session-token");
    expect(sent.credentials).toBe("same-origin");
    expect(sent.redirect).toBe("error");
    expect(await sent.json()).toEqual({ selector: { device_ids: [] } });
  });
  it("reads without loading or attaching CSRF and refuses redirect following", async () => {
    const fetcher = environment();
    fetcher.mockResolvedValue(Response.json({ initialized: true }));
    await scalarFetch("/api/v1/status", {
      headers: { "X-CSRF-Token": "unneeded" },
      credentials: "include",
      redirect: "follow",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = fetcher.mock.calls[0][0] as Request;
    expect(sent.headers.has("X-CSRF-Token")).toBe(false);
    expect(sent.credentials).toBe("same-origin");
    expect(sent.redirect).toBe("error");
  });
  it("does not issue a mutation after expired or malformed session responses", async () => {
    for (const response of [
      new Response(null, { status: 401 }),
      Response.json({ user: { id: "missing-csrf" } }),
    ]) {
      const fetcher = environment();
      fetcher.mockResolvedValue(response);
      await expect(
        scalarFetch("/api/v1/logout", { method: "POST", body: "{}" }),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
