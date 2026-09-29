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
    // Usage the token list adds; absent from creation and request receipts.
    created_by: z
      .object({ id: z.string().min(1).max(128), name: z.string().nullable() })
      .strict()
      .nullable()
      .optional(),
    last_used_at: z.string().datetime({ offset: true }).nullable().optional(),
    device_count: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    devices: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: z.string().min(1).max(256),
            revoked: z.boolean(),
            enrolled_at: z.string().datetime({ offset: true }).nullable(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
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
    // Set when the first secret arrived: the creation is confirmed, so the
    // reminder only tracks the token (by ID, never its secret).
    token_id: uuid.optional(),
    confirmed_at: z.string().datetime().optional(),
  })
  .strict()
  .refine((value) => value.id === value.request.request_id)
  .refine((value) => !value.token_id === !value.confirmed_at);
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

/** A creation whose first secret arrived: it never blocks another one. */
export const confirmed = (operation: TokenRequestOperation) =>
  !!operation.token_id;

/**
 * Confirmed reminders only track a token the token list already shows, so the
 * oldest of them make room for a new request. Unconfirmed ones are never
 * dropped here: their outcome is still unknown.
 */
function makeRoom(actor: string, operations: TokenRequestOperation[]) {
  const spare = operations
    .filter(confirmed)
    .sort((a, b) =>
      (a.confirmed_at || a.recorded_at).localeCompare(
        b.confirmed_at || b.recorded_at,
      ),
    );
  try {
    while (keys(actor).length >= maxRecords && spare.length) {
      const snapshot = snapshots.get(spare.shift()!);
      if (snapshot) removeExact(snapshot);
    }
  } catch {
    // The capacity check below reports what is still stored.
  }
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
  if (current.operations.some((operation) => !confirmed(operation)))
    throw Error("Review the saved token requests before creating another.");
  makeRoom(actor, current.operations);
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
/**
 * Call only after an acknowledged secret, an exact confirmed cancellation, or
 * once the server shows that the request's token can't enroll anything more.
 */
export function finishTokenRequest(operation: TokenRequestOperation) {
  const snapshot = snapshots.get(operation);
  if (!snapshot || !operationSchema.safeParse(operation).success)
    throw Error(cleanupError);
  removeExact(snapshot);
}
/**
 * The first secret arrived: record which token the request created (its ID,
 * never the secret). From then on the reminder never blocks another request;
 * the token list tells what became of it. Returns the stored operation to use
 * from now on; the one passed in no longer matches storage.
 */
export function confirmTokenRequest(
  operation: TokenRequestOperation,
  record: { id: string },
): TokenRequestOperation {
  const snapshot = snapshots.get(operation);
  if (!snapshot || !operationSchema.safeParse(operation).success)
    throw Error(storageError);
  if (operation.token_id) {
    if (operation.token_id !== record.id) throw Error(cleanupError);
    return operation;
  }
  const next = operationSchema.parse({
    ...operation,
    token_id: record.id,
    confirmed_at: new Date().toISOString(),
  });
  const raw = JSON.stringify(next);
  try {
    if (localStorage.getItem(snapshot.key) !== snapshot.raw)
      throw Error(storageError);
    localStorage.setItem(snapshot.key, raw);
    if (localStorage.getItem(snapshot.key) !== raw) throw Error(storageError);
  } catch {
    changed();
    throw Error(storageError);
  }
  changed();
  return parse(snapshot.key, raw, operation.actor_id, operation.id)!;
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

/** A token as the token list (or a request receipt) reports it. */
export type ListedToken = {
  id: string;
  name: string;
  expires_at: string;
  uses: number;
  max_uses?: number | null;
  revoked: boolean;
  last_used_at?: string | null;
  device_count?: number;
  devices?: { name: string; enrolled_at: string | null }[];
};
/** Whether a device could still enroll with this token. */
export function tokenCanStillEnroll(token: ListedToken, now = Date.now()) {
  const expires = Date.parse(token.expires_at);
  return (
    !token.revoked &&
    Number.isFinite(expires) &&
    expires > now &&
    (!token.max_uses || token.uses < token.max_uses)
  );
}

/** "at 5:15 PM", or "on Sep 28 at 5:15 PM" for another day; "" if unknown. */
export function when(value: string | null | undefined, now = Date.now()) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.valueOf())) return "";
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return at.toDateString() === new Date(now).toDateString()
    ? `at ${time}`
    : `on ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/**
 * "r16-full install command enrolled r16-full at 5:15 PM." for a token that
 * enrolled something; null when it enrolled nothing.
 */
export function enrollmentNote(token: ListedToken, now = Date.now()) {
  if (token.uses < 1 && !token.devices?.length) return null;
  const devices = token.devices || [];
  const total = Math.max(token.device_count ?? devices.length, devices.length);
  if (!devices.length) {
    // A receipt or an older server: counts without names.
    const last = when(token.last_used_at, now);
    return token.uses === 1
      ? `${token.name} enrolled a device${last ? ` ${last}` : ""}.`
      : `${token.name} enrolled ${token.uses} devices${last ? `, the last ${last}` : ""}.`;
  }
  // The list is most recent first; name them in the order they enrolled.
  const names = devices
    .slice(0, 3)
    .map((device) => device.name)
    .reverse();
  if (total > names.length) names.push(`${total - names.length} more`);
  const listed =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names[0];
  const time = when(devices[0].enrolled_at || token.last_used_at, now);
  return `${token.name} enrolled ${listed}${time ? ` ${time}` : ""}.`;
}

export type TokenRequestResolution =
  /** The creation's response never arrived: review it before another. */
  | { kind: "unconfirmed"; operation: TokenRequestOperation }
  /** Confirmed, but the token list can't say what became of it yet. */
  | { kind: "unresolved"; operation: TokenRequestOperation }
  /** Confirmed, no device used it and it still works. */
  | { kind: "unused"; operation: TokenRequestOperation; token: ListedToken }
  /** Its token enrolled something or can't enroll anymore: drop it. */
  | {
      kind: "finished";
      operation: TokenRequestOperation;
      token: ListedToken;
      note: string | null;
    };

/**
 * What became of a stored request, from the token list. `tokens` is null
 * while the list is loading or failed to load: nothing is dropped then.
 */
export function resolveTokenRequest(
  operation: TokenRequestOperation,
  tokens: readonly ListedToken[] | null,
  now = Date.now(),
): TokenRequestResolution {
  if (!operation.token_id) return { kind: "unconfirmed", operation };
  const token = tokens?.find((item) => item.id === operation.token_id);
  if (!token) return { kind: "unresolved", operation };
  if (token.uses === 0 && tokenCanStillEnroll(token, now))
    return { kind: "unused", operation, token };
  return {
    kind: "finished",
    operation,
    token,
    note: enrollmentNote(token, now),
  };
}
export function resolveTokenRequests(
  operations: readonly TokenRequestOperation[],
  tokens: readonly ListedToken[] | null,
  now = Date.now(),
) {
  return operations.map((operation) =>
    resolveTokenRequest(operation, tokens, now),
  );
}

/**
 * What an exact request status says about an unconfirmed request: "finished"
 * when it can't create or enroll anything more (cancelled, or its token is
 * used, revoked or expired), "live" when its token could still enroll a
 * device, "unknown" when the server has no result for it yet.
 */
export function statusOutcome(
  status: TokenRequestStatus,
  now = Date.now(),
): "finished" | "live" | "unknown" {
  if (!status.found) return "unknown";
  if (status.state === "cancelled" || !status.record) return "finished";
  return status.record.uses === 0 && tokenCanStillEnroll(status.record, now)
    ? "live"
    : "finished";
}
