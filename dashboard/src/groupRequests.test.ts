import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginGroupOperation,
  dismissGroupStorageIssue,
  finishGroupOperation,
  groupOperationAvailable,
  readGroupOperations,
  subscribeGroupOperations,
  type GroupOperation,
} from "./groupRequests";

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
const device = "1d151cf3-c43b-4540-b682-2b6d2ae9f637";
const request = {
  name: "Synthetic group",
  description: "Original details",
  device_ids: [device],
};
const key = (operation: Pick<GroupOperation, "actor_id" | "id">) =>
  `vectory:group-operation:${encodeURIComponent(operation.actor_id)}:${operation.id}`;
const fixture = (id = crypto.randomUUID(), who = actor): GroupOperation => ({
  actor_id: who,
  id,
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

describe("durable group creation registry", () => {
  it("persists exact identity and frozen payload before the caller can send, surviving reload", async () => {
    const input = structuredClone(request);
    const operation = beginGroupOperation(actor, input);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(operation);
    expect(operation.request.request_id).toBe(operation.id);
    input.device_ids.length = 0;
    input.name = "Changed";
    expect(operation.request).toEqual({ ...request, request_id: operation.id });
    expect(Object.isFrozen(operation.request.device_ids)).toBe(true);
    expect(Object.isFrozen(operation)).toBe(true);
    vi.resetModules();
    const reloaded = await import("./groupRequests");
    expect(reloaded.readGroupOperations(actor).operations).toEqual([operation]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes storage directly across independent tabs and never erases a peer record", async () => {
    const first = beginGroupOperation(actor, request);
    const second = fixture();
    storage.setItem(key(second), JSON.stringify(second));
    vi.resetModules();
    const tab = await import("./groupRequests");
    expect(
      tab
        .readGroupOperations(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    finishGroupOperation(first);
    expect(tab.readGroupOperations(actor).operations).toEqual([second]);
    expect(storage.getItem(key(second))).not.toBeNull();
    storage.removeItem(key(second));
    expect(readGroupOperations(actor).operations).toEqual([]);
  });

  it("uses a fresh read to block another create until existing requests are reviewed", () => {
    expect(readGroupOperations(actor).operations).toEqual([]);
    const peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    expect(() => beginGroupOperation(actor, request)).toThrow(
      /Review the saved/,
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
    const operation = beginGroupOperation(actor, request);
    expect(
      readGroupOperations(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([peer.id, operation.id].sort());
  });

  it("isolates accounts including corrupt records and retains records across sign-out", () => {
    const invalid = fixture();
    storage.setItem(key(invalid), "broken");
    const operation = beginGroupOperation(other, request);
    expect(readGroupOperations(other)).toEqual({
      operations: [operation],
      errors: [],
    });
    expect(readGroupOperations(actor).operations).toEqual([]);
    expect(readGroupOperations(actor).errors).toHaveLength(1);
    expect(storage.length).toBe(2);
  });

  it.each(["failWrite", "ignoreWrite", "failRead"] as const)(
    "fails before send when browser storage %s",
    (mode) => {
      storage[mode] = true;
      expect(() => beginGroupOperation(actor, request)).toThrow(/storage/i);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a verified reminder actionable when storage becomes unreadable immediately after writing", () => {
    storage.onWrite = () => {
      storage.failRead = true;
    };
    expect(() => beginGroupOperation(actor, request)).toThrow(/storage/i);
    expect(readGroupOperations(actor).errors[0].kind).toBe("unavailable");
    storage.failRead = false;
    expect(readGroupOperations(actor).operations).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds visible records, preserves overflow and blocks new creation without TTL expiry", () => {
    for (let index = 0; index < 11; index++) {
      const operation = fixture();
      storage.setItem(key(operation), JSON.stringify(operation));
    }
    const current = readGroupOperations(actor);
    expect(current.operations).toHaveLength(10);
    expect(current.errors.some((issue) => issue.kind === "capacity")).toBe(
      true,
    );
    expect(() => beginGroupOperation(actor, request)).toThrow(
      /Additional saved/,
    );
    finishGroupOperation(current.operations[0]);
    expect(readGroupOperations(actor).operations).toHaveLength(10);
    expect(readGroupOperations(actor).errors).toEqual([]);
    expect(storage.length).toBe(10);
  });

  it("rejects malformed, cross-actor, mismatched-ID and overlarge records without deleting uncertainty", () => {
    const operation = fixture();
    for (const raw of [
      "{",
      "x".repeat(2_000_001),
      JSON.stringify({ ...operation, actor_id: other }),
      JSON.stringify({
        ...operation,
        request: { ...operation.request, request_id: other },
      }),
      JSON.stringify({ ...operation, extra: "unknown" }),
    ]) {
      storage.setItem(key(operation), raw);
      const current = readGroupOperations(actor);
      expect(current.operations).toEqual([]);
      expect(current.errors[0]).toMatchObject({
        kind: "corrupt",
        id: operation.id,
      });
      expect(storage.getItem(key(operation))).toBe(raw);
      expect(() => beginGroupOperation(actor, request)).toThrow(
        /cannot be read/,
      );
    }
  });

  it("a separate corrupt record blocks new creates but not safe exact retry of a valid request", () => {
    const operation = beginGroupOperation(actor, request),
      invalid = fixture();
    storage.setItem(key(invalid), "corrupt");
    expect(groupOperationAvailable(operation)).toBe(true);
    expect(() => beginGroupOperation(actor, request)).toThrow(/cannot be read/);
  });

  it("never overwrites the same ID and refuses cleanup if its frozen payload changed", () => {
    const operation = beginGroupOperation(actor, request);
    const replacement = {
      ...operation,
      request: { ...operation.request, name: "Different" },
    };
    storage.setItem(key(operation), JSON.stringify(replacement));
    expect(groupOperationAvailable(operation)).toBe(false);
    expect(() => finishGroupOperation(operation)).toThrow(/reminder/);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(replacement);
    expect(() => beginGroupOperation(actor, request)).toThrow();
    expect(storage.length).toBe(1);
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "reports cleanup %s and retains the exact request for another attempt",
    (mode) => {
      const operation = beginGroupOperation(actor, request);
      storage[mode] = true;
      expect(() => finishGroupOperation(operation)).toThrow(/reminder/);
      expect(readGroupOperations(actor).operations).toEqual([operation]);
      storage[mode] = false;
      finishGroupOperation(operation);
      finishGroupOperation(operation);
      expect(readGroupOperations(actor).operations).toEqual([]);
    },
  );

  it("equivalent property order is not a changed request, but other operations remain untouched", () => {
    const operation = beginGroupOperation(actor, request),
      peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    storage.setItem(
      key(operation),
      JSON.stringify({
        request: {
          request_id: operation.id,
          device_ids: [device],
          description: request.description,
          name: request.name,
        },
        recorded_at: operation.recorded_at,
        id: operation.id,
        actor_id: actor,
      }),
    );
    finishGroupOperation(operation);
    expect(readGroupOperations(actor).operations).toEqual([peer]);
  });

  it("requires deliberate exact corrupt-record dismissal and refuses a later repaired record", () => {
    const operation = fixture();
    storage.setItem(key(operation), "broken");
    const issue = readGroupOperations(actor).errors[0];
    storage.setItem(key(operation), JSON.stringify(operation));
    expect(() => dismissGroupStorageIssue(issue)).toThrow(/reminder/);
    expect(readGroupOperations(actor).operations).toEqual([operation]);
    storage.setItem(key(operation), "still broken");
    dismissGroupStorageIssue(readGroupOperations(actor).errors[0]);
    expect(storage.length).toBe(0);
  });

  it("validates UTF-8 lengths, exact member IDs and unknown fields before retaining or sending", () => {
    for (const invalid of [
      { ...request, name: "😀".repeat(31) },
      { ...request, description: "😀".repeat(501) },
      { ...request, name: " " },
      { ...request, device_ids: ["not-a-device"] },
      { ...request, device_ids: [device, device] },
      { ...request, device_ids: Array(10001).fill(device) },
      { ...request, request_id: other },
    ]) {
      expect(() => beginGroupOperation(actor, invalid)).toThrow();
      expect(storage.length).toBe(0);
    }
    const operation = beginGroupOperation(actor, {
      name: "😀".repeat(30),
      description: "😀".repeat(500),
      device_ids: [],
    });
    expect(operation.request.name).toBe("😀".repeat(30));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes on same-window changes, scoped storage events, focus and pageshow; disposal stops callbacks", () => {
    const refresh = vi.fn(),
      stop = subscribeGroupOperations(actor, refresh);
    const operation = beginGroupOperation(actor, request);
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(
      storageEvent(key({ actor_id: other, id: operation.id })),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(storageEvent(key(operation)));
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("pageshow"));
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
    finishGroupOperation(operation);
    events.dispatchEvent(storageEvent(null));
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
