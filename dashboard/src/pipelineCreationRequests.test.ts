import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPipelineCreationOperation,
  assertPipelineCreationResult,
  pipelineCreationPath,
  pipelineCopyName,
  dismissPipelineCreationStorageIssue,
  finishPipelineCreationOperation,
  isDefinitivePipelineCreationRejection,
  pipelineCreationRefusalProblems,
  pipelineNameError,
  pipelineCreationOperationAvailable,
  readPipelineCreationOperations,
  subscribePipelineCreationOperations,
  type PipelineCreationOperation,
} from "./pipelineCreationRequests";
import { APIError } from "./api";

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
const source = "1d151cf3-c43b-4540-b682-2b6d2ae9f637";
const request = {
  operation: "create" as const,
  request: {
    name: "Synthetic pipeline",
    description: "Original details",
    config: {
      sources: { in: { type: "demo_logs", count: 9007199254740991 } },
      sinks: { out: { type: "blackhole", inputs: ["in"] } },
    },
    graph: {
      nodes: [
        { id: "in", position: { x: 1.25, y: 50 }, data: { extension: null } },
      ],
      edges: [],
    },
  },
};
const key = (op: Pick<PipelineCreationOperation, "actor_id" | "id">) =>
  `vectory:pipeline-creation:${encodeURIComponent(op.actor_id)}:${op.id}`;
const fixture = (
  id = crypto.randomUUID(),
  who = actor,
): PipelineCreationOperation => ({
  actor_id: who,
  id,
  operation: "create",
  source_configuration_id: null,
  recorded_at: "2026-09-27T00:00:00.000Z",
  request: { ...structuredClone(request.request), request_id: id },
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

describe("durable pipeline creation registry", () => {
  it("never stores credential-shaped metadata or graph data even when called directly", () => {
    for (const unsafe of [
      {
        ...request,
        request: { ...request.request, name: "ghp_syntheticcredential123" },
      },
      {
        ...request,
        request: {
          ...request.request,
          description: "https://collector.example/?api_key=short",
        },
      },
      {
        ...request,
        request: {
          ...request.request,
          graph: {
            nodes: [{ id: "in", data: { note: "ghp_syntheticcredential123" } }],
            edges: [],
          },
        },
      },
    ]) {
      expect(() => beginPipelineCreationOperation(actor, unsafe)).toThrow(
        /credential/i,
      );
      expect(storage.length).toBe(0);
    }
    expect(() =>
      beginPipelineCreationOperation(actor, {
        operation: "duplicate",
        source_configuration_id: source,
        request: {
          name: "Safe name",
          description: "https://collector.example/?api_key=short",
          revision: 7,
        },
      }),
    ).toThrow(/credential/i);
    expect(storage.length).toBe(0);
  });
  it("validates the trimmed creation name against the server's UTF-8 byte limit", () => {
    expect(pipelineNameError("   ")).toBe(
      "Enter a pipeline name to create a draft.",
    );
    expect(pipelineNameError("é".repeat(60))).toBe("");
    expect(pipelineNameError("é".repeat(61))).toMatch(/120 UTF-8 bytes/);
    expect(pipelineNameError(`  ${"é".repeat(60)}  `)).toBe("");
    expect(pipelineNameError("🙂".repeat(30))).toBe("");
    expect(pipelineNameError("🙂".repeat(31))).toMatch(/120 UTF-8 bytes/);
  });
  it("only clears reminders for a payload-invariant credential rejection", () => {
    for (const [code, status] of [
      ["INVALID_INPUT", 400],
      ["FORBIDDEN", 403],
      ["PAYLOAD_TOO_LARGE", 413],
      ["VALIDATION_FAILED", 422],
    ] as const) {
      const rejected = new APIError(code, "Rejected", status, true);
      expect(isDefinitivePipelineCreationRejection(rejected, true)).toBe(false);
      expect(isDefinitivePipelineCreationRejection(rejected, false)).toBe(
        false,
      );
      expect(
        isDefinitivePipelineCreationRejection(
          new APIError(code, "Unverified", status),
          true,
        ),
      ).toBe(false);
    }
    expect(
      isDefinitivePipelineCreationRejection(
        new APIError("STALE_REVISION", "Source changed", 409, true),
        true,
      ),
    ).toBe(false);
    expect(
      isDefinitivePipelineCreationRejection(
        new APIError("NETWORK_UNAVAILABLE", "Connection lost", 0),
        true,
      ),
    ).toBe(false);
  });
  it("projects field problems from an authoritative refusal without changing uncertainty", () => {
    const rejected = new APIError(
      "INVALID_INPUT",
      "Credential refused",
      400,
      true,
      undefined,
      "plaintext_credential",
      undefined,
      undefined,
      [
        {
          code: "plaintext_credential",
          path: "sinks.out.request.headers.Authorization",
          message: "This field holds what looks like a credential.",
          fix: "Use a device secret where supported.",
        },
      ],
    );
    expect(pipelineCreationRefusalProblems(rejected)).toEqual([
      {
        path: "sinks.out.request.headers.Authorization",
        message: "This field holds what looks like a credential.",
      },
    ]);
    expect(isDefinitivePipelineCreationRejection(rejected, true)).toBe(true);
    expect(
      isDefinitivePipelineCreationRejection(
        new APIError("IDEMPOTENCY_CONFLICT", "Unknown result", 409, true),
        true,
      ),
    ).toBe(false);
  });
  it("fits a default copy name within the UTF-8 byte limit without splitting Unicode", () => {
    expect(pipelineCopyName("Logs")).toBe("Logs copy");
    expect(pipelineCopyName("\u{1f600}".repeat(30))).toBe(
      "\u{1f600}".repeat(28) + " copy",
    );
    expect(
      new TextEncoder().encode(pipelineCopyName("\u00e9".repeat(60))).length,
    ).toBeLessThanOrEqual(120);
    expect(pipelineCopyName("a".repeat(120))).toBe("a".repeat(115) + " copy");
  });
  it("persists exact identity and frozen payload before the caller can send, surviving reload", async () => {
    const input = structuredClone(request);
    const operation = beginPipelineCreationOperation(actor, input);
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(operation);
    expect(operation.request.request_id).toBe(operation.id);
    input.request.config.sources.in.count = 1;
    input.request.name = "Changed";
    expect(operation.request).toEqual({
      ...request.request,
      request_id: operation.id,
    });
    expect(Object.isFrozen(operation.request)).toBe(true);
    expect(Object.isFrozen(operation)).toBe(true);
    vi.resetModules();
    const reloaded = await import("./pipelineCreationRequests");
    expect(reloaded.readPipelineCreationOperations(actor).operations).toEqual([
      operation,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes storage directly across independent tabs and never erases a peer record", async () => {
    const first = beginPipelineCreationOperation(actor, request);
    const second = fixture();
    storage.setItem(key(second), JSON.stringify(second));
    vi.resetModules();
    const tab = await import("./pipelineCreationRequests");
    expect(
      tab
        .readPipelineCreationOperations(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    finishPipelineCreationOperation(first);
    expect(tab.readPipelineCreationOperations(actor).operations).toEqual([
      second,
    ]);
    expect(storage.getItem(key(second))).not.toBeNull();
    storage.removeItem(key(second));
    expect(readPipelineCreationOperations(actor).operations).toEqual([]);
  });

  it("uses a fresh read to block another create until existing requests are reviewed", () => {
    expect(readPipelineCreationOperations(actor).operations).toEqual([]);
    const peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
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
    const operation = beginPipelineCreationOperation(actor, request);
    expect(
      readPipelineCreationOperations(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([peer.id, operation.id].sort());
  });

  it("isolates accounts including corrupt records and retains records across sign-out", () => {
    const invalid = fixture();
    storage.setItem(key(invalid), "broken");
    const operation = beginPipelineCreationOperation(other, request);
    expect(readPipelineCreationOperations(other)).toEqual({
      operations: [operation],
      errors: [],
    });
    expect(readPipelineCreationOperations(actor).operations).toEqual([]);
    expect(readPipelineCreationOperations(actor).errors).toHaveLength(1);
    expect(storage.length).toBe(2);
  });

  it.each(["failWrite", "ignoreWrite", "failRead"] as const)(
    "fails before send when browser storage %s",
    (mode) => {
      storage[mode] = true;
      expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
        /storage/i,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a verified reminder actionable when storage becomes unreadable immediately after writing", () => {
    storage.onWrite = () => {
      storage.failRead = true;
    };
    expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
      /storage/i,
    );
    expect(readPipelineCreationOperations(actor).errors[0].kind).toBe(
      "unavailable",
    );
    storage.failRead = false;
    expect(readPipelineCreationOperations(actor).operations).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds visible records, preserves overflow and blocks new creation without TTL expiry", () => {
    for (let index = 0; index < 11; index++) {
      const operation = fixture();
      storage.setItem(key(operation), JSON.stringify(operation));
    }
    const current = readPipelineCreationOperations(actor);
    expect(current.operations).toHaveLength(10);
    expect(current.errors.some((issue) => issue.kind === "capacity")).toBe(
      true,
    );
    expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
      /Additional saved/,
    );
    finishPipelineCreationOperation(current.operations[0]);
    expect(readPipelineCreationOperations(actor).operations).toHaveLength(10);
    expect(readPipelineCreationOperations(actor).errors).toEqual([]);
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
      const current = readPipelineCreationOperations(actor);
      expect(current.operations).toEqual([]);
      expect(current.errors[0]).toMatchObject({
        kind: "corrupt",
        id: operation.id,
      });
      expect(storage.getItem(key(operation))).toBe(raw);
      expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
        /cannot be read/,
      );
    }
  });

  it("a separate corrupt record blocks new creates but not safe exact retry of a valid request", () => {
    const operation = beginPipelineCreationOperation(actor, request),
      invalid = fixture();
    storage.setItem(key(invalid), "corrupt");
    expect(pipelineCreationOperationAvailable(operation)).toBe(true);
    expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
      /cannot be read/,
    );
  });

  it("never overwrites the same ID and refuses cleanup if its frozen payload changed", () => {
    const operation = beginPipelineCreationOperation(actor, request);
    const replacement = {
      ...operation,
      request: { ...operation.request, name: "Different" },
    };
    storage.setItem(key(operation), JSON.stringify(replacement));
    expect(pipelineCreationOperationAvailable(operation)).toBe(false);
    expect(() => finishPipelineCreationOperation(operation)).toThrow(
      /reminder/,
    );
    expect(JSON.parse(storage.getItem(key(operation))!)).toEqual(replacement);
    expect(() => beginPipelineCreationOperation(actor, request)).toThrow();
    expect(storage.length).toBe(1);
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "reports cleanup %s and retains the exact request for another attempt",
    (mode) => {
      const operation = beginPipelineCreationOperation(actor, request);
      storage[mode] = true;
      expect(() => finishPipelineCreationOperation(operation)).toThrow(
        /reminder/,
      );
      expect(readPipelineCreationOperations(actor).operations).toEqual([
        operation,
      ]);
      storage[mode] = false;
      finishPipelineCreationOperation(operation);
      finishPipelineCreationOperation(operation);
      expect(readPipelineCreationOperations(actor).operations).toEqual([]);
    },
  );

  it("equivalent property order is not a changed request, but other operations remain untouched", () => {
    const operation = beginPipelineCreationOperation(actor, request),
      peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    storage.setItem(
      key(operation),
      JSON.stringify({
        request: {
          request_id: operation.id,
          graph: request.request.graph,
          config: request.request.config,
          description: request.request.description,
          name: request.request.name,
        },
        recorded_at: operation.recorded_at,
        id: operation.id,
        actor_id: actor,
        operation: "create",
        source_configuration_id: null,
      }),
    );
    finishPipelineCreationOperation(operation);
    expect(readPipelineCreationOperations(actor).operations).toEqual([peer]);
  });

  it("requires deliberate exact corrupt-record dismissal and refuses a later repaired record", () => {
    const operation = fixture();
    storage.setItem(key(operation), "broken");
    const issue = readPipelineCreationOperations(actor).errors[0];
    storage.setItem(key(operation), JSON.stringify(operation));
    expect(() => dismissPipelineCreationStorageIssue(issue)).toThrow(
      /reminder/,
    );
    expect(readPipelineCreationOperations(actor).operations).toEqual([
      operation,
    ]);
    storage.setItem(key(operation), "still broken");
    dismissPipelineCreationStorageIssue(
      readPipelineCreationOperations(actor).errors[0],
    );
    expect(storage.length).toBe(0);
  });

  it("rejects lossy numbers, non-JSON values, graph/body bounds and incorrect operation identity before send", () => {
    const invalids: unknown[] = [
      {
        ...request,
        request: { ...request.request, name: "\u{1f600}".repeat(31) },
      },
      {
        ...request,
        request: { ...request.request, description: "\u{1f600}".repeat(501) },
      },
      {
        ...request,
        request: {
          ...request.request,
          config: { value: Number.MAX_SAFE_INTEGER + 1 },
        },
      },
      {
        ...request,
        request: { ...request.request, config: { value: Infinity } },
      },
      {
        ...request,
        request: { ...request.request, config: { value: undefined } },
      },
      {
        ...request,
        request: { ...request.request, config: { value: BigInt(1) } },
      },
      {
        ...request,
        request: { ...request.request, config: { value: "x".repeat(1048576) } },
      },
      {
        ...request,
        request: {
          ...request.request,
          graph: { nodes: Array(1001).fill({}), edges: [] },
        },
      },
      {
        ...request,
        request: {
          ...request.request,
          graph: { nodes: [], edges: Array(5001).fill({}) },
        },
      },
      { ...request, source_configuration_id: source },
      {
        operation: "duplicate",
        source_configuration_id: source,
        request: { name: "Copy", description: "", revision: 0 },
      },
      {
        operation: "duplicate",
        source_configuration_id: "name",
        request: { name: "Copy", description: "", revision: 1 },
      },
    ];
    for (const invalid of invalids) {
      expect(() =>
        beginPipelineCreationOperation(actor, invalid as typeof request),
      ).toThrow();
      expect(storage.length).toBe(0);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves actual starter graph, exact safe numbers, unknown null/array and prototype-like own keys", async () => {
    const { starter, toGraph } = await import("./catalog");
    const config = JSON.parse(
      '{"sources":{},"sinks":{},"__proto__":{"nested":null},"opaque":[9007199254740991,1.25,false]}',
    );
    const op = beginPipelineCreationOperation(actor, {
      operation: "create",
      request: {
        name: "Exact",
        description: "",
        config,
        graph: toGraph(starter),
      },
    });
    expect(op.operation).toBe("create");
    if (op.operation !== "create") throw Error("wrong operation");
    expect(Object.hasOwn(op.request.config, "__proto__")).toBe(true);
    expect(op.request.config).toEqual(config);
    expect(op.request.graph).toEqual(toGraph(starter));
    finishPipelineCreationOperation(op);
    const sample = beginPipelineCreationOperation(actor, {
      operation: "create",
      request: {
        name: "Synthetic",
        description: "",
        config: structuredClone(starter),
        graph: toGraph(starter),
      },
    });
    expect(sample.request).toMatchObject({ config: starter });
  });
  it("binds duplicate source and revision without storing or reading a newer source draft", () => {
    const input = {
      operation: "duplicate" as const,
      source_configuration_id: source,
      request: { name: "Copy", description: "Frozen", revision: 7 },
    };
    const op = beginPipelineCreationOperation(actor, input);
    input.request.revision = 8;
    expect(op.request).toEqual({
      name: "Copy",
      description: "Frozen",
      revision: 7,
      request_id: op.id,
    });
    expect(pipelineCreationPath(op)).toBe(
      "/configurations/" + source + "/duplicate",
    );
    expect(() => beginPipelineCreationOperation(actor, request)).toThrow(
      /Review/,
    );
    const result = {
      request_id: op.id,
      operation: "duplicate" as const,
      source_configuration_id: source,
      source_revision: 7,
      configuration: { id: other, request_id: op.id },
    };
    expect(() => assertPipelineCreationResult(op, result)).not.toThrow();
    for (const changed of [
      { operation: "create" as const },
      { source_configuration_id: other },
      { source_revision: 8 },
      { request_id: other },
      { configuration: { id: source, request_id: op.id } },
      { configuration: { id: other, request_id: other } },
    ])
      expect(() =>
        assertPipelineCreationResult(op, { ...result, ...changed }),
      ).toThrow(/does not match/);
  });
  it("distinguishes create origin from a duplicate and does not compare later edited result content", () => {
    const op = beginPipelineCreationOperation(actor, request);
    expect(pipelineCreationPath(op)).toBe("/configurations");
    const result = {
      request_id: op.id,
      operation: "create" as const,
      source_configuration_id: null,
      source_revision: null,
      configuration: {
        id: other,
        request_id: op.id,
        name: "Later edit",
        archived: true,
        revision: 12,
      },
    };
    expect(() => assertPipelineCreationResult(op, result)).not.toThrow();
    expect(() =>
      assertPipelineCreationResult(op, { ...result, source_revision: 1 }),
    ).toThrow();
  });
  it("refreshes on same-window changes, scoped storage events, focus and pageshow; disposal stops callbacks", () => {
    const refresh = vi.fn(),
      stop = subscribePipelineCreationOperations(actor, refresh);
    const operation = beginPipelineCreationOperation(actor, request);
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
    finishPipelineCreationOperation(operation);
    events.dispatchEvent(storageEvent(null));
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
