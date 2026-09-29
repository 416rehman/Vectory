import { useEffect, useState } from "react";
import { z } from "zod";

const uuid = z.string().uuid();
const sameDevice = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
const actorSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  });
const displayName = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !!value.trim() && !value.includes("\0") && [...value].length <= 240,
  );
const identity = { device_id: uuid, revocation_status: z.literal(true) };
export const DeviceRevocationStatusSchema = z
  .object({ ...identity, revoked: z.boolean() })
  .strict();
export const DeviceRevocationReceiptSchema = z
  .object({ ...identity, revoked: z.literal(true), ok: z.literal(true) })
  .strict();
export type DeviceRevocationStatus = z.infer<
  typeof DeviceRevocationStatusSchema
>;
export type DeviceRevocationReceipt = z.infer<
  typeof DeviceRevocationReceiptSchema
>;

function checkDevice(deviceId: string, result: { device_id: string }) {
  if (
    !uuid.safeParse(deviceId).success ||
    !sameDevice(deviceId, result.device_id)
  )
    throw Error(
      "The response identifies a different device. Keep the reminder and check current access status again.",
    );
}
export function checkDeviceRevocationStatus(
  deviceId: string,
  value: unknown,
): DeviceRevocationStatus {
  const result = DeviceRevocationStatusSchema.parse(value);
  checkDevice(deviceId, result);
  return result;
}
export function checkDeviceRevocationReceipt(
  deviceId: string,
  value: unknown,
): DeviceRevocationReceipt {
  const result = DeviceRevocationReceiptSchema.parse(value);
  checkDevice(deviceId, result);
  return result;
}

const intentSchema = z
  .object({
    actor_id: actorSchema,
    device_id: uuid,
    id: uuid,
    name: displayName,
    recorded_at: z.string().datetime(),
  })
  .strict()
  .refine((value) => value.device_id === value.device_id.toLowerCase());
export type DeviceRevocationIntent = z.infer<typeof intentSchema>;
export type DeviceRevocationIssue = {
  actor_id: string;
  device_id: string;
  kind: "corrupt" | "unavailable";
  message: string;
};
export type DeviceRevocationRegistry = {
  intent: DeviceRevocationIntent | null;
  issue: DeviceRevocationIssue | null;
};

const prefix = "vectory:device-revocation:";
const eventName = "vectory:device-revocation-intents";
const maxBytes = 8192;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const keyFor = (actor: string, device: string) =>
  `${prefix}${encodeURIComponent(actor)}:${device.toLowerCase()}`;
type Snapshot = { key: string; raw: string };
const snapshots = new WeakMap<
  DeviceRevocationIntent | DeviceRevocationIssue,
  Snapshot
>();
const cache = new Map<
  string,
  { raw: string; intent: DeviceRevocationIntent }
>();
const storageError =
  "Browser storage is unavailable. Restore it before revoking access so an interrupted request can be reviewed after closing this page.";
const cleanupError =
  "This browser reminder could not be cleared. Check current access status before trying to clear it again.";
const changed = () => window.dispatchEvent(new Event(eventName));

function parse(key: string, raw: string, actor: string, device: string) {
  if (raw.length > maxBytes || bytes(raw) > maxBytes) return null;
  const prior = cache.get(key);
  if (prior?.raw === raw) return prior.intent;
  try {
    const value = intentSchema.safeParse(JSON.parse(raw));
    if (
      !value.success ||
      value.data.actor_id !== actor ||
      value.data.device_id !== device.toLowerCase()
    )
      return null;
    const intent = Object.freeze(value.data);
    snapshots.set(intent, { key, raw });
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, { raw, intent });
    return intent;
  } catch {
    return null;
  }
}

export function readDeviceRevocationIntent(
  actorId: string,
  deviceId: string,
): DeviceRevocationRegistry {
  const context = {
    actor_id: actorId,
    device_id: deviceId.toLowerCase(),
  };
  if (
    !actorSchema.safeParse(actorId).success ||
    !uuid.safeParse(deviceId).success
  )
    return {
      intent: null,
      issue: {
        ...context,
        kind: "unavailable",
        message: "Sign in and reopen this device before reviewing its access.",
      },
    };
  try {
    const key = keyFor(actorId, deviceId),
      raw = localStorage.getItem(key);
    if (raw === null) return { intent: null, issue: null };
    const intent = parse(key, raw, actorId, deviceId);
    if (intent) return { intent, issue: null };
    // Only the caller's exact actor/device storage key supplies this scope.
    // Corrupt contents never supply a device, request body or display name.
    const issue: DeviceRevocationIssue = Object.freeze({
      ...context,
      kind: "corrupt",
      message:
        "A saved access-revocation reminder cannot be read. Check this device's current access status before confirming another action.",
    });
    snapshots.set(issue, { key, raw });
    return { intent: null, issue };
  } catch {
    return {
      intent: null,
      issue: { ...context, kind: "unavailable", message: storageError },
    };
  }
}

/** Persist before POST; callers must separately read exact status and confirm. */
export function beginDeviceRevocation(
  actorId: string,
  deviceId: string,
  name: string,
): DeviceRevocationIntent {
  if (
    !actorSchema.safeParse(actorId).success ||
    !uuid.safeParse(deviceId).success ||
    !displayName.safeParse(name).success
  )
    throw Error("Sign in and review the device before revoking access.");
  const saved = readDeviceRevocationIntent(actorId, deviceId);
  if (saved.issue) throw Error(saved.issue.message);
  if (saved.intent)
    throw Error("Check the saved access-revocation request before continuing.");
  const device = deviceId.toLowerCase();
  const intent = intentSchema.parse({
    actor_id: actorId,
    device_id: device,
    id: crypto.randomUUID(),
    name,
    recorded_at: new Date().toISOString(),
  });
  const raw = JSON.stringify(intent),
    key = keyFor(actorId, device);
  if (bytes(raw) > maxBytes) throw Error(storageError);
  try {
    if (localStorage.getItem(key) !== null) throw Error(storageError);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw Error(storageError);
  } catch {
    // A write may have completed before an exception. Keep any surviving bytes.
    changed();
    throw Error(storageError);
  }
  changed();
  return parse(key, raw, actorId, device)!;
}

/** A corrupt, exact-scope reminder can fence an explicitly reconfirmed POST. */
export function deviceRevocationIntentAvailable(
  handle: DeviceRevocationIntent | DeviceRevocationIssue,
) {
  const snapshot = snapshots.get(handle);
  if (!snapshot) return false;
  try {
    return localStorage.getItem(snapshot.key) === snapshot.raw;
  } catch {
    return false;
  }
}

function clearExact(handle: DeviceRevocationIntent | DeviceRevocationIssue) {
  const snapshot = snapshots.get(handle);
  if (!snapshot) throw Error(cleanupError);
  try {
    const raw = localStorage.getItem(snapshot.key);
    if (raw !== null && raw !== snapshot.raw) throw Error(cleanupError);
    if (raw !== null) localStorage.removeItem(snapshot.key);
    if (localStorage.getItem(snapshot.key) !== null) throw Error(cleanupError);
  } catch {
    changed();
    throw Error(cleanupError);
  }
  changed();
}
/** Clear only after an exact receipt/status confirms revoked=true. */
export function finishDeviceRevocation(intent: DeviceRevocationIntent) {
  clearExact(intent);
}
/** Clear only after exact current status confirms this scoped device revoked. */
export function clearDeviceRevocationIssue(issue: DeviceRevocationIssue) {
  clearExact(issue);
}

export function subscribeDeviceRevocationIntent(
  actorId: string,
  deviceId: string,
  refresh: () => void,
) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === keyFor(actorId, deviceId))
      refresh();
  };
  window.addEventListener(eventName, refresh);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  return () => {
    window.removeEventListener(eventName, refresh);
    window.removeEventListener("storage", storage);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("pageshow", refresh);
  };
}
export function useDeviceRevocationIntent(actorId: string, deviceId: string) {
  const [, refresh] = useState(0);
  useEffect(
    () =>
      subscribeDeviceRevocationIntent(actorId, deviceId, () =>
        refresh((value) => value + 1),
      ),
    [actorId, deviceId],
  );
  return readDeviceRevocationIntent(actorId, deviceId);
}
