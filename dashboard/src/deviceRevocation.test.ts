import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceRevocationReceiptSchema,
  DeviceRevocationStatusSchema,
  beginDeviceRevocation,
  checkDeviceRevocationReceipt,
  checkDeviceRevocationStatus,
  clearDeviceRevocationIssue,
  deviceRevocationIntentAvailable,
  finishDeviceRevocation,
  readDeviceRevocationIntent,
  subscribeDeviceRevocationIntent,
  type DeviceRevocationIntent,
} from "./deviceRevocation";

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
const key = (who = actor, source = device) =>
  `vectory:device-revocation:${encodeURIComponent(who)}:${source.toLowerCase()}`;
const fixture = (who = actor, source = device): DeviceRevocationIntent => ({
  actor_id: who,
  device_id: source,
  id: crypto.randomUUID(),
  name: "edge-01",
  recorded_at: "2026-09-01T00:00:00.000Z",
});
const status = (revoked = false, source = device) => ({
  device_id: source,
  revocation_status: true as const,
  revoked,
});
const receipt = (source = device) => ({
  ...status(true, source),
  revoked: true as const,
  ok: true as const,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Registry must not send requests");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("device access intent", () => {
  it("persists one exact nonsecret device scope before returning, without any network", () => {
    const intent = beginDeviceRevocation(
      actor,
      device.toUpperCase(),
      "edge-01",
    );
    expect(intent.device_id).toBe(device);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(JSON.parse(storage.getItem(key())!)).toEqual(intent);
    expect(Object.keys(intent).sort()).toEqual([
      "actor_id",
      "device_id",
      "id",
      "name",
      "recorded_at",
    ]);
    expect(readDeviceRevocationIntent(actor, device).intent).toBe(intent);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reloads old intent without TTL or inventing an outcome", () => {
    const original = fixture();
    original.recorded_at = "2000-01-01T00:00:00.000Z";
    storage.values.set(key(), JSON.stringify(original));
    const loaded = readDeviceRevocationIntent(actor, device);
    expect(loaded.intent).toEqual(original);
    expect(loaded.issue).toBeNull();
    expect(deviceRevocationIntentAvailable(loaded.intent!)).toBe(true);
  });
  it("keeps actors and devices independent, including encoded actor delimiters", () => {
    const a = beginDeviceRevocation(actor, device, "one");
    const b = beginDeviceRevocation(actor, otherDevice, "two");
    const c = beginDeviceRevocation(otherActor, device, "three");
    const d = beginDeviceRevocation("actor:with/slash", device, "four");
    expect(storage.length).toBe(4);
    expect(readDeviceRevocationIntent(actor, device).intent).toBe(a);
    expect(readDeviceRevocationIntent(actor, otherDevice).intent).toBe(b);
    expect(readDeviceRevocationIntent(otherActor, device).intent).toBe(c);
    expect(readDeviceRevocationIntent("actor:with/slash", device).intent).toBe(
      d,
    );
  });
  it("refuses fresh begin over an unresolved intent without replacing its bytes", () => {
    beginDeviceRevocation(actor, device, "one");
    const raw = storage.getItem(key());
    expect(() => beginDeviceRevocation(actor, device, "two")).toThrow(/saved/);
    expect(storage.getItem(key())).toBe(raw);
  });
  it("sees peer storage bytes rather than treating the cached object as authority", () => {
    const first = beginDeviceRevocation(actor, device, "one");
    const peer = fixture();
    peer.name = "peer";
    storage.values.set(key(), JSON.stringify(peer));
    const second = readDeviceRevocationIntent(actor, device).intent!;
    expect(second).toEqual(peer);
    expect(deviceRevocationIntentAvailable(first)).toBe(false);
    expect(deviceRevocationIntentAvailable(second)).toBe(true);
    expect(() => finishDeviceRevocation(first)).toThrow();
    expect(storage.getItem(key())).toBe(JSON.stringify(peer));
  });
  it("does not expose corrupt contents or derive scope from them", () => {
    const raw = JSON.stringify({
      device_id: otherDevice,
      actor_id: otherActor,
      token: "not-for-display",
    });
    storage.values.set(key(), raw);
    const { intent, issue } = readDeviceRevocationIntent(actor, device);
    expect(intent).toBeNull();
    expect(issue).toMatchObject({
      actor_id: actor,
      device_id: device,
      kind: "corrupt",
    });
    expect(JSON.stringify(issue)).not.toContain("not-for-display");
    expect(JSON.stringify(issue)).not.toContain(otherDevice);
    expect(deviceRevocationIntentAvailable(issue!)).toBe(true);
    expect(() => beginDeviceRevocation(actor, device, "new")).toThrow();
    expect(storage.getItem(key())).toBe(raw);
  });
  it("rejects malformed, oversize, foreign, secret-bearing and incomplete persisted records", () => {
    const original = fixture();
    const invalid = [
      "{",
      "x".repeat(8193),
      JSON.stringify({ ...original, name: "é".repeat(4100) }),
      JSON.stringify({ ...original, actor_id: otherActor }),
      JSON.stringify({ ...original, device_id: otherDevice }),
      JSON.stringify({ ...original, token: "hidden" }),
      JSON.stringify({ ...original, recorded_at: null }),
      JSON.stringify({ ...original, id: "invalid" }),
      JSON.stringify({ ...original, name: "\0" }),
      "null",
    ];
    for (const raw of invalid) {
      storage.values.set(key(), raw);
      expect(readDeviceRevocationIntent(actor, device)).toMatchObject({
        intent: null,
        issue: { kind: "corrupt" },
      });
      expect(storage.getItem(key())).toBe(raw);
    }
  });
  it("validates actor, UUID and bounded display text before persistence", () => {
    for (const args of [
      ["", device, "a"],
      ["\ud800", device, "a"],
      [actor, "bad", "a"],
      [actor, device, " "],
      [actor, device, "x\0"],
      [actor, device, "x".repeat(241)],
    ]) {
      expect(() => beginDeviceRevocation(args[0], args[1], args[2])).toThrow();
    }
    expect(storage.length).toBe(0);
    const valid = beginDeviceRevocation(actor, device, "é".repeat(240));
    expect(valid.name).toBe("é".repeat(240));
  });
  it("returns unavailable for invalid read context without accessing unrelated storage", () => {
    beginDeviceRevocation(actor, device, "one");
    expect(readDeviceRevocationIntent("", device).issue?.kind).toBe(
      "unavailable",
    );
    expect(readDeviceRevocationIntent(actor, "not-a-device").intent).toBeNull();
    expect(storage.length).toBe(1);
  });
  it("fails closed on read errors and permits recovery after storage is restored", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    storage.failRead = true;
    const issue = readDeviceRevocationIntent(actor, device).issue!;
    expect(issue.kind).toBe("unavailable");
    expect(deviceRevocationIntentAvailable(issue)).toBe(false);
    expect(deviceRevocationIntentAvailable(intent)).toBe(false);
    expect(() => clearDeviceRevocationIssue(issue)).toThrow();
    expect(() => beginDeviceRevocation(actor, otherDevice, "two")).toThrow();
    storage.failRead = false;
    expect(readDeviceRevocationIntent(actor, device).intent).toBe(intent);
  });
  it("refuses quota and silently ignored writes before returning authority", () => {
    storage.failWrite = true;
    expect(() => beginDeviceRevocation(actor, device, "one")).toThrow();
    storage.failWrite = false;
    storage.ignoreWrite = true;
    expect(() => beginDeviceRevocation(actor, device, "one")).toThrow();
    expect(storage.length).toBe(0);
  });
  it("retains any successfully written reminder when post-write verification fails", () => {
    storage.afterWrite = () => {
      storage.failRead = true;
    };
    expect(() => beginDeviceRevocation(actor, device, "one")).toThrow();
    expect(storage.length).toBe(1);
    storage.failRead = false;
    expect(readDeviceRevocationIntent(actor, device).intent?.name).toBe("one");
  });
  it("does not erase a peer replacement observed during write readback", () => {
    const peer = JSON.stringify(fixture());
    storage.afterWrite = () => storage.values.set(key(), peer);
    expect(() => beginDeviceRevocation(actor, device, "one")).toThrow();
    expect(storage.getItem(key())).toBe(peer);
  });
  it("cleans only the captured exact bytes and leaves other scopes untouched", () => {
    const one = beginDeviceRevocation(actor, device, "one");
    const two = beginDeviceRevocation(actor, otherDevice, "two");
    finishDeviceRevocation(one);
    expect(readDeviceRevocationIntent(actor, device)).toEqual({
      intent: null,
      issue: null,
    });
    expect(deviceRevocationIntentAvailable(two)).toBe(true);
    expect(() => finishDeviceRevocation(one)).not.toThrow();
  });
  it("requires opaque read snapshots for cleanup and pre-send availability", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    expect(deviceRevocationIntentAvailable({ ...intent })).toBe(false);
    expect(() => finishDeviceRevocation({ ...intent })).toThrow();
    expect(storage.length).toBe(1);
  });
  it("refuses same semantic content rewritten with different bytes", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    const pretty = JSON.stringify(intent, null, 2);
    storage.values.set(key(), pretty);
    expect(deviceRevocationIntentAvailable(intent)).toBe(false);
    expect(() => finishDeviceRevocation(intent)).toThrow();
    expect(storage.getItem(key())).toBe(pretty);
  });
  it("retains confirmed intent when cleanup throws or is silently ignored", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    storage.failRemove = true;
    expect(() => finishDeviceRevocation(intent)).toThrow();
    storage.failRemove = false;
    storage.ignoreRemove = true;
    expect(() => finishDeviceRevocation(intent)).toThrow();
    expect(deviceRevocationIntentAvailable(intent)).toBe(true);
  });
  it("does not delete a repair that appears after a removal", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    const repaired = JSON.stringify(fixture());
    storage.afterRemove = () => storage.values.set(key(), repaired);
    expect(() => finishDeviceRevocation(intent)).toThrow();
    expect(storage.getItem(key())).toBe(repaired);
  });
  it("keeps a corrupt exact-scope handle usable without reconstructing its contents", () => {
    storage.values.set(key(), "unreadable original");
    const issue = readDeviceRevocationIntent(actor, device).issue!;
    expect(
      checkDeviceRevocationStatus(issue.device_id, status(false)).revoked,
    ).toBe(false);
    expect(deviceRevocationIntentAvailable(issue)).toBe(true);
    expect(storage.getItem(key())).toBe("unreadable original");
    expect(
      checkDeviceRevocationReceipt(issue.device_id, receipt()).revoked,
    ).toBe(true);
    clearDeviceRevocationIssue(issue);
    expect(storage.getItem(key())).toBeNull();
  });
  it("refuses corrupt-reminder cleanup after peer repair or with a forged issue", () => {
    storage.values.set(key(), "bad");
    const issue = readDeviceRevocationIntent(actor, device).issue!;
    expect(() => clearDeviceRevocationIssue({ ...issue })).toThrow();
    const repaired = JSON.stringify(fixture());
    storage.values.set(key(), repaired);
    expect(deviceRevocationIntentAvailable(issue)).toBe(false);
    expect(() => clearDeviceRevocationIssue(issue)).toThrow();
    expect(storage.getItem(key())).toBe(repaired);
  });
  it("preserves missing or replaced reminders rather than granting retry authority", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    storage.values.delete(key());
    expect(deviceRevocationIntentAvailable(intent)).toBe(false);
    expect(() => finishDeviceRevocation(intent)).not.toThrow();
  });
  it("refreshes exact actor/device storage events and removes listeners", () => {
    const refresh = vi.fn();
    const stop = subscribeDeviceRevocationIntent(actor, device, refresh);
    events.dispatchEvent(storageEvent(key(otherActor, device)));
    events.dispatchEvent(storageEvent(key(actor, otherDevice)));
    expect(refresh).not.toHaveBeenCalled();
    events.dispatchEvent(storageEvent(key()));
    events.dispatchEvent(storageEvent(null));
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("pageshow"));
    beginDeviceRevocation(actor, device, "one");
    expect(refresh).toHaveBeenCalledTimes(5);
    stop();
    events.dispatchEvent(storageEvent(key()));
    events.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(5);
  });
});

describe("exact device revocation outcomes", () => {
  it("distinguishes a fresh current unrevoked read from a confirmed terminal receipt", () => {
    expect(checkDeviceRevocationStatus(device, status(false))).toEqual(
      status(false),
    );
    expect(checkDeviceRevocationStatus(device, status(true))).toEqual(
      status(true),
    );
    expect(checkDeviceRevocationReceipt(device, receipt())).toEqual(receipt());
    expect(
      DeviceRevocationReceiptSchema.safeParse({ ...receipt(), revoked: false })
        .success,
    ).toBe(false);
  });
  it("accepts canonical-equivalent UUID casing but rejects another exact device", () => {
    expect(
      checkDeviceRevocationStatus(device.toUpperCase(), status()).device_id,
    ).toBe(device);
    expect(
      checkDeviceRevocationReceipt(device, receipt(device.toUpperCase()))
        .revoked,
    ).toBe(true);
    expect(() => checkDeviceRevocationStatus(otherDevice, status())).toThrow(
      /different device/,
    );
    expect(() => checkDeviceRevocationReceipt(otherDevice, receipt())).toThrow(
      /different device/,
    );
    expect(() => checkDeviceRevocationStatus("invalid", status())).toThrow();
  });
  it("rejects legacy success, missing capability, false markers and generic device summaries", () => {
    for (const value of [
      { ok: true },
      {},
      { device_id: device, revoked: true },
      { ...status(), revocation_status: false },
      { ...status(), status: "revoked" },
      { ...status(), revoked: "true" },
    ]) {
      expect(DeviceRevocationStatusSchema.safeParse(value).success).toBe(false);
      expect(DeviceRevocationReceiptSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
  it("rejects malformed or unrelated receipt metadata instead of accepting arbitrary JSON", () => {
    for (const value of [
      { ...receipt(), device_id: "bad" },
      { ...receipt(), ok: false },
      { ...receipt(), revoked: false },
      { ...receipt(), token: "extra" },
      { ...receipt(), revocation_status: undefined },
      null,
      [],
    ]) {
      expect(() => checkDeviceRevocationReceipt(device, value)).toThrow();
    }
    expect(DeviceRevocationStatusSchema.safeParse(receipt()).success).toBe(
      false,
    );
  });
  it("never consumes a durable reminder merely because parsing a receipt succeeds or fails", () => {
    const intent = beginDeviceRevocation(actor, device, "one");
    expect(() =>
      checkDeviceRevocationReceipt(device, receipt(otherDevice)),
    ).toThrow();
    checkDeviceRevocationReceipt(device, receipt());
    expect(deviceRevocationIntentAvailable(intent)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
