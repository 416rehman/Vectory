import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError, type GroupMembershipPreview } from "./api";
import {
  AUTO_PREVIEW,
  BUSY_PREVIEW_RETRIES,
  membershipSentence,
  previewBusy,
  previewWanted,
  previewWithRetries,
  readUnavailableMembers,
} from "./groupMembership";

type Entry = GroupMembershipPreview["devices"][number];
const state = (version: number | null, name = "Web access logs") => ({
  assignment_id: "a",
  assignment_name: null,
  version_id: version ? `v${version}` : null,
  configuration_name: version ? name : null,
  version_number: version,
  generation: 1,
  policy: version
    ? null
    : { heartbeat_seconds: 60, sync_paused: false, telemetry_enabled: true },
});
const unchanged = { changed: false, before: null, after: null, pending: null };

describe("membership change sentences", () => {
  it("says what adding a device deploys", () => {
    const entry: Entry = {
      device_id: "d",
      device_name: "web-01",
      change: "added",
      configuration: {
        changed: true,
        before: null,
        after: state(3),
        pending: null,
      },
      policy: {
        changed: true,
        before: null,
        after: state(null),
        pending: null,
      },
    };
    expect(membershipSentence(entry, "web-01")).toBe(
      "Adding web-01 deploys Web access logs v3 and applies agent settings (sync on · check-ins every 1 min).",
    );
  });
  it("says what removing a device leaves running", () => {
    const entry: Entry = {
      device_id: "d",
      device_name: "edge-02",
      change: "removed",
      configuration: {
        changed: true,
        before: state(2),
        after: null,
        pending: null,
      },
      policy: unchanged,
    };
    expect(membershipSentence(entry, "edge-02")).toBe(
      "Removing edge-02 stops managing its pipeline; it keeps running Web access logs v2.",
    );
    expect(
      membershipSentence({ ...entry, configuration: unchanged }, "edge-02"),
    ).toBe("Removing edge-02 changes nothing on it.");
  });
});

describe("a busy membership preview", () => {
  const busy = () =>
    new APIError("CAPACITY_BUSY", "Preview busy, retrying", 429, true, 1);
  const attempts = (outcomes: (Error | string)[]) => {
    let calls = 0;
    const request = async () => {
      const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    return { request, calls: () => calls };
  };

  it("is asked again once a second, quietly, until it answers", async () => {
    const { request, calls } = attempts([busy(), busy(), "preview"]);
    const waits: number[] = [];
    const result = await previewWithRetries(
      request,
      new AbortController().signal,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("preview");
    expect(calls()).toBe(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it("shows the error once it stays busy a few times", async () => {
    const { request, calls } = attempts([busy()]);
    const failure = await previewWithRetries(
      request,
      new AbortController().signal,
      async () => {},
    ).catch((error: unknown) => error);
    expect(previewBusy(failure)).toBe(true);
    expect(calls()).toBe(1 + BUSY_PREVIEW_RETRIES);
  });

  it("never retries any other failure", async () => {
    const conflict = new APIError("CONFLICT", "Changed", 409, true);
    const throttled = new APIError("RATE_LIMITED", "Too many", 429, true, 30);
    for (const error of [conflict, throttled]) {
      const { request, calls } = attempts([error]);
      await expect(
        previewWithRetries(request, new AbortController().signal, async () => {
          throw new Error("waited");
        }),
      ).rejects.toBe(error);
      expect(previewBusy(error)).toBe(false);
      expect(calls()).toBe(1);
    }
  });

  it("stops retrying when the edit moves on", async () => {
    vi.useFakeTimers();
    try {
      const { request, calls } = attempts([busy(), "preview"]);
      const controller = new AbortController();
      const pending = previewWithRetries(request, controller.signal);
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      controller.abort(new Error("edited"));
      expect(await settled).toEqual(new Error("edited"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("when an edit is previewed", () => {
  it("reads a small edit's preview at once and a large one's only when asked", () => {
    expect(AUTO_PREVIEW).toBe(500);
    expect(previewWanted(0, "", "")).toBe(false);
    expect(previewWanted(1, "a|b", "")).toBe(true);
    expect(previewWanted(500, "a|b", "")).toBe(true);
    expect(previewWanted(501, "a|b", "")).toBe(false);
    // Asked for this very edit; a different edit asks again.
    expect(previewWanted(4750, "a|b", "a|b")).toBe(true);
    expect(previewWanted(4751, "a|b,c", "a|b")).toBe(false);
  });
});

describe("members the server no longer knows", () => {
  afterEach(() => vi.unstubAllGlobals());
  const member = (id: string, unavailable = false) => ({
    id,
    name: unavailable ? null : `device ${id}`,
    status: unavailable ? "unavailable" : "verified",
  });
  /** A group whose member list is `list`, served a page at a time. */
  function serve(list: ReturnType<typeof member>[]) {
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://synthetic.test");
        reads.push(url.pathname.replace("/api/v1", "") + url.search);
        const page = Number(url.searchParams.get("page"));
        const size = Number(url.searchParams.get("page_size"));
        return new Response(
          JSON.stringify({
            items: list.slice((page - 1) * size, page * size),
            total: list.length,
            page,
            page_size: size,
          }),
        );
      }),
    );
    return reads;
  }
  const known = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`k${i}`));
  const gone = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`u${i}`, true));
  const signal = () => new AbortController().signal;

  it("reads only the last page of a group that has none", async () => {
    const reads = serve(known(250));
    expect(await readUnavailableMembers("g1", 250, signal())).toEqual([]);
    expect(reads).toEqual(["/groups/g1/members?page=3&page_size=100"]);
  });

  it("finds them at the end, in order, without listing the group", async () => {
    const reads = serve([...known(4748), ...gone(2)]);
    expect(await readUnavailableMembers("g1", 4750, signal())).toEqual([
      "u0",
      "u1",
    ]);
    expect(reads).toEqual(["/groups/g1/members?page=48&page_size=100"]);
  });

  it("goes back a page while a whole page is unavailable, and stops at five", async () => {
    let reads = serve([...known(50), ...gone(150)]);
    expect((await readUnavailableMembers("g1", 200, signal())).length).toBe(
      150,
    );
    expect(reads).toHaveLength(2);
    reads = serve(gone(900));
    expect((await readUnavailableMembers("g1", 900, signal())).length).toBe(
      500,
    );
    expect(reads).toHaveLength(5);
  });

  it("reads one page for an empty group", async () => {
    const reads = serve([]);
    expect(await readUnavailableMembers("g1", 0, signal())).toEqual([]);
    expect(reads).toHaveLength(1);
  });
});
