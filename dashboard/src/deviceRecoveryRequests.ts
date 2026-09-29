import { useEffect, useState } from "react";
import { z } from "zod";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const uuid = z.string().uuid();
const sameId = (left: string, right: string) =>
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
const reviewedName = z
  .string()
  .min(1)
  .refine(
    (value) => !!value.trim() && !value.includes("\0") && bytes(value) <= 100,
    "Review the device name before authorizing recovery.",
  );

export const DeviceRecoveryRecordSchema = z
  .object({
    id: uuid,
    name: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0") && bytes(value) <= 120),
    expires_at: z.string().datetime({ offset: true }),
    uses: z.number().int().min(0).max(1),
    max_uses: z.literal(1),
    name_prefix: z.null(),
    revoked: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
    recovery_device_id: uuid,
    recovery_name: reviewedName,
  })
  .strict()
  .refine(
    (value) => value.name === `Recovery for ${value.recovery_name}`,
    "The recovery token name does not match its device.",
  );
const identityFields = {
  request_id: uuid,
  request_correlation: z.literal(true),
  device_id: uuid,
};
const foundStatusSchema = z
  .object({
    ...identityFields,
    found: z.literal(true),
    state: z.enum(["created", "cancelled"]),
    record: DeviceRecoveryRecordSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "created" && value.record === null)
      context.addIssue({
        code: "custom",
        message: "A created request must identify its recovery token.",
      });
    if (
      value.record &&
      !sameId(value.device_id, value.record.recovery_device_id)
    )
      context.addIssue({
        code: "custom",
        message: "The recovery token identifies a different device.",
      });
    if (value.state === "cancelled" && value.record && !value.record.revoked)
      context.addIssue({
        code: "custom",
        message: "A cancelled request cannot retain an active recovery token.",
      });
  });
export const DeviceRecoveryRequestStatusSchema = z.union([
  z.object({ ...identityFields, found: z.literal(false) }).strict(),
  foundStatusSchema,
]);
export const DeviceRecoveryCreateResultSchema = z.union([
  z
    .object({
      ...identityFields,
      token: z.string().min(1).max(512),
      record: DeviceRecoveryRecordSchema.refine(
        (value) => value.uses === 0 && !value.revoked,
        "An initial recovery receipt must identify a newly created token.",
      ),
    })
    .strict()
    .refine(
      (value) => sameId(value.device_id, value.record.recovery_device_id),
      "The recovery token identifies a different device.",
    ),
  foundStatusSchema,
]);

const operationSchema = z
  .object({
    actor_id: actorSchema,
    device_id: uuid,
    id: uuid,
    recorded_at: z.string().datetime(),
    request: z
      .object({ request_id: uuid, expected_name: reviewedName })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.id === value.request.request_id &&
      value.device_id === value.device_id.toLowerCase(),
  );
export type DeviceRecoveryRequestOperation = z.infer<typeof operationSchema>;
export type DeviceRecoveryRequestStatus = z.infer<
  typeof DeviceRecoveryRequestStatusSchema
>;
export type DeviceRecoveryCreateResult = z.infer<
  typeof DeviceRecoveryCreateResultSchema
>;
export type DeviceRecoveryRecord = z.infer<typeof DeviceRecoveryRecordSchema>;
export type DeviceRecoveryRequestIssue = {
  actor_id: string;
  device_id: string;
  id?: string;
  kind: "unavailable" | "corrupt" | "capacity";
  message: string;
};
export type DeviceRecoveryRequestRegistry = {
  operations: DeviceRecoveryRequestOperation[];
  errors: DeviceRecoveryRequestIssue[];
};

function checkRecord(
  operation: DeviceRecoveryRequestOperation,
  record: DeviceRecoveryRecord,
) {
  if (
    !sameId(record.recovery_device_id, operation.device_id) ||
    record.recovery_name !== operation.request.expected_name
  )
    throw Error(
      "The recovery token does not match the reviewed device. Keep this reminder and check its exact status before continuing.",
    );
}
export function checkDeviceRecoveryStatus(
  id: string,
  deviceId: string,
  value: unknown,
  operation?: DeviceRecoveryRequestOperation,
): DeviceRecoveryRequestStatus {
  const result = DeviceRecoveryRequestStatusSchema.parse(value);
  if (
    !uuid.safeParse(id).success ||
    !uuid.safeParse(deviceId).success ||
    !sameId(result.request_id, id) ||
    !sameId(result.device_id, deviceId) ||
    (operation &&
      (!sameId(operation.id, id) || !sameId(operation.device_id, deviceId)))
  )
    throw Error(
      "The response identifies a different recovery request or device. Keep the reminder and check again.",
    );
  if (result.found && result.record && operation)
    checkRecord(operation, result.record);
  return result;
}
export function checkDeviceRecoveryCreation(
  operation: DeviceRecoveryRequestOperation,
  value: unknown,
): DeviceRecoveryCreateResult {
  const result = DeviceRecoveryCreateResultSchema.parse(value);
  if (
    !sameId(result.request_id, operation.id) ||
    !sameId(result.device_id, operation.device_id)
  )
    throw Error(
      "The response identifies a different recovery request or device. Keep the reminder and check again.",
    );
  if (result.record) checkRecord(operation, result.record);
  return result;
}

const storagePrefix = "vectory:device-recovery-request:";
const eventName = "vectory:device-recovery-requests";
const maxRecords = 10;
const maxBytes = 8192;
const scopePrefix = (actor: string, device: string) =>
  `${storagePrefix}${encodeURIComponent(actor)}:${device.toLowerCase()}:`;
const keyFor = (
  operation: Pick<
    DeviceRecoveryRequestOperation,
    "actor_id" | "device_id" | "id"
  >,
) => `${scopePrefix(operation.actor_id, operation.device_id)}${operation.id}`;
type Snapshot = { key: string; raw: string };
const snapshots = new WeakMap<DeviceRecoveryRequestOperation, Snapshot>();
const issues = new WeakMap<DeviceRecoveryRequestIssue, Snapshot>();
const cache = new Map<
  string,
  { raw: string; operation: DeviceRecoveryRequestOperation }
>();
const storageError =
  "Browser storage is unavailable. Enable it before authorizing recovery so an interrupted request can be reviewed after closing this tab.";
const cleanupError =
  "This browser reminder could not be removed. Refresh and check the saved recovery request before dismissing it again.";
const capacityError =
  "Review the saved recovery requests before authorizing another. This browser retains up to ten requests per account and device.";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const changed = () => window.dispatchEvent(new Event(eventName));
function keys(actor: string, device: string) {
  const prefix = scopePrefix(actor, device),
    found: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) found.push(key);
  }
  return found.sort();
}
function parse(
  key: string,
  raw: string,
  actor: string,
  device: string,
  id: string,
) {
  if (raw.length > maxBytes || bytes(raw) > maxBytes) return null;
  const old = cache.get(key);
  if (old?.raw === raw) return old.operation;
  try {
    const result = operationSchema.safeParse(JSON.parse(raw));
    if (
      !result.success ||
      result.data.actor_id !== actor ||
      result.data.device_id !== device.toLowerCase() ||
      result.data.id !== id
    )
      return null;
    const operation = freeze(result.data);
    snapshots.set(operation, { key, raw });
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, { raw, operation });
    return operation;
  } catch {
    return null;
  }
}

export function readDeviceRecoveryRequests(
  actor: string,
  device: string,
): DeviceRecoveryRequestRegistry {
  const result: DeviceRecoveryRequestRegistry = { operations: [], errors: [] };
  const context = { actor_id: actor, device_id: device.toLowerCase() };
  if (
    !actorSchema.safeParse(actor).success ||
    !uuid.safeParse(device).success
  ) {
    result.errors.push({
      ...context,
      kind: "unavailable",
      message:
        "Sign in and reopen the device before reviewing recovery requests.",
    });
    return result;
  }
  try {
    const records = keys(actor, device),
      prefix = scopePrefix(actor, device);
    for (const key of records.slice(0, maxRecords)) {
      const id = key.slice(prefix.length),
        raw = localStorage.getItem(key);
      if (raw === null) continue;
      const operation = parse(key, raw, actor, device, id);
      if (operation) result.operations.push(operation);
      else {
        const issue: DeviceRecoveryRequestIssue = Object.freeze({
          ...context,
          ...(uuid.safeParse(id).success ? { id } : {}),
          kind: "corrupt",
          message:
            "A saved recovery request cannot be read safely. Check or cancel its exact server request before dismissing this reminder.",
        });
        issues.set(issue, { key, raw });
        result.errors.push(issue);
      }
    }
    if (records.length > maxRecords)
      result.errors.push({
        ...context,
        kind: "capacity",
        message:
          "Additional recovery requests remain for this device. Resolve the displayed reminders, then refresh to review the rest.",
      });
  } catch {
    result.errors.push({
      ...context,
      kind: "unavailable",
      message: storageError,
    });
  }
  result.operations.sort(
    (a, b) =>
      a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id),
  );
  return result;
}

export function beginDeviceRecoveryRequest(
  actor: string,
  deviceId: string,
  expectedName: string,
): DeviceRecoveryRequestOperation {
  if (!actorSchema.safeParse(actor).success)
    throw Error("Sign in again before authorizing device recovery.");
  if (
    !uuid.safeParse(deviceId).success ||
    !reviewedName.safeParse(expectedName).success
  )
    throw Error(
      "Reopen the device and review its name before authorizing recovery.",
    );
  const device = deviceId.toLowerCase(),
    current = readDeviceRecoveryRequests(actor, device);
  if (current.errors.length) throw Error(current.errors[0].message);
  if (current.operations.length)
    throw Error(
      "Review the saved recovery requests for this device before authorizing another.",
    );
  const id = crypto.randomUUID();
  const operation = operationSchema.parse({
    actor_id: actor,
    device_id: device,
    id,
    recorded_at: new Date().toISOString(),
    request: { request_id: id, expected_name: expectedName },
  });
  const raw = JSON.stringify(operation),
    key = keyFor(operation);
  if (bytes(raw) > maxBytes)
    throw Error("This recovery request is too large to retain safely.");
  try {
    if (keys(actor, device).length >= maxRecords) throw Error(capacityError);
    if (localStorage.getItem(key) !== null) throw Error(storageError);
    // Separate keys preserve peer intent; the server owns cancellation fencing.
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw Error(storageError);
    if (keys(actor, device).length > maxRecords) throw Error(capacityError);
  } catch (failure) {
    changed();
    if (failure instanceof Error && failure.message === capacityError)
      throw failure;
    throw Error(storageError);
  }
  changed();
  return parse(key, raw, actor, device, id)!;
}
export function deviceRecoveryRequestAvailable(
  operation: DeviceRecoveryRequestOperation,
) {
  const snapshot = snapshots.get(operation);
  if (!snapshot || !operationSchema.safeParse(operation).success) return false;
  try {
    return localStorage.getItem(snapshot.key) === snapshot.raw;
  } catch {
    return false;
  }
}
function removeExact(snapshot: Snapshot) {
  try {
    const current = localStorage.getItem(snapshot.key);
    if (current !== null && current !== snapshot.raw) throw Error(cleanupError);
    if (current !== null) localStorage.removeItem(snapshot.key);
    if (localStorage.getItem(snapshot.key) !== null) throw Error(cleanupError);
  } catch {
    changed();
    throw Error(cleanupError);
  }
  changed();
}
/** Only after an acknowledged secret or exact confirmed cancellation. */
export function finishDeviceRecoveryRequest(
  operation: DeviceRecoveryRequestOperation,
) {
  const snapshot = snapshots.get(operation);
  if (!snapshot || !operationSchema.safeParse(operation).success)
    throw Error(cleanupError);
  removeExact(snapshot);
}
/** Corrupt bytes never authorize creation; dismissal is a separate reviewed action. */
export function dismissDeviceRecoveryRequestIssue(
  issue: DeviceRecoveryRequestIssue,
) {
  const snapshot = issues.get(issue);
  if (!snapshot)
    throw Error(
      "Refresh the saved recovery requests before dismissing this reminder.",
    );
  removeExact(snapshot);
}
export function subscribeDeviceRecoveryRequests(
  actor: string,
  device: string,
  refresh: () => void,
) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(scopePrefix(actor, device)))
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
export function useDeviceRecoveryRequests(actor: string, device: string) {
  const [, refresh] = useState(0);
  useEffect(
    () =>
      subscribeDeviceRecoveryRequests(actor, device, () =>
        refresh((value) => value + 1),
      ),
    [actor, device],
  );
  return readDeviceRecoveryRequests(actor, device);
}
