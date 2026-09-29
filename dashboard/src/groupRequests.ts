import { useEffect, useState } from "react";
import { z } from "zod";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const actorSchema = z.string().min(1).max(128);
const requestFields = {
  name: z
    .string()
    .refine(
      (value) => value.trim().length > 0 && bytes(value) <= 120,
      "Use a group name of at most 120 UTF-8 bytes.",
    ),
  description: z
    .string()
    .refine(
      (value) => bytes(value) <= 2000,
      "Use a description of at most 2000 UTF-8 bytes.",
    ),
  device_ids: z
    .array(uuid)
    .max(10000)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Each device can appear only once.",
    ),
};
const createSchema = z.object(requestFields).strict();
const operationSchema = z
  .object({
    actor_id: actorSchema,
    id: uuid,
    recorded_at: z.string().datetime(),
    request: z.object({ ...requestFields, request_id: uuid }).strict(),
  })
  .strict()
  .refine((operation) => operation.id === operation.request.request_id);

export type GroupCreateRequest = z.infer<typeof createSchema>;
export type GroupOperation = z.infer<typeof operationSchema>;
export type GroupStorageIssue = {
  actor_id: string;
  id?: string;
  kind: "unavailable" | "corrupt" | "capacity";
  message: string;
};
export type GroupOperations = {
  operations: GroupOperation[];
  errors: GroupStorageIssue[];
};

const prefix = "vectory:group-operation:";
const eventName = "vectory:group-request";
const maxBytes = 2_000_000;
const maxRecords = 10;
const actorPrefix = (actor: string) => `${prefix}${encodeURIComponent(actor)}:`;
const keyFor = (operation: Pick<GroupOperation, "actor_id" | "id">) =>
  `${actorPrefix(operation.actor_id)}${operation.id}`;
const cache = new Map<string, { raw: string; operation: GroupOperation }>();
// Raw corrupt data stays private to an exact-read dismissal, never sent to the API.
const invalidRecords = new WeakMap<
  GroupStorageIssue,
  { key: string; raw: string }
>();
const storageError =
  "Browser storage is unavailable. Enable local storage before creating a group so a lost response can be recovered after closing this tab.";
const capacityError =
  "Review the saved group requests before creating another. This browser retains up to ten requests per account.";
const cleanupError =
  "The browser reminder could not be removed. The request may still be saved; check its status and try dismissing the reminder again.";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const withinSize = (raw: string) =>
  raw.length <= maxBytes && bytes(raw) <= maxBytes;
const changed = () => window.dispatchEvent(new Event(eventName));
function keys(actor: string) {
  const found: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(actorPrefix(actor))) found.push(key);
  }
  return found.sort();
}
function parse(raw: string, actor: string, id: string) {
  if (!withinSize(raw)) return null;
  const key = `${actor}:${id}`;
  const cached = cache.get(key);
  if (cached?.raw === raw) return cached.operation;
  try {
    const result = operationSchema.safeParse(JSON.parse(raw));
    if (
      !result.success ||
      result.data.actor_id !== actor ||
      result.data.id !== id
    )
      return null;
    const operation = freeze(result.data);
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, { raw, operation });
    return operation;
  } catch {
    return null;
  }
}
function equivalent(left: GroupOperation, right: GroupOperation) {
  const a = operationSchema.safeParse(left),
    b = operationSchema.safeParse(right);
  return (
    a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data)
  );
}

export function readGroupOperations(actor: string): GroupOperations {
  const result: GroupOperations = { operations: [], errors: [] };
  if (!actorSchema.safeParse(actor).success) {
    result.errors.push({
      actor_id: actor,
      kind: "unavailable",
      message: "Sign in again before reviewing saved group requests.",
    });
    return result;
  }
  try {
    const records = keys(actor);
    for (const key of records.slice(0, maxRecords)) {
      const id = key.slice(actorPrefix(actor).length),
        raw = localStorage.getItem(key);
      if (raw === null) continue; // Another tab may have just resolved it.
      const operation = parse(raw, actor, id);
      if (operation) result.operations.push(operation);
      else {
        const issue: GroupStorageIssue = {
          actor_id: actor,
          ...(uuid.safeParse(id).success ? { id } : {}),
          kind: "corrupt",
          message:
            "A saved group request cannot be read safely. Check its server result or your recent group requests before dismissing this browser reminder.",
        };
        invalidRecords.set(issue, { key, raw });
        result.errors.push(issue);
      }
    }
    if (records.length > maxRecords)
      result.errors.push({
        actor_id: actor,
        kind: "capacity",
        message:
          "Additional saved requests remain in browser storage. Resolve the displayed reminders, then refresh to review the rest.",
      });
  } catch {
    result.errors.push({
      actor_id: actor,
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

export function beginGroupOperation(
  actor: string,
  request: GroupCreateRequest,
): GroupOperation {
  const input = createSchema.safeParse(request);
  if (!input.success)
    throw Error(
      input.error.issues[0]?.message ||
        "Review the group details before creating it.",
    );
  if (!actorSchema.safeParse(actor).success)
    throw Error("Sign in again before creating a group.");
  const id = crypto.randomUUID();
  const operation = operationSchema.parse({
    actor_id: actor,
    id,
    recorded_at: new Date().toISOString(),
    request: { ...input.data, request_id: id },
  });
  const raw = JSON.stringify(operation),
    key = keyFor(operation);
  if (!withinSize(raw))
    throw Error(
      "This group request is too large to retain safely. Reduce its membership before sending.",
    );
  const current = readGroupOperations(actor);
  if (current.errors.length) throw Error(current.errors[0].message);
  if (current.operations.length)
    throw Error(
      "Review the saved group requests before creating another group.",
    );
  try {
    if (keys(actor).length >= maxRecords) throw Error(capacityError);
    if (localStorage.getItem(key) !== null)
      throw Error(
        "This request identity already exists. Review the saved request before continuing.",
      );
    // Separate keys avoid lost records across tabs. Capacity is a conservative
    // browser bound, not an atomic cross-tab lock; server idempotency is final.
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw Error(storageError);
    if (keys(actor).length > maxRecords) throw Error(capacityError);
  } catch (failure) {
    changed();
    if (
      failure instanceof Error &&
      [capacityError, storageError].includes(failure.message)
    )
      throw failure;
    throw Error(storageError);
  }
  changed();
  return parse(raw, actor, id)!;
}

export function groupOperationAvailable(operation: GroupOperation) {
  const current = readGroupOperations(operation.actor_id);
  return (
    !current.errors.some((issue) => issue.kind === "unavailable") &&
    current.operations.some((saved) => equivalent(saved, operation))
  );
}
export function finishGroupOperation(operation: GroupOperation) {
  if (!operationSchema.safeParse(operation).success) throw Error(cleanupError);
  try {
    const key = keyFor(operation),
      raw = localStorage.getItem(key);
    if (raw !== null) {
      const saved = parse(raw, operation.actor_id, operation.id);
      if (!saved || !equivalent(saved, operation)) throw Error(cleanupError);
      localStorage.removeItem(key);
    }
    if (localStorage.getItem(key) !== null) throw Error(cleanupError);
  } catch {
    changed();
    throw Error(cleanupError);
  }
  changed();
}

/** Explicitly discards only the exact corrupt bytes the user reviewed. */
export function dismissGroupStorageIssue(issue: GroupStorageIssue) {
  const snapshot = invalidRecords.get(issue);
  if (!snapshot)
    throw Error("Refresh the saved requests before dismissing this reminder.");
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

export function subscribeGroupOperations(actor: string, refresh: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key?.startsWith(actorPrefix(actor)))
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
export function useGroupOperations(actor: string) {
  const [, refresh] = useState(0);
  useEffect(
    () => subscribeGroupOperations(actor, () => refresh((value) => value + 1)),
    [actor],
  );
  return readGroupOperations(actor);
}
