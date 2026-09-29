import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  activeReads,
  readPath,
  subscribe,
  type ReadOutcome,
  type Reader,
} from "./sharedReads";

type Pending = {
  url: string;
  signal: AbortSignal;
  answer(value: unknown, status?: number): void;
};
/** A fetch that waits for the test to answer each request. */
function stubFetch() {
  const pending: Pending[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () =>
          reject(signal.reason ?? new DOMException("aborted", "AbortError")),
        );
        pending.push({
          url,
          signal,
          answer: (value, status = 200) =>
            resolve(new Response(JSON.stringify(value), { status })),
        });
      }),
  );
  return pending;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function reader() {
  const received: ReadOutcome[] = [];
  const each: Reader = { receive: (outcome) => received.push(outcome) };
  return { each, received };
}
const released: (() => void)[] = [];
const join = (path: string, each: Reader) => {
  const release = subscribe(path, each);
  released.push(release);
  return release;
};
afterEach(() => {
  while (released.length) released.pop()!();
  vi.unstubAllGlobals();
});

describe("shared reads", () => {
  it("gives every reader of a path the one answer to one request", async () => {
    const pending = stubFetch();
    const a = reader(),
      b = reader();
    join("/test/inventory", a.each);
    join("/test/inventory", b.each);
    const first = readPath("/test/inventory", a.each, "join");
    const second = readPath("/test/inventory", b.each, "join");
    expect(pending).toHaveLength(1);
    pending[0].answer({ total: 3 });
    expect(await first).toEqual({ total: 3 });
    expect(await second).toEqual({ total: 3 });
    expect(a.received).toMatchObject([{ ok: true, data: { total: 3 } }]);
    expect(b.received).toMatchObject([{ ok: true, data: { total: 3 } }]);
  });

  it("keeps one request in flight per path, however often a poll fires", async () => {
    const pending = stubFetch();
    const a = reader();
    join("/test/overview", a.each);
    void readPath("/test/overview", a.each, "join");
    void readPath("/test/overview", a.each, "poll", 7500);
    void readPath("/test/overview", a.each, "poll", 7500);
    expect(pending).toHaveLength(1);
    pending[0].answer({ n: 1 });
    await flush();
    // Its own next tick reads again; nothing throttles a reader's own poll.
    void readPath("/test/overview", a.each, "poll", 7500);
    expect(pending).toHaveLength(2);
  });

  it("lets a second poller adopt an answer the first one just fetched", async () => {
    const pending = stubFetch();
    const page = reader(),
      dialog = reader();
    join("/test/groups", page.each);
    join("/test/groups", dialog.each);
    void readPath("/test/groups", page.each, "poll", 7500);
    pending[0].answer([]);
    await flush();
    // The dialog's tick lands moments later: the page's answer already reached it.
    await readPath("/test/groups", dialog.each, "poll", 7500);
    expect(pending).toHaveLength(1);
    expect(dialog.received).toHaveLength(1);
    // Once the answer is older than half an interval it asks again.
    void readPath("/test/groups", dialog.each, "poll", 0);
    expect(pending).toHaveLength(2);
  });

  it("starts a fresh read for a reader that arrives after a change was sent", async () => {
    const pending = stubFetch();
    const page = reader(),
      dialog = reader();
    join("/test/groups", page.each);
    void readPath("/test/groups", page.each, "join");
    expect(pending).toHaveLength(1);
    // A change goes out while that read is still in flight.
    const change = api("/test/change", { method: "POST", body: "{}" });
    expect(pending).toHaveLength(2);
    pending[1].answer({ id: "g" });
    await change;
    join("/test/groups", dialog.each);
    const later = readPath("/test/groups", dialog.each, "join");
    // The read that began before the change is replaced, not shared.
    expect(pending).toHaveLength(3);
    expect(pending[0].signal.aborted).toBe(true);
    pending[2].answer([{ id: "g" }]);
    expect(await later).toEqual([{ id: "g" }]);
    expect(page.received).toMatchObject([{ ok: true, data: [{ id: "g" }] }]);
  });

  it("joins a read that began after the latest change", async () => {
    const pending = stubFetch();
    const page = reader(),
      dialog = reader();
    join("/test/inventory", page.each);
    void readPath("/test/inventory", page.each, "join");
    join("/test/inventory", dialog.each);
    void readPath("/test/inventory", dialog.each, "join");
    expect(pending).toHaveLength(1);
    expect(pending[0].signal.aborted).toBe(false);
  });

  it("replaces a read in flight when a reader asks for a fresh one", async () => {
    const pending = stubFetch();
    const a = reader(),
      b = reader();
    join("/test/x", a.each);
    join("/test/x", b.each);
    const waiting = readPath("/test/x", a.each, "join");
    const refreshed = readPath("/test/x", b.each, "fresh");
    expect(pending).toHaveLength(2);
    expect(pending[0].signal.aborted).toBe(true);
    // The older answer can't land after the newer one, and the one who
    // waited on it takes the newer answer.
    pending[1].answer({ n: 2 });
    expect(await refreshed).toEqual({ n: 2 });
    expect(await waiting).toEqual({ n: 2 });
    expect(a.received).toMatchObject([{ ok: true, data: { n: 2 } }]);
    expect(b.received).toMatchObject([{ ok: true, data: { n: 2 } }]);
  });

  it("aborts a read only when the last reader leaves", async () => {
    const pending = stubFetch();
    const a = reader(),
      b = reader();
    const leaveA = join("/test/y", a.each);
    const leaveB = join("/test/y", b.each);
    void readPath("/test/y", a.each, "join");
    leaveA();
    expect(pending[0].signal.aborted).toBe(false);
    pending[0].answer({ n: 1 });
    await flush();
    expect(a.received).toHaveLength(0);
    expect(b.received).toHaveLength(1);
    void readPath("/test/y", b.each, "fresh");
    leaveB();
    expect(pending[1].signal.aborted).toBe(true);
    expect(activeReads().filter((read) => read.path === "/test/y")).toEqual([]);
    // A reader that left starts nothing.
    expect(await readPath("/test/y", b.each, "fresh")).toBeUndefined();
    expect(pending).toHaveLength(2);
  });

  it("tells every reader about a failure and keeps aborts to itself", async () => {
    const pending = stubFetch();
    const a = reader(),
      b = reader();
    join("/test/z", a.each);
    join("/test/z", b.each);
    void readPath("/test/z", a.each, "join");
    pending[0].answer({ error: { code: "BUSY", message: "Busy" } }, 503);
    await flush();
    for (const each of [a, b])
      expect(each.received).toMatchObject([
        { ok: false, error: { code: "BUSY", status: 503 } },
      ]);
  });
});
