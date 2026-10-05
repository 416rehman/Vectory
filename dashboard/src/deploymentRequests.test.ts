import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { post } from "./api";
import { isDeploymentActionRejection } from "./deploymentRequests";
import type { RollbackPreview } from "./rollbackReview";
import type {
  DeploymentCreateRequest,
  DeploymentOperation,
} from "./deploymentRequests";

afterEach(() => vi.unstubAllGlobals());
describe("non-keyed deployment action responses", () => {
  it.each([
    [
      400,
      '{"error":{"code":"INVALID_INPUT","message":"Review targets"}}',
      true,
    ],
    [409, '{"error":{"code":"CONFLICT","message":"Canary active"}}', true],
    [
      409,
      '{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"Different payload"}}',
      false,
    ],
    [500, '{"error":{"code":"INTERNAL","message":"Unavailable"}}', false],
    [408, '{"error":{"code":"TIMEOUT","message":"Timed out"}}', false],
    [400, "<html>Proxy response</html>", false],
    [400, "{}", false],
    [200, '{"counter":9007199254740993}', false],
    [200, '{"id":', false],
  ])(
    "classifies HTTP %s without assuming a lost response failed",
    async (status, body, rejected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status })),
      );
      const failure = await post("/deployments", {}).catch(
        (error: unknown) => error,
      );
      expect(isDeploymentActionRejection(failure)).toBe(rejected);
    },
  );
  it("retains uncertainty when the connection fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Connection closed")),
    );
    const failure = await post("/deployments", {}).catch(
      (error: unknown) => error,
    );
    expect(isDeploymentActionRejection(failure)).toBe(false);
  });
});

class BrowserStorage implements Storage {
  readonly data = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;
  ignoreWrite = false;
  ignoreRemove = false;
  get length() {
    if (this.failRead) throw Error("Storage blocked");
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.failRead) throw Error("Storage blocked");
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw Error("Quota exceeded");
    if (!this.ignoreWrite) this.data.set(key, value);
  }
  removeItem(key: string) {
    if (this.failRemove) throw Error("Storage blocked");
    if (!this.ignoreRemove) this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}
type Registry = typeof import("./deploymentRequests");
async function browserTab(
  local: BrowserStorage,
  session = new BrowserStorage(),
) {
  vi.resetModules();
  const registry = await import("./deploymentRequests");
  const events = new EventTarget();
  function run<T>(callback: (registry: Registry) => T): T {
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    return callback(registry);
  }
  return { registry, events, session, run };
}
const actor = "f3365fa7-c36f-4260-9b80-bb2af3f19ec8";
const otherActor = "1e59a3f8-1c9b-4d36-b571-d11e93b7388e";
const version = "787ae1f9-2cde-4977-91c9-68351c94bddd";
const deployment = "e8e0a2cd-19a4-42ed-b7fd-5f9f369c6f22";
const request: DeploymentCreateRequest = {
  version_id: version,
  selector: { device_ids: ["device-a"], group_ids: [], exclude_ids: [] },
  expected_device_ids: ["device-a"],
  priority: 5,
  target_mode: "snapshot",
  scheduled_at: null,
  rollout: {
    kind: "all",
    canary_size: 1,
    batch_size: 10,
    observation_seconds: 30,
    failure_threshold: 0,
  },
};
const durableKey = (op: DeploymentOperation) =>
  `vectory:deployment-operation:${encodeURIComponent(op.actor_id)}:${op.id}`;
const hintKey = (op: DeploymentOperation) =>
  `vectory:deployment-operation-lease:${encodeURIComponent(op.actor_id)}:${op.id}`;
const oldKey = (who = actor) => `vectory:deployment-request:${who}`;
function legacyOperation(
  retrySupported = true,
): Extract<DeploymentOperation, { kind: "create" }> {
  const id = "f3d60e18-f6da-4e9b-bdba-1e34f17218f4";
  return {
    actor_id: actor,
    id,
    kind: "create",
    label: "Preserved deployment",
    recorded_at: "2020-01-01T00:00:00.000Z",
    retry_supported: retrySupported,
    request: {
      ...structuredClone(request),
      target_mode: "snapshot",
      rollout: { ...request.rollout, kind: "all" },
      ...(retrySupported ? { request_id: id } : {}),
    },
  };
}
function storageEvent(key: string | null) {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: key });
  return event;
}

describe("durable deployment request registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const rollbackPreview = (): RollbackPreview => ({
    source_deployment_id: deployment,
    source_version_id: actor,
    source_status: "completed",
    source_action: "cancel",
    previous_version_id: version,
    previous_version_number: 4,
    previous_configuration_id: otherActor,
    previous_configuration_name: "Prior pipeline",
    priority: 6,
    eligible_devices: [
      {
        device_id: otherActor,
        device_name: "Included",
        artifact_sha256: "a".repeat(64),
      },
    ],
    excluded_devices: [
      { device_id: actor, device_name: "Excluded", reason: "revoked" },
    ],
    blockers: [],
    review_token: "a".repeat(64),
    ready: true,
  });

  it("refuses token-shaped and credential-URL bindings before a durable request exists", async () => {
    const local = new BrowserStorage();
    const tab = await browserTab(local);
    for (const value of [
      "ghp_syntheticcredential123",
      "https://collector.example/?api_key=short",
    ]) {
      expect(() =>
        tab.run((r) =>
          r.beginDeploymentOperation(
            actor,
            {
              ...request,
              variable_bindings: {
                defaults: { MY_VALUE: value },
                devices: {},
              },
            },
            true,
            "Synthetic deployment",
          ),
        ),
      ).toThrow(/variable_bindings\.defaults\.MY_VALUE/);
      expect(local.data.size).toBe(0);
    }
    expect(() =>
      tab.run((r) =>
        r.beginDeploymentOperation(
          actor,
          {
            ...request,
            variable_bindings: {
              defaults: { MY_VALUE: "ordinary-nonsecret-value" },
              devices: {},
            },
          },
          true,
          "Synthetic deployment",
        ),
      ),
    ).not.toThrow();
  });

  it("preserves the exact reviewed token and device/version context after tab reload", async () => {
    const local = new BrowserStorage(),
      first = await browserTab(local),
      preview = rollbackPreview();
    const op = first.run((r) =>
      r.beginRollbackOperation(
        actor,
        deployment,
        true,
        "Reviewed rollback",
        preview,
      ),
    );
    expect(op.request).toEqual({
      request_id: op.id,
      review_token: "a".repeat(64),
    });
    preview.review_token = "b".repeat(64);
    preview.eligible_devices[0].device_id = actor;
    preview.previous_version_id = actor;
    const reloaded = await browserTab(local);
    const recovered = reloaded.run((r) => r.readDeploymentOperation(actor));
    expect(recovered).toEqual(op);
    expect(recovered?.kind === "rollback" && recovered.review).toEqual({
      version_id: version,
      version_number: 4,
      configuration_name: "Prior pipeline",
      device_ids: [otherActor],
      excluded_count: 1,
    });
    expect(
      recovered?.kind === "rollback" &&
        Object.isFrozen(recovered.review?.device_ids),
    ).toBe(true);
    expect(Object.isFrozen(recovered?.request)).toBe(true);
  });

  it("does not allocate a reminder for an unready, mismatched or unsupported review", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local);
    for (const [preview, supported] of [
      [
        {
          ...rollbackPreview(),
          ready: false,
          blockers: [{ code: "CONFLICT", reason: "Assignment changed." }],
        },
        true,
      ],
      [{ ...rollbackPreview(), source_deployment_id: otherActor }, true],
      [rollbackPreview(), false],
    ] satisfies Array<[RollbackPreview, boolean]>) {
      expect(() =>
        tab.run((r) =>
          r.beginRollbackOperation(
            actor,
            deployment,
            supported,
            "Blocked",
            preview,
          ),
        ),
      ).toThrow();
      expect(local.length).toBe(0);
    }
  });

  it("rejects partial or altered review context without converting it into a legacy retry", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local);
    const op = tab.run((r) =>
      r.beginRollbackOperation(
        actor,
        deployment,
        true,
        "Reviewed",
        rollbackPreview(),
      ),
    );
    if (op.kind !== "rollback") throw Error("Expected rollback");
    for (const invalid of [
      { ...op, review: undefined },
      { ...op, request: { request_id: op.id } },
      { ...op, review: { ...op.review, device_ids: [otherActor, otherActor] } },
      { ...op, review: { ...op.review, device_ids: [] } },
      { ...op, request: { ...op.request, review_token: "unknown" } },
    ]) {
      local.setItem(durableKey(op), JSON.stringify(invalid));
      expect(tab.run((r) => r.readDeploymentOperation(actor))).toBeNull();
    }
  });

  it("keeps independently created tab records, reads changed storage without a stale cache, and returns oldest first", async () => {
    const local = new BrowserStorage(),
      first = await browserTab(local),
      second = await browserTab(local);
    expect(first.run((r) => r.readDeploymentOperation(actor))).toBeNull();
    const a = first.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "First"),
    );
    vi.setSystemTime(Date.now() + 1000);
    const b = second.run((r) =>
      r.beginRollbackOperation(actor, deployment, true, "Second"),
    );
    expect(
      first.run((r) => r.readDeploymentOperations(actor)).map((op) => op.id),
    ).toEqual([a.id, b.id]);
    expect(
      second.run((r) => r.readDeploymentOperations(actor)).map((op) => op.id),
    ).toEqual([a.id, b.id]);
    expect(local.length).toBe(2);
    expect(first.run((r) => r.readDeploymentOperation(actor))?.id).toBe(a.id);
    const original = first.run((r) => r.readDeploymentOperation(actor));
    expect(first.run((r) => r.readDeploymentOperation(actor))).toBe(original);
    local.setItem(
      durableKey(a),
      JSON.stringify({ ...a, label: "Changed in another tab" }),
    );
    expect(first.run((r) => r.readDeploymentOperation(actor))?.label).toBe(
      "Changed in another tab",
    );
    second.run((r) => r.finishDeploymentOperation(b));
    expect(
      first.run((r) => r.readDeploymentOperations(actor)).map((op) => op.id),
    ).toEqual([a.id]);
  });

  it("survives closing and restarting a tab without aging out the immutable reviewed request", async () => {
    const local = new BrowserStorage(),
      first = await browserTab(local);
    const mutable = structuredClone(request);
    const op = first.run((r) =>
      r.beginDeploymentOperation(actor, mutable, true, "Exact review"),
    );
    mutable.selector.device_ids.push("not-reviewed");
    expect(() => (op.request.request_id = crypto.randomUUID())).toThrow();
    first.run((r) => {
      r.setDeploymentRequestActive(op, true);
      first.events.dispatchEvent(new Event("pagehide"));
    });
    vi.setSystemTime(new Date("2036-01-01T00:00:00.000Z"));
    const restarted = await browserTab(local);
    expect(restarted.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
    expect(restarted.run((r) => r.isDeploymentRequestActive(op))).toBe(false);
    expect(
      (
        restarted.run((r) => r.readDeploymentOperation(actor)) as Extract<
          DeploymentOperation,
          { kind: "create" }
        >
      ).request.selector.device_ids,
    ).toEqual(["device-a"]);
  });

  it("isolates actors and removes only the reviewed request, including a non-oldest request", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local);
    const a = tab.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "First"),
    );
    const b = tab.run((r) =>
      r.beginRollbackOperation(actor, deployment, true, "Second"),
    );
    const other = tab.run((r) =>
      r.beginDeploymentOperation(otherActor, request, true, "Other actor"),
    );
    tab.run((r) => r.finishDeploymentOperation(b));
    expect(tab.run((r) => r.readDeploymentOperations(actor))).toEqual([a]);
    expect(tab.run((r) => r.readDeploymentOperations(otherActor))).toEqual([
      other,
    ]);
    tab.run((r) => {
      r.finishDeploymentOperation(b);
      r.setDeploymentRequestActive(b, false);
    });
    expect(local.getItem(durableKey(b))).toBeNull();
    expect(tab.run((r) => r.setDeploymentRequestActive(b, true))).toBe(false);
  });

  it("fails before any POST when capacity, the UTF-8 size bound, or storage durability cannot be satisfied", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (let i = 0; i < 10; i++)
      tab.run((r) => r.beginDeploymentOperation(actor, request, true, `${i}`));
    expect(() =>
      tab.run((r) =>
        r.beginRollbackOperation(actor, deployment, true, "Eleventh"),
      ),
    ).toThrow(/ten deployment requests/);
    expect(tab.run((r) => r.readDeploymentOperations(actor))).toHaveLength(10);
    const large = structuredClone(request);
    large.selector.device_ids = Array(10000).fill("😀".repeat(32));
    large.selector.group_ids = Array(10000).fill("😀".repeat(32));
    expect(() =>
      tab.run((r) =>
        r.beginDeploymentOperation(otherActor, large, true, "Too large"),
      ),
    ).toThrow(/too large/);
    local.failWrite = true;
    expect(() =>
      tab.run((r) =>
        r.beginDeploymentOperation(otherActor, request, true, "No storage"),
      ),
    ).toThrow(/local storage/);
    local.failWrite = false;
    local.ignoreWrite = true;
    expect(() =>
      tab.run((r) =>
        r.beginDeploymentOperation(
          otherActor,
          request,
          true,
          "Unverified write",
        ),
      ),
    ).toThrow(/local storage/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "retains a visible reminder if exact cleanup %s fails",
    async (failure) => {
      const local = new BrowserStorage(),
        tab = await browserTab(local);
      const op = tab.run((r) =>
        r.beginRollbackOperation(actor, deployment, true, "Rollback"),
      );
      local[failure] = true;
      expect(() => tab.run((r) => r.finishDeploymentOperation(op))).toThrow(
        /reminder could not be removed/,
      );
      expect(tab.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
      local[failure] = false;
      tab.run((r) => r.finishDeploymentOperation(op));
      expect(tab.run((r) => r.readDeploymentOperation(actor))).toBeNull();
    },
  );

  it("does not remove a same-ID record whose payload changed since the review", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local);
    const op = tab.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "Reviewed"),
    );
    local.setItem(
      durableKey(op),
      JSON.stringify({ ...op, label: "Different saved review" }),
    );
    expect(() => tab.run((r) => r.finishDeploymentOperation(op))).toThrow(
      /reminder/,
    );
    expect(tab.run((r) => r.readDeploymentOperation(actor))?.label).toBe(
      "Different saved review",
    );
  });

  it.each([true, false])(
    "migrates a legacy session operation without changing retry support (%s)",
    async (retrySupported) => {
      const local = new BrowserStorage(),
        session = new BrowserStorage(),
        op = legacyOperation(retrySupported);
      const { kind: _kind, ...legacy } = op;
      session.setItem(oldKey(), JSON.stringify(legacy));
      const tab = await browserTab(local, session);
      expect(tab.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
      expect(session.getItem(oldKey())).toBeNull();
      expect(JSON.parse(local.getItem(durableKey(op))!)).toEqual(op);
      expect(tab.run((r) => r.deploymentOperationPath(op))).toBe(
        "/deployments",
      );
      if (!retrySupported)
        expect(
          tab.run((r) => r.readDeploymentOperation(actor))?.request.request_id,
        ).toBeUndefined();
    },
  );

  it.each(["failWrite", "ignoreWrite"] as const)(
    "keeps legacy recovery readable until migration verifies despite %s",
    async (failure) => {
      const local = new BrowserStorage(),
        session = new BrowserStorage(),
        op = legacyOperation();
      session.setItem(oldKey(), JSON.stringify(op));
      local[failure] = true;
      const tab = await browserTab(local, session);
      expect(tab.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
      expect(session.getItem(oldKey())).not.toBeNull();
      expect(() =>
        tab.run((r) =>
          r.beginRollbackOperation(actor, deployment, true, "New request"),
        ),
      ).toThrow(/local storage/);
      local[failure] = false;
      expect(tab.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
      expect(session.getItem(oldKey())).toBeNull();
    },
  );

  it("does not overwrite conflicting durable data during duplicate migration", async () => {
    const local = new BrowserStorage(),
      session = new BrowserStorage(),
      op = legacyOperation();
    session.setItem(oldKey(), JSON.stringify(op));
    const durable = { ...op, label: "Already durable" };
    local.setItem(durableKey(op), JSON.stringify(durable));
    const tab = await browserTab(local, session);
    const registry = tab.run((r) => r.readDeploymentRegistry(actor));
    expect(registry.operations).toEqual([]);
    expect(registry.errors).toMatchObject([{ kind: "corrupt", id: op.id }]);
    expect(tab.run((r) => r.deploymentOperationAvailable(durable))).toBe(false);
    expect(tab.run((r) => r.setDeploymentRequestActive(durable, true))).toBe(
      false,
    );
    expect(JSON.parse(local.getItem(durableKey(op))!)).toEqual(durable);
    expect(session.getItem(oldKey())).toBe(JSON.stringify(op));
    expect(() => tab.run((r) => r.finishDeploymentOperation(durable))).toThrow(
      /reminder/,
    );
  });

  it("keeps the durable copy if legacy cleanup fails rather than resurrecting it after completion", async () => {
    const local = new BrowserStorage(),
      session = new BrowserStorage(),
      op = legacyOperation();
    session.setItem(oldKey(), JSON.stringify(op));
    session.failRemove = true;
    const tab = await browserTab(local, session);
    expect(tab.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
    expect(local.getItem(durableKey(op))).not.toBeNull();
    expect(() => tab.run((r) => r.finishDeploymentOperation(op))).toThrow(
      /reminder/,
    );
    expect(local.getItem(durableKey(op))).not.toBeNull();
    session.failRemove = false;
    session.failRead = true;
    expect(() => tab.run((r) => r.finishDeploymentOperation(op))).toThrow(
      /reminder/,
    );
    expect(local.getItem(durableKey(op))).not.toBeNull();
    session.failRead = false;
    tab.run((r) => r.finishDeploymentOperation(op));
    expect(tab.run((r) => r.readDeploymentOperation(actor))).toBeNull();
    expect(session.getItem(oldKey())).toBeNull();
  });

  it("surfaces corrupt, oversized, wrong-actor, wrong-key, and unsafe retry records while blocking new create and rollback", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      op = legacyOperation();
    const cases = [
      "{",
      " ".repeat(2_000_001),
      JSON.stringify({ ...op, actor_id: otherActor }),
      JSON.stringify({ ...op, id: crypto.randomUUID() }),
      JSON.stringify({ ...op, secret: "not an allowed field" }),
      JSON.stringify({
        ...op,
        request: { ...op.request, request_id: crypto.randomUUID() },
      }),
    ];
    for (const raw of cases) {
      local.setItem(durableKey(op), raw);
      const registry = tab.run((r) => r.readDeploymentRegistry(actor));
      expect(registry.operations).toEqual([]);
      expect(registry.errors).toMatchObject([
        { actor_id: actor, id: op.id, kind: "corrupt" },
      ]);
      expect(Object.keys(registry.errors[0]).sort()).toEqual([
        "actor_id",
        "id",
        "kind",
        "message",
      ]);
      expect(() =>
        tab.run((r) =>
          r.beginDeploymentOperation(actor, request, true, "New create"),
        ),
      ).toThrow(/cannot be read/);
      expect(() =>
        tab.run((r) =>
          r.beginRollbackOperation(actor, deployment, true, "New rollback"),
        ),
      ).toThrow(/cannot be read/);
      expect(local.length).toBe(1);
      expect(local.getItem(durableKey(op))).toBe(raw);
    }
  });

  it("keeps unrelated valid requests recoverable beside corruption and isolates other actors", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local);
    const valid = tab.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "Valid"),
    );
    const damaged = legacyOperation();
    local.setItem(durableKey(damaged), "{private damaged bytes");
    local.setItem(
      durableKey({ ...damaged, actor_id: otherActor }),
      "{other account",
    );
    const registry = tab.run((r) => r.readDeploymentRegistry(actor));
    expect(registry.operations).toEqual([valid]);
    expect(registry.errors).toHaveLength(1);
    expect(tab.run((r) => r.deploymentOperationAvailable(valid))).toBe(true);
    expect(tab.run((r) => r.setDeploymentRequestActive(valid, true))).toBe(
      true,
    );
    tab.run((r) => r.finishDeploymentOperation(valid));
    expect(local.getItem(durableKey(damaged))).toBe("{private damaged bytes");
    expect(JSON.stringify(registry.errors)).not.toContain(
      "private damaged bytes",
    );
  });

  it("never derives a lookup identity from malformed durable suffixes or legacy bodies", async () => {
    const local = new BrowserStorage(),
      session = new BrowserStorage(),
      tab = await browserTab(local, session);
    const op = legacyOperation();
    local.setItem(
      `vectory:deployment-operation:${actor}:not-a-uuid`,
      JSON.stringify(op),
    );
    session.setItem(oldKey(), JSON.stringify({ ...op, request: "damaged" }));
    const registry = tab.run((r) => r.readDeploymentRegistry(actor));
    expect(registry.operations).toEqual([]);
    expect(registry.errors).toHaveLength(2);
    expect(
      registry.errors.every((issue) => issue.kind === "corrupt" && !issue.id),
    ).toBe(true);
    expect(() =>
      tab.run((r) =>
        r.beginRollbackOperation(actor, deployment, true, "Blocked"),
      ),
    ).toThrow();
    for (const issue of registry.errors)
      tab.run((r) => r.dismissDeploymentStorageIssue(issue));
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });

  it.each(["local", "session"] as const)(
    "reports %s read failures without hiding readable valid operations",
    async (area) => {
      const local = new BrowserStorage(),
        session = new BrowserStorage(),
        tab = await browserTab(local, session);
      const op = legacyOperation();
      local.setItem(durableKey(op), JSON.stringify(op));
      if (area === "local") session.setItem(oldKey(), JSON.stringify(op));
      const storage = area === "local" ? local : session;
      storage.failRead = true;
      const registry = tab.run((r) => r.readDeploymentRegistry(actor));
      expect(registry.operations).toEqual([op]);
      expect(
        registry.errors.some((issue) => issue.kind === "unavailable"),
      ).toBe(true);
      expect(tab.run((r) => r.deploymentOperationAvailable(op))).toBe(false);
      expect(() =>
        tab.run((r) =>
          r.beginDeploymentOperation(actor, request, true, "Blocked"),
        ),
      ).toThrow(/local storage/);
      expect(() =>
        tab.run((r) =>
          r.beginRollbackOperation(actor, deployment, true, "Blocked"),
        ),
      ).toThrow(/local storage/);
      storage.failRead = false;
      expect(tab.run((r) => r.readDeploymentRegistry(actor)).errors).toEqual(
        [],
      );
      expect(tab.run((r) => r.deploymentOperationAvailable(op))).toBe(true);
    },
  );

  it("keeps other readable records when one record read fails", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      op = legacyOperation();
    const valid = tab.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "Readable"),
    );
    const read = local.getItem.bind(local);
    local.setItem(durableKey(op), "{");
    vi.spyOn(local, "getItem").mockImplementation((key) => {
      if (key === durableKey(op)) throw Error("Read denied");
      return read(key);
    });
    const registry = tab.run((r) => r.readDeploymentRegistry(actor));
    expect(registry.errors.some((issue) => issue.kind === "unavailable")).toBe(
      true,
    );
    expect(registry.operations).toEqual([valid]);
    expect(local.data.get(durableKey(valid))).toBeTruthy();
    expect(() =>
      tab.run((r) =>
        r.beginRollbackOperation(actor, deployment, true, "Blocked"),
      ),
    ).toThrow();
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "retains an exact unreadable reminder on %s and permits explicit cleanup later",
    async (failure) => {
      const local = new BrowserStorage(),
        tab = await browserTab(local),
        op = legacyOperation();
      local.setItem(durableKey(op), "{unreadable");
      const [issue] = tab.run((r) => r.readDeploymentRegistry(actor)).errors;
      local[failure] = true;
      expect(() =>
        tab.run((r) => r.dismissDeploymentStorageIssue(issue)),
      ).toThrow(/reminder/);
      expect(local.getItem(durableKey(op))).toBe("{unreadable");
      local[failure] = false;
      tab.run((r) => r.dismissDeploymentStorageIssue(issue));
      expect(tab.run((r) => r.readDeploymentRegistry(actor))).toEqual({
        operations: [],
        errors: [],
      });
    },
  );

  it("refuses stale, copied, or forged issue cleanup and preserves a peer repair", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      op = legacyOperation();
    local.setItem(durableKey(op), "{damaged");
    const [issue] = tab.run((r) => r.readDeploymentRegistry(actor)).errors;
    expect(() =>
      tab.run((r) => r.dismissDeploymentStorageIssue({ ...issue })),
    ).toThrow(/Refresh/);
    local.setItem(durableKey(op), JSON.stringify(op));
    expect(() =>
      tab.run((r) => r.dismissDeploymentStorageIssue(issue)),
    ).toThrow(/reminder/);
    expect(tab.run((r) => r.readDeploymentOperations(actor))).toEqual([op]);
  });

  it.each(["local", "session"] as const)(
    "checks both conflicting snapshots before deleting either when %s is repaired",
    async (area) => {
      const local = new BrowserStorage(),
        session = new BrowserStorage(),
        tab = await browserTab(local, session),
        op = legacyOperation();
      const durable = JSON.stringify({ ...op, label: "Durable original" });
      const legacy = JSON.stringify(op);
      local.setItem(durableKey(op), durable);
      session.setItem(oldKey(), legacy);
      const [issue] = tab.run((r) => r.readDeploymentRegistry(actor)).errors;
      const repaired = JSON.stringify({ ...op, label: "Peer repair" });
      if (area === "local") local.setItem(durableKey(op), repaired);
      else session.setItem(oldKey(), repaired);
      expect(() =>
        tab.run((r) => r.dismissDeploymentStorageIssue(issue)),
      ).toThrow(/reminder/);
      expect(local.getItem(durableKey(op))).toBe(
        area === "local" ? repaired : durable,
      );
      expect(session.getItem(oldKey())).toBe(
        area === "session" ? repaired : legacy,
      );
      const [fresh] = tab.run((r) => r.readDeploymentRegistry(actor)).errors;
      tab.run((r) => r.dismissDeploymentStorageIssue(fresh));
      expect(local.length).toBe(0);
      expect(session.length).toBe(0);
    },
  );

  it("bounds visible overflow without dropping stored records and blocks new intent", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      op = legacyOperation();
    for (let i = 0; i < 12; i++) {
      const id = crypto.randomUUID();
      const row = { ...op, id, request: { ...op.request, request_id: id } };
      local.setItem(durableKey(row), JSON.stringify(row));
    }
    const registry = tab.run((r) => r.readDeploymentRegistry(actor));
    expect(registry.operations).toHaveLength(10);
    expect(registry.errors).toMatchObject([{ kind: "capacity" }]);
    expect(local.length).toBe(12);
    expect(() =>
      tab.run((r) =>
        r.beginDeploymentOperation(actor, request, true, "Overflow"),
      ),
    ).toThrow(/Additional/);
    tab.run((r) => r.finishDeploymentOperation(registry.operations[0]));
    expect(
      tab.run((r) => r.readDeploymentRegistry(actor)).operations,
    ).toHaveLength(10);
  });

  it("never deletes a newly visible intent after a cross-tab capacity race", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      op = legacyOperation();
    const write = local.setItem.bind(local);
    vi.spyOn(local, "setItem").mockImplementation((key, value) => {
      write(key, value);
      for (let i = 0; i < 10; i++) {
        const id = crypto.randomUUID();
        const peer = { ...op, id, request: { ...op.request, request_id: id } };
        write(durableKey(peer), JSON.stringify(peer));
      }
    });
    expect(() =>
      tab.run((r) =>
        r.beginDeploymentOperation(actor, request, true, "Just published"),
      ),
    ).toThrow(/ten deployment/);
    expect(local.length).toBe(11);
    expect(
      [...local.data.values()].map((raw) => JSON.parse(raw).label),
    ).toContain("Just published");
  });

  it("notifies same-tab writes, cross-tab storage changes and focus, and disposes subscriptions", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local),
      refresh = vi.fn();
    const stop = tab.run((r) =>
      r.subscribeDeploymentOperations(actor, refresh),
    );
    const op = tab.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "Changed"),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    tab.events.dispatchEvent(
      storageEvent(durableKey({ ...op, actor_id: otherActor })),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    tab.events.dispatchEvent(storageEvent(durableKey(op)));
    tab.events.dispatchEvent(new Event("focus"));
    tab.events.dispatchEvent(new Event("pageshow"));
    expect(refresh).toHaveBeenCalledTimes(4);
    tab.run(() => stop());
    tab.events.dispatchEvent(new Event("focus"));
    tab.events.dispatchEvent(storageEvent(durableKey(op)));
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("treats another tab's lease as a bounded hint, releases only owned tokens, and never recreates finished records", async () => {
    const local = new BrowserStorage(),
      first = await browserTab(local),
      second = await browserTab(local);
    const op = first.run((r) =>
      r.beginDeploymentOperation(actor, request, true, "In flight"),
    );
    expect(first.run((r) => r.setDeploymentRequestActive(op, true))).toBe(true);
    expect(second.run((r) => r.isDeploymentRequestActive(op))).toBe(true);
    expect(second.run((r) => r.setDeploymentRequestActive(op, true))).toBe(
      false,
    );
    second.run((r) => r.setDeploymentRequestActive(op, false));
    expect(second.run((r) => r.isDeploymentRequestActive(op))).toBe(true);
    first.run((r) => r.releaseDeploymentRequestLeases(actor));
    expect(second.run((r) => r.isDeploymentRequestActive(op))).toBe(false);
    expect(second.run((r) => r.setDeploymentRequestActive(op, true))).toBe(
      true,
    );
    // The first tab's late finally must not clear the second tab's fresh hint.
    first.run((r) => r.setDeploymentRequestActive(op, false));
    expect(second.run((r) => r.isDeploymentRequestActive(op))).toBe(true);
    second.run((r) => r.finishDeploymentOperation(op));
    second.run((r) => {
      vi.advanceTimersByTime(60_000);
      r.setDeploymentRequestActive(op, false);
    });
    expect(local.getItem(durableKey(op))).toBeNull();
    expect(local.getItem(hintKey(op))).toBeNull();
  });

  it("allows review after a crashed tab's hint expires and ignores corrupt or far-future hints", async () => {
    const local = new BrowserStorage(),
      tab = await browserTab(local);
    const op = tab.run((r) =>
      r.beginRollbackOperation(actor, deployment, true, "Preserved"),
    );
    const now = Date.now(),
      token = crypto.randomUUID();
    local.setItem(
      hintKey(op),
      JSON.stringify({ token, issued_at: now, expires_at: now + 45_000 }),
    );
    expect(tab.run((r) => r.isDeploymentRequestActive(op))).toBe(true);
    vi.setSystemTime(now + 45_001);
    expect(tab.run((r) => r.isDeploymentRequestActive(op))).toBe(false);
    expect(tab.run((r) => r.readDeploymentOperation(actor))).toEqual(op);
    local.setItem(
      hintKey(op),
      JSON.stringify({
        token,
        issued_at: Date.now(),
        expires_at: Date.now() + 86_400_000,
      }),
    );
    expect(tab.run((r) => r.isDeploymentRequestActive(op))).toBe(false);
    local.setItem(hintKey(op), "{");
    expect(tab.run((r) => r.isDeploymentRequestActive(op))).toBe(false);
    expect(tab.run((r) => r.setDeploymentRequestActive(op, true))).toBe(true);
    tab.run((r) => r.releaseDeploymentRequestLeases());
  });

  it.each(["failure", "replacement"] as const)(
    "refuses the send claim after a detected %s between initial availability and lease renewal",
    async (change) => {
      const local = new BrowserStorage(),
        tab = await browserTab(local);
      const op = tab.run((r) =>
        r.beginDeploymentOperation(actor, request, true, "Reviewed"),
      );
      const read = local.getItem.bind(local);
      let operationReads = 0;
      vi.spyOn(local, "getItem").mockImplementation((key) => {
        if (key === durableKey(op) && ++operationReads >= 3) {
          if (change === "failure") throw Error("Storage no longer readable");
          return JSON.stringify({ ...op, label: "Peer replaced review" });
        }
        return read(key);
      });
      expect(tab.run((r) => r.setDeploymentRequestActive(op, true))).toBe(
        false,
      );
      expect(tab.run((r) => r.isDeploymentRequestActive(op))).toBe(false);
      expect(local.data.has(durableKey(op))).toBe(true);
      expect(local.data.has(hintKey(op))).toBe(false);
    },
  );
});
