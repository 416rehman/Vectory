import { useEffect, useState } from "react";
import { z } from "zod";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const actorSchema = z.string().min(1).max(128);
const requestFields = {
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  message: z
    .string()
    .refine(
      (value) => bytes(value) <= 2000,
      "Use a publication message of at most 2000 UTF-8 bytes.",
    ),
};
const requestSchema = z.object(requestFields).strict();
const operationSchema = z
  .object({
    actor_id: actorSchema,
    id: uuid,
    configuration_id: uuid,
    recorded_at: z.string().datetime(),
    request: z.object({ ...requestFields, request_id: uuid }).strict(),
  })
  .strict()
  .refine((operation) => operation.id === operation.request.request_id);
export type PublishRequest = z.infer<typeof requestSchema>;
export type PublishOperation = z.infer<typeof operationSchema>;
export type PublishStorageIssue = {
  actor_id: string;
  configuration_id?: string;
  id?: string;
  kind: "unavailable" | "corrupt" | "capacity";
  message: string;
};
export type PublishOperations = {
  operations: PublishOperation[];
  errors: PublishStorageIssue[];
};
const prefix = "vectory:publish-operation:";
const eventName = "vectory:publish-request";
const maxBytes = 16_384;
const maxRecords = 10;
const actorPrefix = (actor: string) => `${prefix}${encodeURIComponent(actor)}:`;
const keyFor = (
  op: Pick<PublishOperation, "actor_id" | "configuration_id" | "id">,
) => `${actorPrefix(op.actor_id)}${op.configuration_id}:${op.id}`;
const cache = new Map<string, { raw: string; operation: PublishOperation }>();
const invalidRecords = new WeakMap<
  PublishStorageIssue,
  { key: string; raw: string }
>();
const storageError =
  "Browser storage is unavailable. Enable local storage before publishing so a lost response can be recovered after closing this tab.";
const cleanupError =
  "The browser reminder could not be removed. Check its status and try dismissing the reminder again.";
const capacityError =
  "This account has ten saved publication requests in this browser. Open the affected pipelines and review their requests before publishing another version.";
const changed = () => window.dispatchEvent(new Event(eventName));
const withinSize = (raw: string) =>
  raw.length <= maxBytes && bytes(raw) <= maxBytes;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function keys(actor: string) {
  const found: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(actorPrefix(actor))) found.push(key);
  }
  return found.sort();
}
function keyScope(key: string, actor: string) {
  const parts = key.slice(actorPrefix(actor).length).split(":");
  if (
    parts.length !== 2 ||
    !uuid.safeParse(parts[0]).success ||
    !uuid.safeParse(parts[1]).success
  )
    return null;
  return { configuration_id: parts[0], id: parts[1] };
}
function parse(raw: string, actor: string, configuration: string, id: string) {
  if (!withinSize(raw)) return null;
  const key = `${actor}:${configuration}:${id}`,
    cached = cache.get(key);
  if (cached?.raw === raw) return cached.operation;
  try {
    const parsed = operationSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.actor_id !== actor ||
      parsed.data.configuration_id !== configuration ||
      parsed.data.id !== id
    )
      return null;
    const operation = freeze(parsed.data);
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, { raw, operation });
    return operation;
  } catch {
    return null;
  }
}
function equivalent(a: PublishOperation, b: PublishOperation) {
  const left = operationSchema.safeParse(a),
    right = operationSchema.safeParse(b);
  return (
    left.success &&
    right.success &&
    JSON.stringify(left.data) === JSON.stringify(right.data)
  );
}
export function readPublishOperations(
  actor: string,
  configurationId: string,
): PublishOperations {
  const result: PublishOperations = { operations: [], errors: [] };
  if (
    !actorSchema.safeParse(actor).success ||
    !uuid.safeParse(configurationId).success
  ) {
    result.errors.push({
      actor_id: actor,
      kind: "unavailable",
      message:
        "Open a valid pipeline while signed in before reviewing publication requests.",
    });
    return result;
  }
  try {
    let relevant = 0;
    for (const key of keys(actor)) {
      const scope = keyScope(key, actor);
      if (scope && scope.configuration_id !== configurationId) continue;
      relevant++;
      if (relevant > maxRecords) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const operation = scope && parse(raw, actor, configurationId, scope.id);
      if (operation) result.operations.push(operation);
      else {
        const issue: PublishStorageIssue = {
          actor_id: actor,
          ...(scope || {}),
          kind: "corrupt",
          message: scope
            ? "A saved publication request for this pipeline cannot be read safely. Check its result before dismissing the reminder."
            : "A saved publication reminder has no reliable pipeline identity. Review recent publications before deliberately dismissing it.",
        };
        invalidRecords.set(issue, { key, raw });
        result.errors.push(issue);
      }
    }
    if (relevant > maxRecords)
      result.errors.push({
        actor_id: actor,
        configuration_id: configurationId,
        kind: "capacity",
        message:
          "Additional publication reminders remain in storage. Resolve the displayed reminders, then refresh to review the rest.",
      });
  } catch {
    result.errors.push({
      actor_id: actor,
      configuration_id: configurationId,
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
export function beginPublishOperation(
  actor: string,
  configurationId: string,
  request: PublishRequest,
): PublishOperation {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success)
    throw Error(
      parsed.error.issues[0]?.message ||
        "Review the saved revision and message before publishing.",
    );
  if (
    !actorSchema.safeParse(actor).success ||
    !uuid.safeParse(configurationId).success
  )
    throw Error("Open a valid pipeline while signed in before publishing.");
  const current = readPublishOperations(actor, configurationId);
  if (current.errors.length) throw Error(current.errors[0].message);
  if (current.operations.length)
    throw Error(
      "Review this pipeline’s saved publication requests before publishing another version.",
    );
  const id = crypto.randomUUID();
  const operation = operationSchema.parse({
    actor_id: actor,
    configuration_id: configurationId,
    id,
    recorded_at: new Date().toISOString(),
    request: { ...parsed.data, request_id: id },
  });
  const raw = JSON.stringify(operation),
    key = keyFor(operation);
  if (!withinSize(raw))
    throw Error(
      "This publication request is too large to retain safely in browser storage.",
    );
  try {
    const existing = keys(actor);
    if (existing.length >= maxRecords) throw Error(capacityError);
    if (
      existing.some((key) => keyScope(key, actor)?.id === id) ||
      localStorage.getItem(key) !== null
    )
      throw Error(
        "This request identity is already saved. Review its result before publishing.",
      );
    // Per-request keys retain concurrent tab writes. This capacity check is not
    // an atomic cross-tab lock; actor-scoped server idempotency is authoritative.
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
  return parse(raw, actor, configurationId, id)!;
}
export function publishOperationAvailable(operation: PublishOperation) {
  const current = readPublishOperations(
    operation.actor_id,
    operation.configuration_id,
  );
  return (
    !current.errors.some((issue) => issue.kind === "unavailable") &&
    current.operations.some((saved) => equivalent(saved, operation))
  );
}
export function finishPublishOperation(operation: PublishOperation) {
  if (!operationSchema.safeParse(operation).success) throw Error(cleanupError);
  try {
    const key = keyFor(operation),
      raw = localStorage.getItem(key);
    if (raw !== null) {
      const saved = parse(
        raw,
        operation.actor_id,
        operation.configuration_id,
        operation.id,
      );
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
export function dismissPublishStorageIssue(issue: PublishStorageIssue) {
  const snapshot = invalidRecords.get(issue);
  if (!snapshot)
    throw Error(
      "Refresh saved publication requests before dismissing this reminder.",
    );
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
export function assertPublishReceipt(
  operation: PublishOperation,
  receipt: {
    request_id: string;
    configuration_id: string;
    source_revision: number;
    message: string;
  },
) {
  if (
    receipt.request_id !== operation.id ||
    receipt.configuration_id !== operation.configuration_id ||
    receipt.source_revision !== operation.request.revision ||
    receipt.message !== operation.request.message
  )
    throw Error(
      "The receipt does not match this saved publication. Check its status before publishing another version.",
    );
}
export function subscribePublishOperations(
  actor: string,
  configurationId: string,
  refresh: () => void,
) {
  const storage = (event: StorageEvent) => {
    if (event.key === null) return refresh();
    if (!event.key?.startsWith(actorPrefix(actor))) return;
    const scope = keyScope(event.key, actor);
    if (!scope || scope.configuration_id === configurationId) refresh();
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
export function usePublishOperations(actor: string, configurationId: string) {
  const [, refresh] = useState(0);
  useEffect(
    () =>
      subscribePublishOperations(actor, configurationId, () =>
        refresh((value) => value + 1),
      ),
    [actor, configurationId],
  );
  return readPublishOperations(actor, configurationId);
}
