import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAgentSettingsReceipt,
  beginAgentSettingsOperation,
  dismissAgentSettingsStorageIssue,
  finishAgentSettingsOperation,
  agentSettingsOperationAvailable,
  readAgentSettingsOperations,
  subscribeAgentSettingsOperations,
  type AgentSettingsOperation,
} from "./agentSettingsRequests";

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
const request = {
  name: "Synthetic settings",
  policy: {
    heartbeat_seconds: 60,
    sync_paused: false,
    telemetry_enabled: true,
  },
};
const key = (operation: Pick<AgentSettingsOperation, "actor_id" | "id">) =>
  `vectory:agent-settings-operation:${encodeURIComponent(operation.actor_id)}:${operation.id}`;
const fixture = (
  id = crypto.randomUUID(),
  who = actor,
): AgentSettingsOperation => ({
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

describe("durable agent-settings creation registry", () => {
  it("persists exact identity and frozen payload before the caller can send, surviving reload", async () => {
    const input = structuredClone(request);
    const operation = beginAgentSettingsOperation(actor, input);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(operation);
    expect(operation.request.request_id).toBe(operation.id);
    input.policy.heartbeat_seconds = 90;
    input.name = "Changed";
    expect(operation.request).toEqual({ ...request, request_id: operation.id });
    expect(Object.isFrozen(operation.request.policy)).toBe(true);
    expect(Object.isFrozen(operation)).toBe(true);
    vi.resetModules();
    const reloaded = await import("./agentSettingsRequests");
    expect(reloaded.readAgentSettingsOperations(actor).operations).toEqual([
      operation,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes storage directly across independent tabs and never erases a peer record", async () => {
    const first = beginAgentSettingsOperation(actor, request);
    const second = fixture();
    storage.setItem(key(second), JSON.stringify(second));
    vi.resetModules();
    const tab = await import("./agentSettingsRequests");
    expect(
      tab
        .readAgentSettingsOperations(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    finishAgentSettingsOperation(first);
    expect(tab.readAgentSettingsOperations(actor).operations).toEqual([second]);
    expect(storage.getItem(key(second))).not.toBeNull();
    storage.removeItem(key(second));
    expect(readAgentSettingsOperations(actor).operations).toEqual([]);
  });

  it("uses a fresh read to block another create until existing requests are reviewed", () => {
    expect(readAgentSettingsOperations(actor).operations).toEqual([]);
    const peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    expect(() => beginAgentSettingsOperation(actor, request)).toThrow(
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
    const operation = beginAgentSettingsOperation(actor, request);
    expect(
      readAgentSettingsOperations(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([peer.id, operation.id].sort());
  });

  it("isolates accounts including corrupt records and retains records across sign-out", () => {
    const invalid = fixture();
    storage.setItem(key(invalid), "broken");
    const operation = beginAgentSettingsOperation(other, request);
    expect(readAgentSettingsOperations(other)).toEqual({
      operations: [operation],
      errors: [],
    });
    expect(readAgentSettingsOperations(actor).operations).toEqual([]);
    expect(readAgentSettingsOperations(actor).errors).toHaveLength(1);
    expect(storage.length).toBe(2);
  });

  it.each(["failWrite", "ignoreWrite", "failRead"] as const)(
    "fails before send when browser storage %s",
    (mode) => {
      storage[mode] = true;
      expect(() => beginAgentSettingsOperation(actor, request)).toThrow(
        /storage/i,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a verified reminder actionable when storage becomes unreadable immediately after writing", () => {
    storage.onWrite = () => {
      storage.failRead = true;
    };
    expect(() => beginAgentSettingsOperation(actor, request)).toThrow(
      /storage/i,
    );
    expect(readAgentSettingsOperations(actor).errors[0].kind).toBe(
      "unavailable",
    );
    storage.failRead = false;
    expect(readAgentSettingsOperations(actor).operations).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds visible records, preserves overflow and blocks new creation without TTL expiry", () => {
    for (let index = 0; index < 11; index++) {
      const operation = fixture();
      storage.setItem(key(operation), JSON.stringify(operation));
    }
    const current = readAgentSettingsOperations(actor);
    expect(current.operations).toHaveLength(10);
    expect(current.errors.some((issue) => issue.kind === "capacity")).toBe(
      true,
    );
    expect(() => beginAgentSettingsOperation(actor, request)).toThrow(
      /Additional saved/,
    );
    finishAgentSettingsOperation(current.operations[0]);
    expect(readAgentSettingsOperations(actor).operations).toHaveLength(10);
    expect(readAgentSettingsOperations(actor).errors).toEqual([]);
    expect(storage.length).toBe(10);
  });

  it("rejects malformed, cross-actor, mismatched-ID and overlarge records without deleting uncertainty", () => {
    const operation = fixture();
    for (const raw of [
      "{",
      "x".repeat(2_097_153),
      JSON.stringify({ ...operation, actor_id: other }),
      JSON.stringify({
        ...operation,
        request: { ...operation.request, request_id: other },
      }),
      JSON.stringify({ ...operation, extra: "unknown" }),
    ]) {
      storage.setItem(key(operation), raw);
      const current = readAgentSettingsOperations(actor);
      expect(current.operations).toEqual([]);
      expect(current.errors[0]).toMatchObject({
        kind: "corrupt",
        id: operation.id,
      });
      expect(storage.getItem(key(operation))).toBe(raw);
      expect(() => beginAgentSettingsOperation(actor, request)).toThrow(
        /cannot be read/,
      );
    }
  });

  it("a separate corrupt record blocks new creates but not safe exact retry of a valid request", () => {
    const operation = beginAgentSettingsOperation(actor, request),
      invalid = fixture();
    storage.setItem(key(invalid), "corrupt");
    expect(agentSettingsOperationAvailable(operation)).toBe(true);
    expect(() => beginAgentSettingsOperation(actor, request)).toThrow(
      /cannot be read/,
    );
  });

  it("never overwrites the same ID and refuses cleanup if its frozen payload changed", () => {
    const operation = beginAgentSettingsOperation(actor, request);
    const replacement = {
      ...operation,
      request: { ...operation.request, name: "Different" },
    };
    storage.setItem(key(operation), JSON.stringify(replacement));
    expect(agentSettingsOperationAvailable(operation)).toBe(false);
    expect(() => finishAgentSettingsOperation(operation)).toThrow(/reminder/);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(replacement);
    expect(() => beginAgentSettingsOperation(actor, request)).toThrow();
    expect(storage.length).toBe(1);
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "reports cleanup %s and retains the exact request for another attempt",
    (mode) => {
      const operation = beginAgentSettingsOperation(actor, request);
      storage[mode] = true;
      expect(() => finishAgentSettingsOperation(operation)).toThrow(/reminder/);
      expect(readAgentSettingsOperations(actor).operations).toEqual([
        operation,
      ]);
      storage[mode] = false;
      finishAgentSettingsOperation(operation);
      finishAgentSettingsOperation(operation);
      expect(readAgentSettingsOperations(actor).operations).toEqual([]);
    },
  );

  it("equivalent property order is not a changed request, but other operations remain untouched", () => {
    const operation = beginAgentSettingsOperation(actor, request),
      peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    storage.setItem(
      key(operation),
      JSON.stringify({
        request: {
          request_id: operation.id,
          policy: {
            telemetry_enabled: true,
            sync_paused: false,
            heartbeat_seconds: 60,
          },
          name: request.name,
        },
        recorded_at: operation.recorded_at,
        id: operation.id,
        actor_id: actor,
      }),
    );
    finishAgentSettingsOperation(operation);
    expect(readAgentSettingsOperations(actor).operations).toEqual([peer]);
  });

  it("requires deliberate exact corrupt-record dismissal and refuses a later repaired record", () => {
    const operation = fixture();
    storage.setItem(key(operation), "broken");
    const issue = readAgentSettingsOperations(actor).errors[0];
    storage.setItem(key(operation), JSON.stringify(operation));
    expect(() => dismissAgentSettingsStorageIssue(issue)).toThrow(/reminder/);
    expect(readAgentSettingsOperations(actor).operations).toEqual([operation]);
    storage.setItem(key(operation), "still broken");
    dismissAgentSettingsStorageIssue(
      readAgentSettingsOperations(actor).errors[0],
    );
    expect(storage.length).toBe(0);
  });

  it("validates UTF-8 names and exact policy shape before retaining or sending", () => {
    for (const invalid of [
      { ...request, name: "\u{1F680}".repeat(31) },
      { ...request, name: " " },
      { ...request, name: "bad\0name" },
      { ...request, policy: { ...request.policy, heartbeat_seconds: 9 } },
      { ...request, policy: { ...request.policy, heartbeat_seconds: 3601 } },
      { ...request, policy: { ...request.policy, heartbeat_seconds: 60.5 } },
      { ...request, policy: { ...request.policy, sync_paused: "false" } },
      { ...request, policy: { ...request.policy, unknown: true } },
      { ...request, request_id: other },
    ]) {
      expect(() =>
        beginAgentSettingsOperation(actor, invalid as typeof request),
      ).toThrow();
      expect(storage.length).toBe(0);
    }
    const operation = beginAgentSettingsOperation(actor, {
      ...request,
      name: "\u{1F680}".repeat(30),
    });
    expect(operation.request.name).toBe("\u{1F680}".repeat(30));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("only derives status lookup identity from a valid actor-scoped storage key", () => {
    const operation = fixture();
    storage.setItem(key(operation) + "-invalid", JSON.stringify(operation));
    expect(readAgentSettingsOperations(actor).errors[0].id).toBeUndefined();
    expect(readAgentSettingsOperations(actor).operations).toEqual([]);
  });

  it("correlates immutable local settings and metadata result identity before cleanup", () => {
    const operation = beginAgentSettingsOperation(actor, request);
    const receipt = {
      id: other,
      request_id: operation.id,
      ...structuredClone(request),
    };
    expect(() =>
      assertAgentSettingsReceipt(operation.id, receipt, operation, other),
    ).not.toThrow();
    for (const invalid of [
      { ...receipt, request_id: actor },
      { ...receipt, id: actor },
      { ...receipt, name: "Same policy, different name" },
      { ...receipt, policy: { ...receipt.policy, heartbeat_seconds: 90 } },
      { ...receipt, policy: { ...receipt.policy, sync_paused: true } },
      { ...receipt, policy: { ...receipt.policy, telemetry_enabled: false } },
    ])
      expect(() =>
        assertAgentSettingsReceipt(operation.id, invalid, operation, other),
      ).toThrow();
    expect(readAgentSettingsOperations(actor).operations).toEqual([operation]);
  });

  it("status-only recovery validates known identity without reconstructing or inventing original values", () => {
    const receipt = {
      id: other,
      request_id: actor,
      name: "Saved settings",
      policy: {
        heartbeat_seconds: 120,
        sync_paused: true,
        telemetry_enabled: false,
      },
    };
    expect(() =>
      assertAgentSettingsReceipt(actor, receipt, undefined, other),
    ).not.toThrow();
    expect(() =>
      assertAgentSettingsReceipt(actor, receipt, undefined, actor),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes on same-window changes, scoped storage events, focus and pageshow; disposal stops callbacks", () => {
    const refresh = vi.fn(),
      stop = subscribeAgentSettingsOperations(actor, refresh);
    const operation = beginAgentSettingsOperation(actor, request);
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
    finishAgentSettingsOperation(operation);
    events.dispatchEvent(storageEvent(null));
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
