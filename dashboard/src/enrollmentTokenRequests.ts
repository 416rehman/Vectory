import { useEffect, useState } from "react";
import { z } from "zod";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const uuid = z.string().uuid();
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
const name = z
  .string()
  .min(1)
  .refine((value) => bytes(value) <= 120 && !value.includes("\0"));
const prefixSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9-]*$/)
  .nullable();
const usesSchema = z.number().int().min(1).max(100000).nullable();
const inputSchema = z
  .object({
    name: name.refine(
      (value) => !!value.trim(),
      "Enter a token name of at most 120 UTF-8 bytes.",
    ),
    expires_hours: z.number().int().min(1).max(720),
    max_uses: usesSchema,
    name_prefix: prefixSchema.refine(
      (value) => value !== "",
      "Use null when no name prefix is requested.",
    ),
  })
  .strict();

export const TokenRecordSchema = z
  .object({
    id: uuid,
    name,
    expires_at: z.string().datetime({ offset: true }),
    uses: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    max_uses: usesSchema,
    name_prefix: prefixSchema,
    revoked: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
    recovery_device_id: uuid.optional(),
    recovery_name: z.string().min(1).max(100).optional(),
  })
  .strict();
const identityFields = {
  request_id: uuid,
  request_correlation: z.literal(true),
};
const foundStatusSchema = z
  .object({
    ...identityFields,
    found: z.literal(true),
    state: z.enum(["created", "cancelled"]),
    record: TokenRecordSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "created" && value.record === null)
      context.addIssue({
        code: "custom",
        message: "A created request must identify its token.",
      });
    if (value.state === "cancelled" && value.record && !value.record.revoked)
      context.addIssue({
        code: "custom",
        message: "A cancelled request cannot retain an active token.",
      });
  });
export const TokenRequestStatusSchema = z.union([
  z.object({ ...identityFields, found: z.literal(false) }).strict(),
  foundStatusSchema,
]);
export const TokenCreateResultSchema = z.union([
  z
    .object({
      ...identityFields,
      token: z.string().min(1).max(512),
      record: TokenRecordSchema.refine(
        (record) => record.uses === 0 && !record.revoked,
        "An initial token receipt must identify a newly created token.",
      ),
    })
    .strict(),
  foundStatusSchema,
]);

const operationSchema = z
  .object({
    actor_id: actorSchema,
    id: uuid,
    recorded_at: z.string().datetime(),
    request: inputSchema.extend({ request_id: uuid }).strict(),
  })
  .strict()
  .refine((value) => value.id === value.request.request_id);
export type TokenCreateInput = z.infer<typeof inputSchema>;
export type TokenRequestOperation = z.infer<typeof operationSchema>;
export type TokenRequestStatus = z.infer<typeof TokenRequestStatusSchema>;
export type TokenCreateResult = z.infer<typeof TokenCreateResultSchema>;
export type TokenRecord = z.infer<typeof TokenRecordSchema>;
export type TokenRequestIssue = {
  actor_id: string;
  id?: string;
  kind: "unavailable" | "corrupt" | "capacity";
  message: string;
};
export type TokenRequestRegistry = {
  operations: TokenRequestOperation[];
  errors: TokenRequestIssue[];
};

function checkRecord(operation: TokenRequestOperation, record: TokenRecord) {
  if (
    record.name !== operation.request.name ||
    record.max_uses !== operation.request.max_uses ||
    record.name_prefix !== operation.request.name_prefix ||
    record.recovery_device_id !== undefined ||
    record.recovery_name !== undefined
  )
    throw Error(
      "The token does not match this saved request. Keep the reminder and check its exact status before continuing.",
    );
}
export function checkTokenStatus(
  id: string,
  value: unknown,
  operation?: TokenRequestOperation,
): TokenRequestStatus {
  const result = TokenRequestStatusSchema.parse(value);
  if (
    !uuid.safeParse(id).success ||
    result.request_id.toLowerCase() !== id.toLowerCase() ||
    (operation && operation.id.toLowerCase() !== id.toLowerCase())
  )
    throw Error(
      "The response identifies a different token request. Keep this reminder and check again.",
    );
  if (result.found && result.record && operation)
    checkRecord(operation, result.record);
  return result;
}
export function checkTokenCreation(
  operation: TokenRequestOperation,
  value: unknown,
): TokenCreateResult {
  const result = TokenCreateResultSchema.parse(value);
  if (result.request_id.toLowerCase() !== operation.id.toLowerCase())
    throw Error(
      "The response identifies a different token request. Keep this reminder and check again.",
    );
  if (result.record) checkRecord(operation, result.record);
  return result;
}

const storagePrefix = "vectory:enrollment-token-request:";
const eventName = "vectory:enrollment-token-requests";
const maxRecords = 10;
const maxBytes = 8192;
const actorPrefix = (actor: string) =>
  `${storagePrefix}${encodeURIComponent(actor)}:`;
const keyFor = (operation: Pick<TokenRequestOperation, "actor_id" | "id">) =>
  `${actorPrefix(operation.actor_id)}${operation.id}`;
const snapshots = new WeakMap<
  TokenRequestOperation,
  { key: string; raw: string }
>();
const issues = new WeakMap<TokenRequestIssue, { key: string; raw: string }>();
const cache = new Map<
  string,
  { raw: string; operation: TokenRequestOperation }
>();
const storageError =
  "Browser storage is unavailable. Enable it before creating a token so an interrupted request can be reviewed after closing this tab.";
const cleanupError =
  "This browser reminder could not be removed. Refresh and check the saved request before dismissing it again.";
const capacityError =
  "Review the saved token requests before creating another. This browser retains up to ten requests per account.";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const changed = () => window.dispatchEvent(new Event(eventName));
function keys(actor: string) {
  const found: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(actorPrefix(actor))) found.push(key);
  }
  return found.sort();
}
function parse(key: string, raw: string, actor: string, id: string) {
  if (raw.length > maxBytes || bytes(raw) > maxBytes) return null;
  const old = cache.get(key);
  if (old?.raw === raw) return old.operation;
  try {
    const result = operationSchema.safeParse(JSON.parse(raw));
    if (
      !result.success ||
      result.data.actor_id !== actor ||
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

export function readTokenRequests(actor: string): TokenRequestRegistry {
  const result: TokenRequestRegistry = { operations: [], errors: [] };
  if (!actorSchema.safeParse(actor).success) {
    result.errors.push({
      actor_id: actor,
      kind: "unavailable",
      message: "Sign in again before reviewing saved token requests.",
    });
    return result;
  }
  try {
    const records = keys(actor);
    for (const key of records.slice(0, maxRecords)) {
      const id = key.slice(actorPrefix(actor).length),
        raw = localStorage.getItem(key);
      if (raw === null) continue;
      const operation = parse(key, raw, actor, id);
      if (operation) result.operations.push(operation);
      else {
        const issue: TokenRequestIssue = {
          actor_id: actor,
          ...(uuid.safeParse(id).success ? { id } : {}),
          kind: "corrupt",
          message:
            "A saved token request cannot be read safely. Check or cancel its exact server request before dismissing this reminder.",
        };
        Object.freeze(issue);
        issues.set(issue, { key, raw });
        result.errors.push(issue);
      }
    }
    if (records.length > maxRecords)
      result.errors.push({
        actor_id: actor,
        kind: "capacity",
        message:
          "Additional saved token requests remain. Resolve the displayed reminders, then refresh to review the rest.",
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

export function beginTokenRequest(
  actor: string,
  input: TokenCreateInput,
): TokenRequestOperation {
  const valid = inputSchema.safeParse(input);
  if (!valid.success)
    throw Error(
      "Review the token name, expiry, maximum uses and prefix before creating it.",
    );
  if (!actorSchema.safeParse(actor).success)
    throw Error("Sign in again before creating a token.");
  const current = readTokenRequests(actor);
  if (current.errors.length) throw Error(current.errors[0].message);
  if (current.operations.length)
    throw Error("Review the saved token requests before creating another.");
  const id = crypto.randomUUID();
  const operation = operationSchema.parse({
    actor_id: actor,
    id,
    recorded_at: new Date().toISOString(),
    request: { ...valid.data, request_id: id },
  });
  const raw = JSON.stringify(operation),
    key = keyFor(operation);
  if (bytes(raw) > maxBytes)
    throw Error("This token request is too large to retain safely.");
  try {
    if (keys(actor).length >= maxRecords) throw Error(capacityError);
    if (localStorage.getItem(key) !== null) throw Error(storageError);
    // Separate records avoid overwriting peer requests. This is not an atomic
    // cross-tab lock; the server owns exact replay and cancellation fencing.
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw Error(storageError);
    if (keys(actor).length > maxRecords) throw Error(capacityError);
  } catch (failure) {
    changed();
    if (failure instanceof Error && failure.message === capacityError)
      throw failure;
    throw Error(storageError);
  }
  changed();
  return parse(key, raw, actor, id)!;
}

export function tokenRequestAvailable(operation: TokenRequestOperation) {
  const snapshot = snapshots.get(operation);
  if (!snapshot || !operationSchema.safeParse(operation).success) return false;
  try {
    return localStorage.getItem(snapshot.key) === snapshot.raw;
  } catch {
    return false;
  }
}
function removeExact(snapshot: { key: string; raw: string }) {
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
/** Call only after an acknowledged secret or an exact confirmed cancellation. */
export function finishTokenRequest(operation: TokenRequestOperation) {
  const snapshot = snapshots.get(operation);
  if (!snapshot || !operationSchema.safeParse(operation).success)
    throw Error(cleanupError);
  removeExact(snapshot);
}
/** A corrupt payload cannot authorize creation; this only removes reviewed bytes. */
export function dismissTokenRequestIssue(issue: TokenRequestIssue) {
  const snapshot = issues.get(issue);
  if (!snapshot)
    throw Error("Refresh the saved requests before dismissing this reminder.");
  removeExact(snapshot);
}
export function subscribeTokenRequests(actor: string, refresh: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(actorPrefix(actor)))
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
export function useTokenRequests(actor: string) {
  const [, refresh] = useState(0);
  useEffect(
    () => subscribeTokenRequests(actor, () => refresh((value) => value + 1)),
    [actor],
  );
  return readTokenRequests(actor);
}
