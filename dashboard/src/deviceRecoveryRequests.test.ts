import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceRecoveryCreateResultSchema,
  DeviceRecoveryRecordSchema,
  DeviceRecoveryRequestStatusSchema,
  beginDeviceRecoveryRequest,
  checkDeviceRecoveryCreation,
  checkDeviceRecoveryStatus,
  deviceRecoveryRequestAvailable,
  dismissDeviceRecoveryRequestIssue,
  finishDeviceRecoveryRequest,
  readDeviceRecoveryRequests,
  subscribeDeviceRecoveryRequests,
  type DeviceRecoveryRequestOperation,
} from "./deviceRecoveryRequests";

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
const otherActor = "521ace4d-0d16-4aac-89c6-cd9912a17763";
const device = "8a76769e-c4cc-4ed1-83c0-1338c04d87a1";
const otherDevice = "d435af26-63bd-423a-a4e9-75b1e49386ba";
const expectedName = "edge-01";
const key = (
  operation: Pick<
    DeviceRecoveryRequestOperation,
    "actor_id" | "device_id" | "id"
  >,
) =>
  `vectory:device-recovery-request:${encodeURIComponent(operation.actor_id)}:${operation.device_id.toLowerCase()}:${operation.id}`;
const fixture = (
  id = crypto.randomUUID(),
  who = actor,
  source = device,
): DeviceRecoveryRequestOperation => ({
  actor_id: who,
  device_id: source,
  id,
  recorded_at: "2026-09-01T00:00:00.000Z",
  request: { request_id: id, expected_name: expectedName },
});
const record = (source = device, name = expectedName) => ({
  id: otherActor,
  name: `Recovery for ${name}`,
  expires_at: "2026-09-27T01:00:00Z",
  uses: 0,
  max_uses: 1 as const,
  name_prefix: null,
  revoked: false,
  created_at: "2026-09-27T00:00:00Z",
  recovery_device_id: source,
  recovery_name: name,
});
const found = (id: string, source = device) => ({
  request_id: id,
  device_id: source,
  request_correlation: true as const,
  found: true as const,
  state: "created" as const,
  record: record(source),
});
const receipt = (id: string, source = device) => ({
  request_id: id,
  device_id: source,
  request_correlation: true as const,
  token: "synthetic-recovery-secret",
  record: record(source),
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

describe("device-bound recovery request registry", () => {
  it("persists frozen source and reviewed name before a send, and reloads without a secret", async () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(op.request).toEqual({
      request_id: op.id,
      expected_name: expectedName,
    });
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(op.request)).toBe(true);
    expect(JSON.parse(storage.getItem(key(op))!)).toEqual(op);
    checkDeviceRecoveryCreation(op, receipt(op.id));
    expect(storage.getItem(key(op))).not.toContain("synthetic-recovery-secret");
    vi.resetModules();
    const reloaded = await import("./deviceRecoveryRequests");
    const recovered = reloaded.readDeviceRecoveryRequests(actor, device)
      .operations[0];
    expect(recovered).toEqual(op);
    expect(reloaded.deviceRecoveryRequestAvailable(recovered)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks fresh authorization only for the same actor and device", () => {
    const original = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, "new-review"),
    ).toThrow(/saved recovery requests/);
    const differentDevice = beginDeviceRecoveryRequest(
      actor,
      otherDevice,
      "edge-02",
    );
    const differentActor = beginDeviceRecoveryRequest(
      otherActor,
      device,
      expectedName,
    );
    expect(readDeviceRecoveryRequests(actor, device).operations).toEqual([
      original,
    ]);
    expect(readDeviceRecoveryRequests(actor, otherDevice).operations).toEqual([
      differentDevice,
    ]);
    expect(readDeviceRecoveryRequests(otherActor, device).operations).toEqual([
      differentActor,
    ]);
  });

  it("normalizes the device UUID without changing the exact reviewed name", () => {
    const op = beginDeviceRecoveryRequest(
      actor,
      device.toUpperCase(),
      "Mixed-Name",
    );
    expect(op.device_id).toBe(device);
    expect(op.request.expected_name).toBe("Mixed-Name");
    expect(
      readDeviceRecoveryRequests(actor, device.toUpperCase()).operations,
    ).toEqual([op]);
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, "Mixed-Name"),
    ).toThrow();
  });

  it("retains old interrupted requests and rejects unreviewed new intent without a TTL", () => {
    const op = fixture();
    op.recorded_at = "2020-01-01T00:00:00.000Z";
    storage.setItem(key(op), JSON.stringify(op));
    expect(readDeviceRecoveryRequests(actor, device).operations).toEqual([op]);
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, expectedName),
    ).toThrow();
    expect(storage.getItem(key(op))).not.toBeNull();
  });

  it("converges peer reads and conditionally removes only the selected request", async () => {
    const first = beginDeviceRecoveryRequest(actor, device, expectedName),
      peer = fixture();
    storage.setItem(key(peer), JSON.stringify(peer));
    vi.resetModules();
    const tab = await import("./deviceRecoveryRequests");
    expect(
      tab
        .readDeviceRecoveryRequests(actor, device)
        .operations.map((op) => op.id)
        .sort(),
    ).toEqual([first.id, peer.id].sort());
    finishDeviceRecoveryRequest(first);
    expect(tab.readDeviceRecoveryRequests(actor, device).operations).toEqual([
      peer,
    ]);
    expect(deviceRecoveryRequestAvailable(first)).toBe(false);
  });

  it.each(["failRead", "failWrite", "ignoreWrite"] as const)(
    "fails closed on %s before any network work",
    (mode) => {
      storage[mode] = true;
      expect(() =>
        beginDeviceRecoveryRequest(actor, device, expectedName),
      ).toThrow(/storage/);
      expect(fetch).not.toHaveBeenCalled();
      storage[mode] = false;
      expect(storage.length).toBe(0);
    },
  );

  it("retains a possibly written request when readback fails", () => {
    storage.afterWrite = () => {
      storage.failRead = true;
    };
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, expectedName),
    ).toThrow(/storage/);
    expect(storage.values.size).toBe(1);
    storage.failRead = false;
    expect(
      readDeviceRecoveryRequests(actor, device).operations[0].request
        .expected_name,
    ).toBe(expectedName);
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, expectedName),
    ).toThrow();
  });

  it("does not overwrite a peer request written during its own persistence", () => {
    const peer = fixture();
    storage.afterWrite = () =>
      storage.values.set(key(peer), JSON.stringify(peer));
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(
      readDeviceRecoveryRequests(actor, device)
        .operations.map((value) => value.id)
        .sort(),
    ).toEqual([peer.id, op.id].sort());
    finishDeviceRecoveryRequest(op);
    expect(storage.getItem(key(peer))).toBe(JSON.stringify(peer));
  });

  it("bounds each device queue, exposes overflow and lets another device proceed", () => {
    for (let index = 0; index < 12; index++) {
      const op = fixture();
      storage.setItem(key(op), JSON.stringify(op));
    }
    const current = readDeviceRecoveryRequests(actor, device);
    expect(current.operations).toHaveLength(10);
    expect(current.errors.map((issue) => issue.kind)).toEqual(["capacity"]);
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, expectedName),
    ).toThrow();
    const other = beginDeviceRecoveryRequest(actor, otherDevice, "edge-02");
    current.operations.forEach(finishDeviceRecoveryRequest);
    expect(readDeviceRecoveryRequests(actor, device).operations).toHaveLength(
      2,
    );
    expect(readDeviceRecoveryRequests(actor, device).errors).toEqual([]);
    expect(deviceRecoveryRequestAvailable(other)).toBe(true);
  });

  it("preserves every record if interleaved writes exceed the bound", () => {
    storage.afterWrite = () => {
      for (let index = 0; index < 10; index++) {
        const peer = fixture();
        storage.values.set(key(peer), JSON.stringify(peer));
      }
    };
    expect(() =>
      beginDeviceRecoveryRequest(actor, device, expectedName),
    ).toThrow(/ten requests/);
    expect(storage.length).toBe(11);
    expect(readDeviceRecoveryRequests(actor, device).errors[0].kind).toBe(
      "capacity",
    );
  });

  it("reports corrupt, oversized and mismatched records with only trustworthy key identities", () => {
    const op = fixture();
    for (const raw of [
      "{broken",
      "x".repeat(8193),
      JSON.stringify({ ...op, actor_id: otherActor }),
      JSON.stringify({ ...op, device_id: otherDevice }),
      JSON.stringify(fixture(otherActor)),
      JSON.stringify({
        ...op,
        request: { ...op.request, request_id: otherActor },
      }),
      JSON.stringify({ ...op, token: "sensitive-unexpected-value" }),
      JSON.stringify({
        ...op,
        request: { ...op.request, token: "sensitive-unexpected-value" },
      }),
    ]) {
      storage.clear();
      storage.setItem(key(op), raw);
      const current = readDeviceRecoveryRequests(actor, device);
      expect(current.operations).toEqual([]);
      expect(current.errors).toHaveLength(1);
      expect(current.errors[0]).toMatchObject({
        actor_id: actor,
        device_id: device,
        id: op.id,
        kind: "corrupt",
      });
      expect(Object.keys(current.errors[0]).sort()).toEqual([
        "actor_id",
        "device_id",
        "id",
        "kind",
        "message",
      ]);
      expect(JSON.stringify(current.errors)).not.toContain(
        "sensitive-unexpected-value",
      );
      expect(() =>
        beginDeviceRecoveryRequest(actor, device, expectedName),
      ).toThrow();
      expect(storage.getItem(key(op))).toBe(raw);
    }
  });

  it("never derives a request ID from an unreadable body when the suffix is invalid", () => {
    const op = fixture();
    storage.setItem(key(op) + "-invalid", JSON.stringify(op));
    const issue = readDeviceRecoveryRequests(actor, device).errors[0];
    expect(issue.id).toBeUndefined();
    expect(issue.device_id).toBe(device);
    expect(readDeviceRecoveryRequests(actor, otherDevice)).toEqual({
      operations: [],
      errors: [],
    });
    expect(readDeviceRecoveryRequests(otherActor, device)).toEqual({
      operations: [],
      errors: [],
    });
  });

  it("keeps a known valid request usable beside an unrelated damaged reminder", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName),
      broken = fixture();
    storage.setItem(key(broken), "broken");
    expect(readDeviceRecoveryRequests(actor, device).errors).toHaveLength(1);
    expect(deviceRecoveryRequestAvailable(op)).toBe(true);
    finishDeviceRecoveryRequest(op);
    expect(storage.getItem(key(broken))).toBe("broken");
  });

  it("fails closed while storage becomes unavailable and recovers without losing intent", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    storage.failRead = true;
    expect(readDeviceRecoveryRequests(actor, device).errors[0].kind).toBe(
      "unavailable",
    );
    expect(deviceRecoveryRequestAvailable(op)).toBe(false);
    expect(() => finishDeviceRecoveryRequest(op)).toThrow();
    storage.failRead = false;
    expect(deviceRecoveryRequestAvailable(op)).toBe(true);
  });

  it("refuses byte changes, source changes and reviewed-name changes during cleanup", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    for (const raw of [
      JSON.stringify(op, null, 2),
      JSON.stringify({ ...op, device_id: otherDevice }),
      JSON.stringify({
        ...op,
        request: { ...op.request, expected_name: "Changed" },
      }),
    ]) {
      storage.setItem(key(op), raw);
      expect(deviceRecoveryRequestAvailable(op)).toBe(false);
      expect(() => finishDeviceRecoveryRequest(op)).toThrow(/reminder/);
      expect(storage.getItem(key(op))).toBe(raw);
    }
  });

  it.each(["failRemove", "ignoreRemove"] as const)(
    "retains a confirmed receipt and reminder when cleanup has %s",
    (mode) => {
      const op = beginDeviceRecoveryRequest(actor, device, expectedName);
      const confirmed = checkDeviceRecoveryCreation(op, receipt(op.id));
      storage[mode] = true;
      expect(() => finishDeviceRecoveryRequest(op)).toThrow(/reminder/);
      expect(confirmed).toEqual(receipt(op.id));
      expect(deviceRecoveryRequestAvailable(op)).toBe(true);
      storage[mode] = false;
      finishDeviceRecoveryRequest(op);
      finishDeviceRecoveryRequest(op);
      expect(storage.length).toBe(0);
    },
  );

  it("detects replacement after removal and never reports that peer bytes were cleaned", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    const raw = JSON.stringify({
      ...op,
      request: { ...op.request, expected_name: "Peer repair" },
    });
    storage.afterRemove = () => storage.values.set(key(op), raw);
    expect(() => finishDeviceRecoveryRequest(op)).toThrow(/reminder/);
    expect(storage.getItem(key(op))).toBe(raw);
  });

  it("requires original opaque snapshots and preserves a peer repair after corrupt review", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(deviceRecoveryRequestAvailable(structuredClone(op))).toBe(false);
    expect(() => finishDeviceRecoveryRequest(structuredClone(op))).toThrow();
    storage.setItem(key(op), "broken");
    const issue = readDeviceRecoveryRequests(actor, device).errors[0];
    expect(() => dismissDeviceRecoveryRequestIssue({ ...issue })).toThrow(
      /Refresh/,
    );
    storage.setItem(key(op), JSON.stringify(op));
    expect(() => dismissDeviceRecoveryRequestIssue(issue)).toThrow(/reminder/);
    storage.setItem(key(op), "still broken");
    dismissDeviceRecoveryRequestIssue(
      readDeviceRecoveryRequests(actor, device).errors[0],
    );
    expect(storage.length).toBe(0);
  });

  it("validates actor, source UUID and reviewed UTF-8 name before retaining intent", () => {
    for (const [who, source, name] of [
      ["", device, expectedName],
      ["\ud800", device, expectedName],
      [actor, "not-a-uuid", expectedName],
      [actor, device, ""],
      [actor, device, " "],
      [actor, device, "bad\0name"],
      [actor, device, "🚀".repeat(26)],
    ])
      expect(() => beginDeviceRecoveryRequest(who, source, name)).toThrow();
    expect(readDeviceRecoveryRequests("\ud800", device).errors[0].kind).toBe(
      "unavailable",
    );
    expect(readDeviceRecoveryRequests(actor, "bad").errors[0].kind).toBe(
      "unavailable",
    );
    expect(storage.length).toBe(0);
    expect(
      beginDeviceRecoveryRequest(actor, device, "🚀".repeat(25)).request
        .expected_name,
    ).toBe("🚀".repeat(25));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes scoped cross-tab events and lifecycle reads and releases every subscription", () => {
    const refresh = vi.fn(),
      stop = subscribeDeviceRecoveryRequests(actor, device, refresh);
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(storageEvent(key({ ...op, actor_id: otherActor })));
    events.dispatchEvent(storageEvent(key({ ...op, device_id: otherDevice })));
    expect(refresh).toHaveBeenCalledTimes(1);
    events.dispatchEvent(storageEvent(key(op)));
    events.dispatchEvent(storageEvent(null));
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("pageshow"));
    expect(refresh).toHaveBeenCalledTimes(5);
    stop();
    finishDeviceRecoveryRequest(op);
    events.dispatchEvent(storageEvent(null));
    expect(refresh).toHaveBeenCalledTimes(5);
  });
});

describe("strict device recovery receipts and statuses", () => {
  it("accepts initial secret, secret-free replay, and cancelled-before-create tombstone", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(checkDeviceRecoveryCreation(op, receipt(op.id))).toEqual(
      receipt(op.id),
    );
    expect(checkDeviceRecoveryCreation(op, found(op.id))).toEqual(found(op.id));
    const cancelled = { ...found(op.id), state: "cancelled", record: null };
    expect(checkDeviceRecoveryCreation(op, cancelled)).toEqual(cancelled);
    expect(checkDeviceRecoveryStatus(op.id, device, cancelled, op)).toEqual(
      cancelled,
    );
    expect(storage.length).toBe(1);
  });

  it("correlates both request and source UUID even on negative lookup", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    const absent = {
      request_id: op.id,
      request_correlation: true,
      device_id: device,
      found: false,
    };
    expect(
      checkDeviceRecoveryStatus(
        op.id.toUpperCase(),
        device.toUpperCase(),
        absent,
        op,
      ),
    ).toEqual(absent);
    for (const wrong of [
      { ...absent, request_id: otherActor },
      { ...absent, device_id: otherDevice },
    ])
      expect(() => checkDeviceRecoveryStatus(op.id, device, wrong, op)).toThrow(
        /different/,
      );
    expect(() =>
      checkDeviceRecoveryStatus(op.id, device, absent, fixture()),
    ).toThrow();
    expect(() =>
      checkDeviceRecoveryCreation(op, receipt(op.id, otherDevice)),
    ).toThrow(/different/);
    expect(() => checkDeviceRecoveryCreation(op, receipt(otherActor))).toThrow(
      /different/,
    );
  });

  it("rejects inner source mismatch and another original name while preserving current used/revoked state", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    expect(() =>
      checkDeviceRecoveryCreation(op, {
        ...receipt(op.id),
        record: record(otherDevice),
      }),
    ).toThrow();
    expect(() =>
      checkDeviceRecoveryStatus(
        op.id,
        device,
        { ...found(op.id), record: record(device, "different-name") },
        op,
      ),
    ).toThrow(/reviewed device/);
    const used = {
      ...found(op.id),
      record: { ...record(), uses: 1, revoked: true },
    };
    expect(checkDeviceRecoveryStatus(op.id, device, used, op)).toEqual(used);
    expect(
      checkDeviceRecoveryStatus(
        op.id,
        device,
        { ...used, state: "cancelled" },
        op,
      ).found,
    ).toBe(true);
  });

  it("supports key-only damaged recovery without guessing the original reviewed name", () => {
    const status = { ...found(actor), record: record(device, "original-name") };
    expect(checkDeviceRecoveryStatus(actor, device, status)).toEqual(status);
    expect(() => checkDeviceRecoveryStatus(actor, otherDevice, status)).toThrow(
      /different/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the original record valid after the live device name or assignments have changed", () => {
    const op = beginDeviceRecoveryRequest(actor, device, expectedName);
    const currentSource = {
      id: device,
      name: `${expectedName}#retired-${device}`,
      desired_generation: 12,
    };
    expect(currentSource.name).not.toBe(op.request.expected_name);
    expect(
      checkDeviceRecoveryStatus(op.id, currentSource.id, found(op.id), op),
    ).toEqual(found(op.id));
    expect(op.request).toEqual({
      request_id: op.id,
      expected_name: expectedName,
    });
  });

  it("rejects unsupported, contradictory, oversized and secret-bearing status responses", () => {
    for (const invalid of [
      { found: false },
      { request_id: actor, found: false },
      {
        request_id: actor,
        device_id: device,
        request_correlation: false,
        found: false,
      },
      { ...found(actor), record: null },
      { ...found(actor), state: "cancelled" },
      { ...found(actor), token: "must-not-be-replayed" },
      { ...found(actor), state: "unknown" },
      {
        request_id: actor,
        request_correlation: true,
        device_id: device,
        found: false,
        record: record(),
      },
    ])
      expect(DeviceRecoveryRequestStatusSchema.safeParse(invalid).success).toBe(
        false,
      );
    expect(
      DeviceRecoveryCreateResultSchema.safeParse({
        request_id: actor,
        device_id: device,
        request_correlation: true,
        found: false,
      }).success,
    ).toBe(false);
    for (const patch of [
      { token: "" },
      { token: "x".repeat(513) },
      { record: { ...record(), uses: 1 } },
      { record: { ...record(), revoked: true } },
    ])
      expect(
        DeviceRecoveryCreateResultSchema.safeParse({
          ...receipt(actor),
          ...patch,
        }).success,
      ).toBe(false);
  });

  it("requires the full recovery-only record and its fixed authorization constraints", () => {
    for (const patch of [
      { recovery_device_id: undefined },
      { recovery_name: undefined },
      { recovery_name: "different" },
      { max_uses: null },
      { max_uses: 2 },
      { name_prefix: "edge-" },
      { name_prefix: undefined },
      { uses: -1 },
      { uses: 2 },
      { expires_at: "later" },
      { revoked: "false" },
      { id: "invalid" },
      { unknown: true },
      { recovery_name: "🚀".repeat(26) },
    ])
      expect(
        DeviceRecoveryRecordSchema.safeParse({ ...record(), ...patch }).success,
      ).toBe(false);
    expect(
      DeviceRecoveryRecordSchema.safeParse(record(device, "🚀".repeat(25)))
        .success,
    ).toBe(true);
  });
});
