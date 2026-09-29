import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TokenCreateResultSchema,
  TokenRecordSchema,
  TokenRequestStatusSchema,
  beginTokenRequest,
  checkTokenCreation,
  checkTokenStatus,
  confirmTokenRequest,
  dismissTokenRequestIssue,
  enrollmentNote,
  finishTokenRequest,
  readTokenRequests,
  resolveTokenRequests,
  statusOutcome,
  subscribeTokenRequests,
  tokenRequestAvailable,
  type ListedToken,
  type TokenCreateInput,
  type TokenRequestOperation,
} from "./enrollmentTokenRequests";

class BrowserStorage implements Storage {
  readonly values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;
  ignoreWrite = false;
  ignoreRemove = false;
  afterWrite?: () => void;
  afterRemove?: () => void;
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
    if (!this.ignoreWrite) this.values.set(key, value);
    this.afterWrite?.();
  }
  removeItem(key: string) {
    if (this.failRemove) throw Error("Blocked");
    if (!this.ignoreRemove) this.values.delete(key);
    this.afterRemove?.();
  }
  clear() {
    this.values.clear();
  }
}
const actor = "332aa515-d0e8-45a3-a3c9-89d18af8d300";
const other = "521ace4d-0d16-4aac-89c6-cd9912a17763";
const input: TokenCreateInput = {
  name: "Lab enrollment",
  expires_hours: 24,
  max_uses: 3,
  name_prefix: "lab-",
};
const key = (op: Pick<TokenRequestOperation, "actor_id" | "id">) =>
  `vectory:enrollment-token-request:${encodeURIComponent(op.actor_id)}:${op.id}`;
const fixture = (
  id = crypto.randomUUID(),
  who = actor,
): TokenRequestOperation => ({
  actor_id: who,
  id,
  recorded_at: "2026-09-01T00:00:00.000Z",
  request: { ...input, request_id: id },
});
const record = () => ({
  id: other,
  name: input.name,
  expires_at: "2026-09-28T00:00:00Z",
  uses: 0,
  max_uses: input.max_uses,
  name_prefix: input.name_prefix,
  revoked: false,
  created_at: "2026-09-27T00:00:00Z",
});
const found = (id: string) => ({
  request_id: id,
  request_correlation: true as const,
  found: true as const,
  state: "created" as const,
  record: record(),
});
const receipt = (id: string) => ({
  request_id: id,
  request_correlation: true as const,
  token: "synthetic-one-time-secret",
  record: record(),
});
const storageEvent = (changedKey: string | null) => {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: changedKey });
  return event;
};
let storage: BrowserStorage;
let events: EventTarget;
beforeEach(() => {
  storage = new BrowserStorage();
  events = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", events);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("durable enrollment token request registry", () => {
  it("retains exact frozen input before a send and recovers it after a module reload without a secret", async () => {
    const draft = { ...input };
    const op = beginTokenRequest(actor, draft);
    draft.name = "Edited later";
    expect(op.request).toEqual({ ...input, request_id: op.id });
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(op.request)).toBe(true);
    expect(JSON.parse(storage.getItem(key(op))!)).toEqual(op);
    checkTokenCreation(op, receipt(op.id));
    expect(storage.getItem(key(op))).not.toContain("synthetic-one-time-secret");
    vi.resetModules();
    const reloaded = await import("./enrollmentTokenRequests");
    const recovered = reloaded.readTokenRequests(actor).operations[0];
    expect(recovered).toEqual(op);
    expect(reloaded.tokenRequestAvailable(recovered)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a fresh request after an interrupted operation even when the caller bypasses UI state", () => {
    const op = beginTokenRequest(actor, input);
    expect(() =>
      beginTokenRequest(actor, { ...input, name: "Another" }),
    ).toThrow(/saved token requests/);
    expect(readTokenRequests(actor).operations).toEqual([op]);
    expect(storage.length).toBe(1);
  });

  it("separates actors and retains old requests without a time-based expiry", () => {
    const old = fixture();
    old.recorded_at = "2020-01-01T00:00:00.000Z";
    storage.setItem(key(old), JSON.stringify(old));
    const peer = beginTokenRequest(other, input);
    expect(readTokenRequests(actor).operations).toEqual([old]);
    expect(readTokenRequests(other).operations).toEqual([peer]);
    finishTokenRequest(peer);
    expect(storage.getItem(key(old))).not.toBeNull();
  });

  it("converges independent tab reads and removes only the selected exact request", async () => {
    const first = beginTokenRequest(actor, input),
      second = fixture();
    storage.setItem(key(second), JSON.stringify(second));
    vi.resetModules();
    const tab = await import("./enrollmentTokenRequests");
    expect(
      tab
        .readTokenRequests(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    finishTokenRequest(first);
    expect(tab.readTokenRequests(actor).operations).toEqual([second]);
    expect(tokenRequestAvailable(first)).toBe(false);
  });

  it.each(["failRead", "failWrite", "ignoreWrite"] as const)(
    "fails closed on %s without initiating network work",
    (mode) => {
      storage[mode] = true;
      expect(() => beginTokenRequest(actor, input)).toThrow(/storage/);
      expect(fetch).not.toHaveBeenCalled();
      storage[mode] = false;
      expect(storage.length).toBe(0);
    },
  );

  it("keeps a possibly persisted request when read-back fails after writing", () => {
    storage.afterWrite = () => {
      storage.failRead = true;
    };
    expect(() => beginTokenRequest(actor, input)).toThrow(/storage/);
    expect(storage.values.size).toBe(1);
    storage.failRead = false;
    const recovered = readTokenRequests(actor);
    expect(recovered.errors).toEqual([]);
    expect(recovered.operations[0].request.name).toBe(input.name);
    expect(() => beginTokenRequest(actor, input)).toThrow();
  });

  it("retains an interleaved peer write instead of overwriting a shared list", () => {
    const peer = fixture();
    storage.afterWrite = () => {
      storage.values.set(key(peer), JSON.stringify(peer));
    };
    const local = beginTokenRequest(actor, input);
    expect(
      readTokenRequests(actor)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([peer.id, local.id].sort());
    finishTokenRequest(local);
    expect(readTokenRequests(actor).operations).toEqual([peer]);
  });

  it("bounds displayed records while preserving overflow and blocking new intent", () => {
    for (let i = 0; i < 12; i++) {
      const op = fixture();
      storage.setItem(key(op), JSON.stringify(op));
    }
    const registry = readTokenRequests(actor);
    expect(registry.operations).toHaveLength(10);
    expect(registry.errors.map((error) => error.kind)).toEqual(["capacity"]);
    expect(() => beginTokenRequest(actor, input)).toThrow(/Additional saved/);
    expect(storage.length).toBe(12);
    registry.operations.forEach(finishTokenRequest);
    expect(readTokenRequests(actor).operations).toHaveLength(2);
    expect(readTokenRequests(actor).errors).toEqual([]);
  });

  it("leaves all interleaved records intact if a write exceeds capacity", () => {
    storage.afterWrite = () => {
      for (let i = 0; i < 10; i++) {
        const peer = fixture();
        storage.values.set(key(peer), JSON.stringify(peer));
      }
    };
    expect(() => beginTokenRequest(actor, input)).toThrow(/ten requests/);
    expect(storage.length).toBe(11);
    expect(
      readTokenRequests(actor).errors.some(
        (issue) => issue.kind === "capacity",
      ),
    ).toBe(true);
  });

  it("exposes damaged entries without leaking their payload or inventing an operation", () => {
    const op = fixture();
    for (const corrupt of [
      "{broken",
      "x".repeat(8193),
      JSON.stringify({ ...op, actor_id: other }),
      JSON.stringify({ ...fixture(other) }),
      JSON.stringify({ ...op, token: "sensitive-unexpected-value" }),
      JSON.stringify({
        ...op,
        request: { ...input, request_id: other },
      }),
    ]) {
      storage.clear();
      storage.setItem(key(op), corrupt);
      const registry = readTokenRequests(actor);
      expect(registry.operations).toEqual([]);
      expect(registry.errors).toHaveLength(1);
      expect(registry.errors[0]).toMatchObject({
        id: op.id,
        actor_id: actor,
        kind: "corrupt",
      });
      expect(JSON.stringify(registry.errors)).not.toContain(
        "sensitive-unexpected-value",
      );
      expect(Object.keys(registry.errors[0]).sort()).toEqual([
        "actor_id",
        "id",
        "kind",
        "message",
      ]);
      expect(() => beginTokenRequest(actor, input)).toThrow();
      expect(storage.getItem(key(op))).toBe(corrupt);
    }
  });

  it("uses only a valid actor-scoped key for status-only recovery, never a body-supplied ID", () => {
    const op = fixture();
    storage.setItem(key(op) + "-invalid", JSON.stringify(op));
    const issue = readTokenRequests(actor).errors[0];
    expect(issue.id).toBeUndefined();
    expect(readTokenRequests(other)).toEqual({ operations: [], errors: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports unavailable storage and leaves a known valid request safe to review after recovery", () => {
    const op = beginTokenRequest(actor, input);
    storage.failRead = true;
    expect(readTokenRequests(actor).errors[0].kind).toBe("unavailable");
    expect(tokenRequestAvailable(op)).toBe(false);
    expect(() => finishTokenRequest(op)).toThrow(/reminder/);
    storage.failRead = false;
    expect(tokenRequestAvailable(op)).toBe(true);
  });

  it("allows an exact known request to remain available alongside an unrelated corrupt record", () => {
    const op = beginTokenRequest(actor, input),
      damaged = fixture();
    storage.setItem(key(damaged), "broken");
    expect(readTokenRequests(actor).errors).toHaveLength(1);
    expect(tokenRequestAvailable(op)).toBe(true);
    finishTokenRequest(op);
    expect(storage.getItem(key(damaged))).toBe("broken");
  });

  it("refuses changed payloads and even same-value byte replacements during cleanup", () => {
    const op = beginTokenRequest(actor, input);
    for (const replacement of [
      JSON.stringify({
        ...op,
        request: { ...op.request, name: "Peer changed" },
      }),
      JSON.stringify(op, null, 2),
    ]) {
      storage.setItem(key(op), replacement);
      expect(tokenRequestAvailable(op)).toBe(false);
      expect(() => finishTokenRequest(op)).toThrow(/reminder/);
      expect(storage.getItem(key(op))).toBe(replacement);
    }
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "reports %s and keeps the reminder without losing a confirmed result",
    (mode) => {
      const op = beginTokenRequest(actor, input);
      const confirmed = checkTokenCreation(op, receipt(op.id));
      storage[mode] = true;
      expect(() => finishTokenRequest(op)).toThrow(/reminder/);
      expect(confirmed).toEqual(receipt(op.id));
      expect(tokenRequestAvailable(op)).toBe(true);
      storage[mode] = false;
      finishTokenRequest(op);
      finishTokenRequest(op);
      expect(storage.length).toBe(0);
    },
  );

  it("reports a replacement appearing after removal instead of claiming cleanup succeeded", () => {
    const op = beginTokenRequest(actor, input);
    const replacement = JSON.stringify({
      ...op,
      request: { ...op.request, name: "Repaired" },
    });
    storage.afterRemove = () => storage.values.set(key(op), replacement);
    expect(() => finishTokenRequest(op)).toThrow(/reminder/);
    expect(storage.getItem(key(op))).toBe(replacement);
  });

  it("requires a captured opaque snapshot for cleanup and corrupt dismissal", () => {
    const op = beginTokenRequest(actor, input);
    expect(tokenRequestAvailable(structuredClone(op))).toBe(false);
    expect(() => finishTokenRequest(structuredClone(op))).toThrow();
    expect(() =>
      dismissTokenRequestIssue({
        actor_id: actor,
        id: op.id,
        kind: "corrupt",
        message: "invented",
      }),
    ).toThrow(/Refresh/);
    expect(storage.length).toBe(1);
  });

  it("refuses stale corrupt dismissal after a peer repairs the original bytes", () => {
    const op = fixture();
    storage.setItem(key(op), "broken");
    const issue = readTokenRequests(actor).errors[0];
    storage.setItem(key(op), JSON.stringify(op));
    expect(() => dismissTokenRequestIssue(issue)).toThrow(/reminder/);
    expect(readTokenRequests(actor).operations).toEqual([op]);
    storage.setItem(key(op), "still broken");
    dismissTokenRequestIssue(readTokenRequests(actor).errors[0]);
    expect(storage.length).toBe(0);
  });

  it("rejects invalid inputs, attacker-supplied identities and secret fields before persistence", () => {
    for (const invalid of [
      { ...input, name: " " },
      { ...input, name: "bad\0name" },
      { ...input, name: "🚀".repeat(31) },
      { ...input, expires_hours: 0 },
      { ...input, expires_hours: 721 },
      { ...input, expires_hours: 1.5 },
      { ...input, max_uses: 0 },
      { ...input, max_uses: 100001 },
      { ...input, max_uses: "3" },
      { ...input, name_prefix: "UPPER" },
      { ...input, name_prefix: "" },
      { ...input, name_prefix: "x".repeat(81) },
      { ...input, request_id: other },
      { ...input, token: "do-not-persist" },
    ]) {
      expect(() =>
        beginTokenRequest(actor, invalid as TokenCreateInput),
      ).toThrow();
      expect(storage.length).toBe(0);
    }
    const op = beginTokenRequest(actor, {
      ...input,
      name: "🚀".repeat(30),
      max_uses: null,
      name_prefix: null,
    });
    expect(op.request.name).toBe("🚀".repeat(30));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses invalid actors safely, including an unpaired key-encoding surrogate", () => {
    for (const who of ["", "x".repeat(129), "\ud800"]) {
      expect(readTokenRequests(who).errors[0].kind).toBe("unavailable");
      expect(() => beginTokenRequest(who, input)).toThrow(/Sign in/);
    }
    expect(storage.length).toBe(0);
  });

  it("refreshes same-tab, actor-scoped cross-tab and lifecycle observations and unsubscribes", () => {
    const refresh = vi.fn(),
      stop = subscribeTokenRequests(actor, refresh);
    const op = beginTokenRequest(actor, input);
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(storageEvent(key({ actor_id: other, id: op.id })));
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(storageEvent(key(op)));
    events.dispatchEvent(storageEvent(null));
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("pageshow"));
    expect(refresh).toHaveBeenCalledTimes(5);
    stop();
    finishTokenRequest(op);
    events.dispatchEvent(storageEvent(null));
    expect(refresh).toHaveBeenCalledTimes(5);
  });
});

describe("correlated enrollment token responses", () => {
  it("accepts a first secret, secret-free replay, and cancellation tombstone without inventing a secret", () => {
    const op = beginTokenRequest(actor, input);
    expect(checkTokenCreation(op, receipt(op.id))).toEqual(receipt(op.id));
    expect(checkTokenCreation(op, found(op.id))).toEqual(found(op.id));
    const cancelled = { ...found(op.id), state: "cancelled", record: null };
    expect(checkTokenCreation(op, cancelled)).toEqual(cancelled);
    expect(checkTokenStatus(op.id, cancelled, op)).toEqual(cancelled);
    expect(storage.length).toBe(1);
  });

  it("requires exact case-insensitive request echo for found, absent and initial replies", () => {
    const op = beginTokenRequest(actor, input);
    const absent = {
      request_id: op.id,
      request_correlation: true,
      found: false,
    };
    expect(checkTokenStatus(op.id.toUpperCase(), absent, op)).toEqual(absent);
    expect(() => checkTokenStatus(other, absent)).toThrow(/different/);
    expect(() => checkTokenStatus(op.id, found(other), op)).toThrow(
      /different/,
    );
    expect(() => checkTokenCreation(op, receipt(other))).toThrow(/different/);
    expect(() => checkTokenStatus(op.id, found(op.id), fixture())).toThrow(
      /different/,
    );
    expect(tokenRequestAvailable(op)).toBe(true);
  });

  it("matches immutable name, use limit and prefix without treating mutable token state as original intent", () => {
    const op = beginTokenRequest(actor, input);
    for (const patch of [
      { name: "Different" },
      { max_uses: null },
      { name_prefix: null },
      { recovery_device_id: actor },
      { recovery_name: "unexpected-recovery" },
    ]) {
      const result = { ...receipt(op.id), record: { ...record(), ...patch } };
      expect(() => checkTokenCreation(op, result)).toThrow(/does not match/);
      expect(() =>
        checkTokenStatus(op.id, { ...found(op.id), record: result.record }, op),
      ).toThrow(/does not match/);
    }
    const usedRevoked = {
      ...found(op.id),
      record: { ...record(), uses: 3, revoked: true },
    };
    expect(checkTokenStatus(op.id, usedRevoked, op)).toEqual(usedRevoked);
    expect(
      checkTokenStatus(op.id, { ...usedRevoked, state: "cancelled" }, op).found,
    ).toBe(true);
  });

  it("keeps a scoped request's names and labels and matches its receipt exactly", () => {
    const scoped = {
      ...input,
      allowed_names: ["lab-01", "lab-02"],
      labels: { site: "berlin", rack: "r12" },
    };
    const op = beginTokenRequest(actor, scoped);
    expect(op.request.allowed_names).toEqual(["lab-01", "lab-02"]);
    // The server returns labels with its own key order.
    const stored = {
      ...record(),
      allowed_names: ["lab-01", "lab-02"],
      labels: { rack: "r12", site: "berlin" },
    };
    expect(
      checkTokenCreation(op, { ...receipt(op.id), record: stored }).record,
    ).toEqual(stored);
    for (const patch of [
      { allowed_names: ["lab-01"] },
      { allowed_names: undefined },
      { labels: { site: "berlin" } },
      { labels: undefined },
    ]) {
      const result = { ...receipt(op.id), record: { ...stored, ...patch } };
      expect(() => checkTokenCreation(op, result)).toThrow(/does not match/);
    }
    for (const invalid of [
      { ...input, allowed_names: [] },
      { ...input, allowed_names: ["Not Normalized"] },
      { ...input, labels: { "bad key": "x" } },
      {
        ...input,
        labels: Object.fromEntries(
          Array.from({ length: 9 }, (_, n) => [`k${n}`, "v"]),
        ),
      },
    ])
      expect(() =>
        beginTokenRequest(actor, invalid as TokenCreateInput),
      ).toThrow(/names and labels/);
    // An unscoped request can't adopt a receipt that carries a scope.
    const plain = fixture();
    expect(() =>
      checkTokenCreation(plain, { ...receipt(plain.id), record: stored }),
    ).toThrow(/does not match/);
  });

  it("checks status-only identity without reconstructing an unreadable payload or enabling creation", () => {
    const result = {
      ...found(actor),
      record: { ...record(), name: "Actual saved token", max_uses: null },
    };
    expect(checkTokenStatus(actor, result)).toEqual(result);
    expect(() => checkTokenStatus(other, result)).toThrow(/different/);
    expect(storage.length).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported, contradictory or secret-bearing status envelopes", () => {
    for (const malformed of [
      { found: false },
      { request_id: actor, found: false },
      { request_id: actor, request_correlation: false, found: false },
      { ...found(actor), record: null },
      { ...found(actor), state: "cancelled" },
      { ...found(actor), token: "unexpected-secret" },
      { ...found(actor), state: "unknown" },
      {
        request_id: actor,
        request_correlation: true,
        found: false,
        record: record(),
      },
    ])
      expect(TokenRequestStatusSchema.safeParse(malformed).success).toBe(false);
    expect(
      TokenCreateResultSchema.safeParse({
        request_id: actor,
        request_correlation: true,
        found: false,
      }).success,
    ).toBe(false);
    expect(
      TokenCreateResultSchema.safeParse({ ...receipt(actor), token: "" })
        .success,
    ).toBe(false);
    expect(
      TokenCreateResultSchema.safeParse({
        ...receipt(actor),
        token: "x".repeat(513),
      }).success,
    ).toBe(false);
    expect(
      TokenCreateResultSchema.safeParse({
        ...receipt(actor),
        record: { ...record(), revoked: true },
      }).success,
    ).toBe(false);
    expect(
      TokenCreateResultSchema.safeParse({
        ...receipt(actor),
        record: { ...record(), uses: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete or unbounded records and permits explicit global recovery metadata", () => {
    for (const patch of [
      { id: "not-uuid" },
      { uses: -1 },
      { uses: Number.MAX_SAFE_INTEGER + 1 },
      { max_uses: 0 },
      { max_uses: undefined },
      { name_prefix: undefined },
      { expires_at: "tomorrow" },
      { created_at: "" },
      { revoked: "false" },
      { name: "🚀".repeat(31) },
      { unknown: true },
    ])
      expect(
        TokenRecordSchema.safeParse({ ...record(), ...patch }).success,
      ).toBe(false);
    expect(
      TokenRecordSchema.safeParse({
        ...record(),
        recovery_device_id: actor,
        recovery_name: "node-1",
      }).success,
    ).toBe(true);
  });
});

describe("stored requests resolved against the token list", () => {
  // Local wall-clock times, so the sentences read the same in any time zone.
  const now = new Date(2026, 8, 29, 17, 20).valueOf();
  const at = (hour: number, minute: number, day = 29) =>
    new Date(2026, 8, day, hour, minute).toISOString();
  const plain = (text: string | null | undefined) => text?.replace(/ /g, " ");
  const listed = (patch: Partial<ListedToken> = {}): ListedToken => ({
    id: other,
    name: "r16-full install command",
    expires_at: at(18, 14),
    uses: 0,
    max_uses: 1,
    revoked: false,
    devices: [],
    device_count: 0,
    ...patch,
  });
  const enrolled = listed({
    uses: 1,
    last_used_at: at(17, 15),
    device_count: 1,
    devices: [{ name: "r16-full", enrolled_at: at(17, 15) }],
  });
  function confirmedRequest() {
    const op = beginTokenRequest(actor, input);
    return confirmTokenRequest(op, { id: other });
  }

  it("records the token a displayed command created, without its secret, and never blocks another request", () => {
    const op = beginTokenRequest(actor, input);
    checkTokenCreation(op, receipt(op.id));
    const shown = confirmTokenRequest(op, { id: other });
    expect(shown.token_id).toBe(other);
    expect(shown.confirmed_at).toBeTruthy();
    expect(tokenRequestAvailable(op)).toBe(false);
    expect(tokenRequestAvailable(shown)).toBe(true);
    expect(storage.getItem(key(op))).not.toContain("synthetic-one-time-secret");
    expect(readTokenRequests(actor).operations).toEqual([shown]);
    const next = beginTokenRequest(actor, { ...input, name: "Another" });
    expect(readTokenRequests(actor).operations.map((item) => item.id)).toEqual(
      expect.arrayContaining([shown.id, next.id]),
    );
    // A confirmation naming another token is refused.
    expect(() => confirmTokenRequest(shown, { id: actor })).toThrow();
    expect(confirmTokenRequest(shown, { id: other })).toBe(shown);
  });

  it("keeps blocking a request whose response never arrived", () => {
    beginTokenRequest(actor, input);
    expect(() => beginTokenRequest(actor, input)).toThrow(
      /saved token requests/,
    );
  });

  it("refuses to confirm a reminder another tab changed", () => {
    const op = beginTokenRequest(actor, input);
    storage.values.set(
      key(op),
      JSON.stringify({ ...op, request: { ...op.request, name: "Peer" } }),
    );
    expect(() => confirmTokenRequest(op, { id: other })).toThrow(/storage/);
  });

  it("makes room by dropping the oldest confirmed reminders, never an unconfirmed one", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 29, 9, 0));
    const first = confirmedRequest();
    for (let i = 1; i < 10; i++) {
      vi.setSystemTime(new Date(2026, 8, 29, 9, i));
      confirmedRequest();
    }
    vi.useRealTimers();
    expect(storage.length).toBe(10);
    const fresh = beginTokenRequest(actor, input);
    expect(storage.length).toBe(10);
    expect(storage.getItem(key(first))).toBeNull();
    expect(storage.getItem(key(fresh))).not.toBeNull();
    expect(() => beginTokenRequest(actor, input)).toThrow(
      /saved token requests/,
    );
  });

  it("drops a used-up command silently and says once what it enrolled", () => {
    const op = confirmedRequest();
    const [resolution] = resolveTokenRequests([op], [enrolled], now);
    expect(resolution.kind).toBe("finished");
    expect(resolution.kind === "finished" && plain(resolution.note)).toBe(
      "r16-full install command enrolled r16-full at 5:15 PM.",
    );
  });

  it("drops a revoked or expired command, naming only what it enrolled", () => {
    const op = confirmedRequest();
    for (const token of [
      listed({ revoked: true }),
      listed({ expires_at: at(17, 0) }),
    ]) {
      const [resolution] = resolveTokenRequests([op], [token], now);
      expect(resolution).toMatchObject({ kind: "finished", note: null });
    }
    const [revokedAfterUse] = resolveTokenRequests(
      [op],
      [{ ...enrolled, revoked: true, max_uses: 3 }],
      now,
    );
    expect(
      revokedAfterUse.kind === "finished" && plain(revokedAfterUse.note),
    ).toBe("r16-full install command enrolled r16-full at 5:15 PM.");
  });

  it("counts a partly used token as done with and names what it enrolled", () => {
    const op = confirmedRequest();
    const [resolution] = resolveTokenRequests(
      [op],
      [
        listed({
          name: "Lab install command",
          max_uses: 5,
          uses: 4,
          device_count: 4,
          devices: [
            { name: "lab-4", enrolled_at: at(9, 5, 28) },
            { name: "lab-3", enrolled_at: at(9, 4, 28) },
            { name: "lab-2", enrolled_at: at(9, 3, 28) },
          ],
        }),
      ],
      now,
    );
    expect(resolution.kind === "finished" && plain(resolution.note)).toBe(
      "Lab install command enrolled lab-2, lab-3, lab-4 and 1 more on Sep 28 at 9:05 AM.",
    );
  });

  it("folds an unused live command into the unused line", () => {
    const op = confirmedRequest();
    expect(resolveTokenRequests([op], [listed()], now)).toEqual([
      { kind: "unused", operation: op, token: listed() },
    ]);
  });

  it("keeps the record while the token list is loading, failed or lacks the token", () => {
    const op = confirmedRequest();
    expect(resolveTokenRequests([op], null, now)).toEqual([
      { kind: "unresolved", operation: op },
    ]);
    expect(resolveTokenRequests([op], [], now)).toEqual([
      { kind: "unresolved", operation: op },
    ]);
    expect(readTokenRequests(actor).operations).toEqual([op]);
  });

  it("leaves an unconfirmed request to its exact status check", () => {
    const op = beginTokenRequest(actor, input);
    expect(resolveTokenRequests([op], [enrolled], now)).toEqual([
      { kind: "unconfirmed", operation: op },
    ]);
  });

  it("reads an exact status: unknown, live, or finished when cancelled, used, revoked or expired", () => {
    const status = (patch: object | null, state = "created") => ({
      request_id: actor,
      request_correlation: true as const,
      found: true as const,
      state: state as "created" | "cancelled",
      record: patch && { ...record(), expires_at: at(18, 0), ...patch },
    });
    expect(
      statusOutcome(
        { request_id: actor, request_correlation: true, found: false },
        now,
      ),
    ).toBe("unknown");
    expect(statusOutcome(status({}), now)).toBe("live");
    expect(statusOutcome(status({ uses: 3 }), now)).toBe("finished");
    expect(statusOutcome(status({ uses: 1 }), now)).toBe("finished");
    expect(statusOutcome(status({ revoked: true }), now)).toBe("finished");
    expect(statusOutcome(status({ expires_at: at(17, 0) }), now)).toBe(
      "finished",
    );
    expect(statusOutcome(status(null, "cancelled"), now)).toBe("finished");
  });

  it("says how many devices a receipt enrolled when it can't name them", () => {
    expect(
      plain(
        enrollmentNote(
          listed({ uses: 2, max_uses: null, devices: undefined }),
          now,
        ),
      ),
    ).toBe("r16-full install command enrolled 2 devices.");
    expect(
      plain(
        enrollmentNote(
          listed({ uses: 1, devices: undefined, last_used_at: at(17, 15) }),
          now,
        ),
      ),
    ).toBe("r16-full install command enrolled a device at 5:15 PM.");
    expect(enrollmentNote(listed(), now)).toBeNull();
  });
});
