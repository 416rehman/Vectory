import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  beginPublishOperation,
  assertPublishReceipt,
  dismissPublishStorageIssue,
  finishPublishOperation,
  publishOperationAvailable,
  readPublishOperations,
  subscribePublishOperations,
  usePublishOperations,
  type PublishOperation,
} from "./publishRequests";

class BrowserStorage implements Storage {
  readonly values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;
  ignoreWrite = false;
  ignoreRemove = false;
  onWrite?: () => void;
  get length() {
    if (this.failRead) throw Error("Blocked");
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.failRead) throw Error("Blocked");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw Error("Quota");
    this.onWrite?.();
    if (!this.ignoreWrite) this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.failRemove) throw Error("Blocked");
    if (!this.ignoreRemove) this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const actor = "332aa515-d0e8-45a3-a3c9-89d18af8d300";
const other = "521ace4d-0d16-4aac-89c6-cd9912a17763";
const pipeline = "1d151cf3-c43b-4540-b682-2b6d2ae9f637";
const otherPipeline = "371b4321-08d0-4321-8090-403ceb55c123";
const request = { revision: 7, message: "Original publication note" };
const key = (
  operation: Pick<PublishOperation, "actor_id" | "configuration_id" | "id">,
) =>
  `vectory:publish-operation:${encodeURIComponent(operation.actor_id)}:${operation.configuration_id}:${operation.id}`;
const fixture = (
  id = crypto.randomUUID(),
  who = actor,
  config = pipeline,
): PublishOperation => ({
  actor_id: who,
  id,
  configuration_id: config,
  recorded_at: "2026-09-27T00:00:00.000Z",
  request: { ...structuredClone(request), request_id: id },
});
function storageEvent(changedKey: string | null) {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: changedKey });
  return event;
}
let storage: BrowserStorage;
let events: EventTarget;
beforeEach(() => {
  storage = new BrowserStorage();
  events = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", events);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("durable publication registry", () => {
  it("does not read browser storage during disabled rendering and keeps default recovery", () => {
    const operation = beginPublishOperation(actor, pipeline, request);
    const length = vi.spyOn(storage, "length", "get");
    const keyRead = vi.spyOn(storage, "key");
    const itemRead = vi.spyOn(storage, "getItem");
    let observed: ReturnType<typeof usePublishOperations> | undefined;
    function Probe({ enabled }: { enabled?: boolean }) {
      observed = usePublishOperations(actor, pipeline, enabled);
      return null;
    }
    renderToString(createElement(Probe, { enabled: false }));
    expect(observed).toEqual({ operations: [], errors: [] });
    expect(length).not.toHaveBeenCalled();
    expect(keyRead).not.toHaveBeenCalled();
    expect(itemRead).not.toHaveBeenCalled();
    renderToString(createElement(Probe, {}));
    expect(observed?.operations).toEqual([operation]);
    expect(length).toHaveBeenCalled();
    expect(itemRead).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a credential-shaped version note before writing any reminder", () => {
    for (const message of [
      "ghp_syntheticcredential123",
      "https://collector.example/?api_key=short",
    ]) {
      expect(() =>
        beginPublishOperation(actor, pipeline, { ...request, message }),
      ).toThrow(/credential/i);
      expect(storage.length).toBe(0);
    }
  });
  it("persists exact identity and frozen payload before the caller can send, surviving reload", async () => {
    const input = structuredClone(request);
    const operation = beginPublishOperation(actor, pipeline, input);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(operation);
    expect(operation.request.request_id).toBe(operation.id);
    input.revision = 8;
    input.message = "Changed";
    expect(operation.request).toEqual({ ...request, request_id: operation.id });
    expect(Object.isFrozen(operation.request)).toBe(true);
    expect(Object.isFrozen(operation)).toBe(true);
    vi.resetModules();
    const reloaded = await import("./publishRequests");
    expect(reloaded.readPublishOperations(actor, pipeline).operations).toEqual([
      operation,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes storage directly across independent tabs and never erases a peer record", async () => {
    const first = beginPublishOperation(actor, pipeline, request);
    const second = fixture();
    storage.setItem(key(second), JSON.stringify(second));
    vi.resetModules();
    const tab = await import("./publishRequests");
    expect(
      tab
        .readPublishOperations(actor, pipeline)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    finishPublishOperation(first);
    expect(tab.readPublishOperations(actor, pipeline).operations).toEqual([
      second,
    ]);
    expect(storage.getItem(key(second))).not.toBeNull();
    storage.removeItem(key(second));
    expect(readPublishOperations(actor, pipeline).operations).toEqual([]);
  });

  it("uses a fresh read to block another create until existing requests are reviewed", () => {
    expect(readPublishOperations(actor, pipeline).operations).toEqual([]);
    const peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
      /saved publication/,
    );
    expect(storage.length).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains both per-ID records when independent writes interleave after the capacity read", () => {
    const peer = fixture();
    storage.onWrite = () => {
      storage.onWrite = undefined;
      storage.values.set(key(peer), JSON.stringify(peer));
    };
    const operation = beginPublishOperation(actor, pipeline, request);
    expect(
      readPublishOperations(actor, pipeline)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([peer.id, operation.id].sort());
  });

  it("isolates accounts including corrupt records and retains records across sign-out", () => {
    const invalid = fixture();
    storage.setItem(key(invalid), "broken");
    const operation = beginPublishOperation(other, pipeline, request);
    expect(readPublishOperations(other, pipeline)).toEqual({
      operations: [operation],
      errors: [],
    });
    expect(readPublishOperations(actor, pipeline).operations).toEqual([]);
    expect(readPublishOperations(actor, pipeline).errors).toHaveLength(1);
    expect(storage.length).toBe(2);
  });

  it.each(["failWrite", "ignoreWrite", "failRead"] as const)(
    "fails before send when browser storage %s",
    (mode) => {
      storage[mode] = true;
      expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
        /storage/i,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a verified reminder actionable when storage becomes unreadable immediately after writing", () => {
    storage.onWrite = () => {
      storage.failRead = true;
    };
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
      /storage/i,
    );
    expect(readPublishOperations(actor, pipeline).errors[0].kind).toBe(
      "unavailable",
    );
    storage.failRead = false;
    expect(readPublishOperations(actor, pipeline).operations).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds visible records, preserves overflow and blocks new creation without TTL expiry", () => {
    for (let index = 0; index < 11; index++) {
      const operation = fixture();
      storage.setItem(key(operation), JSON.stringify(operation));
    }
    const current = readPublishOperations(actor, pipeline);
    expect(current.operations).toHaveLength(10);
    expect(current.errors.some((issue) => issue.kind === "capacity")).toBe(
      true,
    );
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
      /Additional publication/,
    );
    finishPublishOperation(current.operations[0]);
    expect(readPublishOperations(actor, pipeline).operations).toHaveLength(10);
    expect(readPublishOperations(actor, pipeline).errors).toEqual([]);
    expect(storage.length).toBe(10);
  });

  it("rejects malformed, cross-actor, mismatched-ID and overlarge records without deleting uncertainty", () => {
    const operation = fixture();
    for (const raw of [
      "{",
      "x".repeat(16_385),
      JSON.stringify({ ...operation, actor_id: other }),
      JSON.stringify({
        ...operation,
        request: { ...operation.request, request_id: other },
      }),
      JSON.stringify({ ...operation, extra: "unknown" }),
    ]) {
      storage.setItem(key(operation), raw);
      const current = readPublishOperations(actor, pipeline);
      expect(current.operations).toEqual([]);
      expect(current.errors[0]).toMatchObject({
        kind: "corrupt",
        id: operation.id,
      });
      expect(storage.getItem(key(operation))).toBe(raw);
      expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
        /cannot be read/,
      );
    }
  });

  it("a separate corrupt record blocks new creates but not safe exact retry of a valid request", () => {
    const operation = beginPublishOperation(actor, pipeline, request),
      invalid = fixture();
    storage.setItem(key(invalid), "corrupt");
    expect(publishOperationAvailable(operation)).toBe(true);
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
      /cannot be read/,
    );
  });

  it("never overwrites the same ID and refuses cleanup if its frozen payload changed", () => {
    const operation = beginPublishOperation(actor, pipeline, request);
    const replacement = {
      ...operation,
      request: { ...operation.request, message: "Different" },
    };
    storage.setItem(key(operation), JSON.stringify(replacement));
    expect(publishOperationAvailable(operation)).toBe(false);
    expect(() => finishPublishOperation(operation)).toThrow(/reminder/);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(replacement);
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow();
    expect(storage.length).toBe(1);
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "reports cleanup %s and retains the exact request for another attempt",
    (mode) => {
      const operation = beginPublishOperation(actor, pipeline, request);
      storage[mode] = true;
      expect(() => finishPublishOperation(operation)).toThrow(/reminder/);
      expect(readPublishOperations(actor, pipeline).operations).toEqual([
        operation,
      ]);
      storage[mode] = false;
      finishPublishOperation(operation);
      finishPublishOperation(operation);
      expect(readPublishOperations(actor, pipeline).operations).toEqual([]);
    },
  );

  it("equivalent property order is not a changed request, but other operations remain untouched", () => {
    const operation = beginPublishOperation(actor, pipeline, request),
      peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    storage.setItem(
      key(operation),
      JSON.stringify({
        request: {
          request_id: operation.id,
          message: request.message,
          revision: request.revision,
        },
        recorded_at: operation.recorded_at,
        id: operation.id,
        actor_id: actor,
        configuration_id: pipeline,
      }),
    );
    finishPublishOperation(operation);
    expect(readPublishOperations(actor, pipeline).operations).toEqual([peer]);
  });

  it("requires deliberate exact corrupt-record dismissal and refuses a later repaired record", () => {
    const operation = fixture();
    storage.setItem(key(operation), "broken");
    const issue = readPublishOperations(actor, pipeline).errors[0];
    storage.setItem(key(operation), JSON.stringify(operation));
    expect(() => dismissPublishStorageIssue(issue)).toThrow(/reminder/);
    expect(readPublishOperations(actor, pipeline).operations).toEqual([
      operation,
    ]);
    storage.setItem(key(operation), "still broken");
    dismissPublishStorageIssue(
      readPublishOperations(actor, pipeline).errors[0],
    );
    expect(storage.length).toBe(0);
  });

  it("validates UTF-8 messages, exact revisions and unknown fields before retaining or sending", () => {
    for (const invalid of [
      { ...request, message: "\u{1f600}".repeat(501) },
      { ...request, revision: 0 },
      { ...request, revision: 1.5 },
      { ...request, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, request_id: other },
      { ...request, config: {} },
      { ...request, artifact: "secret config" },
    ]) {
      expect(() => beginPublishOperation(actor, pipeline, invalid)).toThrow();
      expect(storage.length).toBe(0);
    }
    const operation = beginPublishOperation(actor, pipeline, {
      revision: Number.MAX_SAFE_INTEGER,
      message: "\u{1f600}".repeat(500),
    });
    expect(operation.request.message).toBe("\u{1f600}".repeat(500));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a chosen Publish anyway in the saved request, so a recovered retry repeats it exactly", () => {
    const plain = beginPublishOperation(actor, pipeline, request);
    expect(plain.request).not.toHaveProperty("acknowledge_test_failures");
    finishPublishOperation(plain);
    const anyway = beginPublishOperation(actor, pipeline, {
      ...request,
      acknowledge_test_failures: true,
    });
    expect(anyway.request.acknowledge_test_failures).toBe(true);
    // What a reload reads back is what was saved, flag included.
    const [reread] = readPublishOperations(actor, pipeline).operations;
    expect(reread.request).toEqual({
      ...request,
      acknowledge_test_failures: true,
      request_id: anyway.id,
    });
    expect(JSON.parse(JSON.stringify(reread.request))).toEqual(reread.request);
    // Only an explicit true is an acknowledgement.
    finishPublishOperation(anyway);
    for (const invalid of [false, "true", 1, null]) {
      expect(() =>
        beginPublishOperation(actor, pipeline, {
          ...request,
          acknowledge_test_failures: invalid,
        } as never),
      ).toThrow();
    }
    expect(storage.length).toBe(0);
  });

  it("isolates pipeline requests and scoped corruption while unknown scope blocks conservatively", () => {
    const first = beginPublishOperation(actor, pipeline, request);
    const second = beginPublishOperation(actor, otherPipeline, request);
    expect(readPublishOperations(actor, pipeline).operations).toEqual([first]);
    expect(readPublishOperations(actor, otherPipeline).operations).toEqual([
      second,
    ]);
    storage.setItem(key(second), "broken");
    finishPublishOperation(first);
    expect(readPublishOperations(actor, pipeline).errors).toEqual([]);
    beginPublishOperation(actor, pipeline, request);
    expect(readPublishOperations(actor, otherPipeline).errors[0].kind).toBe(
      "corrupt",
    );
    storage.setItem(
      `vectory:publish-operation:${actor}:unknown-scope`,
      "broken",
    );
    expect(
      readPublishOperations(actor, pipeline).errors[0].configuration_id,
    ).toBeUndefined();
    expect(readPublishOperations(actor, otherPipeline).errors).toHaveLength(2);
  });

  it("enforces the account-wide capacity across independent pipelines before another request can send", () => {
    for (let i = 0; i < 10; i++) {
      const op = fixture(crypto.randomUUID(), actor, crypto.randomUUID());
      storage.setItem(key(op), JSON.stringify(op));
    }
    expect(readPublishOperations(actor, pipeline)).toEqual({
      operations: [],
      errors: [],
    });
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow(
      /ten saved/,
    );
    expect(storage.length).toBe(10);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never reuses a request ID in another pipeline or overwrites its original payload", () => {
    const existing = fixture(crypto.randomUUID(), actor, otherPipeline);
    storage.setItem(key(existing), JSON.stringify(existing));
    vi.stubGlobal("crypto", { randomUUID: () => existing.id });
    expect(() => beginPublishOperation(actor, pipeline, request)).toThrow();
    expect(storage.length).toBe(1);
    expect(JSON.parse(storage.getItem(key(existing))!)).toEqual(existing);
  });

  it("requires receipt identity, parent, source revision and exact message to match the frozen request", () => {
    const op = beginPublishOperation(actor, pipeline, request);
    const receipt = {
      request_id: op.id,
      configuration_id: pipeline,
      source_revision: 7,
      message: request.message,
    };
    expect(() => assertPublishReceipt(op, receipt)).not.toThrow();
    for (const change of [
      { request_id: other },
      { configuration_id: otherPipeline },
      { source_revision: 8 },
      { message: "New message" },
    ]) {
      expect(() => assertPublishReceipt(op, { ...receipt, ...change })).toThrow(
        /does not match/,
      );
      expect(publishOperationAvailable(op)).toBe(true);
    }
  });

  it("refreshes on same-window changes, scoped storage events, focus and pageshow; disposal stops callbacks", () => {
    const refresh = vi.fn(),
      stop = subscribePublishOperations(actor, pipeline, refresh);
    const operation = beginPublishOperation(actor, pipeline, request);
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(
      storageEvent(
        key({ actor_id: other, configuration_id: pipeline, id: operation.id }),
      ),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(
      storageEvent(key({ ...operation, configuration_id: otherPipeline })),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(storageEvent(key(operation)));
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("pageshow"));
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
    finishPublishOperation(operation);
    events.dispatchEvent(storageEvent(null));
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
