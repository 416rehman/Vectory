import { useEffect, useState } from "react";
import { z } from "zod";
import {
  RollbackPreviewSchema,
  RollbackReviewContextSchema,
  rollbackToken,
  type RollbackPreview,
} from "./rollbackReview";
import { APIError, type Policy } from "./api";
import type { VariableBindings } from "./deploymentVariables";

export type DeploymentCreateRequest = {
  version_id?: string;
  policy?: Policy;
  selector: {
    device_ids: string[];
    group_ids: string[];
    exclude_ids: string[];
  };
  expected_device_ids: string[];
  variable_bindings?: VariableBindings;
  priority: number;
  target_mode: string;
  scheduled_at: string | null;
  rollout: {
    kind: string;
    canary_size: number;
    batch_size: number;
    observation_seconds: number;
    failure_threshold: number;
  };
  request_id?: string;
};
const ids = z.array(z.string().max(64)).max(10000);
const variableName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const variableValue = z.union([
  z.string().refine((value) => new TextEncoder().encode(value).length <= 4096),
  z.number().int().safe(),
  z.boolean(),
]);
const variableMap = z.record(variableName, variableValue);
const variableBindings = z.object({
  defaults: variableMap,
  devices: z.record(z.string().uuid(), variableMap),
}).strict();
const operationBase = {
  actor_id: z.string().min(1).max(128),
  id: z.string().uuid(),
  label: z.string().max(160),
  recorded_at: z.string().datetime(),
  retry_supported: z.boolean(),
};
const createOperationSchema = z
  .object({
    ...operationBase,
    kind: z.literal("create").default("create"),
    request: z
      .object({
        version_id: z.string().max(64).optional(),
        policy: z
          .object({
            heartbeat_seconds: z.number().int().min(10).max(3600),
            sync_paused: z.boolean(),
            telemetry_enabled: z.boolean(),
          })
          .strict()
          .optional(),
        selector: z
          .object({ device_ids: ids, group_ids: ids, exclude_ids: ids })
          .strict(),
        expected_device_ids: ids,
        variable_bindings: variableBindings.optional(),
        priority: z.number().int().min(-1000000).max(1000000),
        target_mode: z.enum(["snapshot", "persistent"]),
        scheduled_at: z.string().datetime({ offset: true }).nullable(),
        rollout: z
          .object({
            kind: z.enum(["all", "canary"]),
            canary_size: z.number().int().min(1).max(10000),
            batch_size: z.number().int().min(1).max(10000),
            observation_seconds: z.number().int().min(0).max(86400),
            failure_threshold: z.number().int().min(0).max(10000),
          })
          .strict(),
        request_id: z.string().uuid().optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (op) => Boolean(op.request.version_id) !== Boolean(op.request.policy),
  );
const rollbackOperationSchema = z
  .object({
    ...operationBase,
    kind: z.literal("rollback"),
    deployment_id: z.string().uuid(),
    request: z
      .object({
        request_id: z.string().uuid().optional(),
        review_token: rollbackToken.optional(),
      })
      .strict(),
    review: RollbackReviewContextSchema.optional(),
  })
  .strict()
  .refine(
    (op) =>
      Boolean(op.request.review_token) === Boolean(op.review) &&
      (!op.review || op.retry_supported),
  );
const operationSchema = z
  .union([createOperationSchema, rollbackOperationSchema])
  .refine((op) =>
    op.retry_supported
      ? op.request.request_id === op.id
      : !op.request.request_id,
  );
export type DeploymentOperation = z.infer<typeof operationSchema>;
export type DeploymentStorageIssue = {
  actor_id: string;
  id?: string;
  kind: "unavailable" | "corrupt" | "capacity";
  message: string;
};
export type DeploymentRegistry = {
  operations: DeploymentOperation[];
  errors: DeploymentStorageIssue[];
};
export const deploymentOperationPath = (operation: DeploymentOperation) =>
  operation.kind === "rollback"
    ? `/deployments/${operation.deployment_id}/rollback`
    : "/deployments";
const eventName = "vectory:deployment-request";
const operationPrefix = "vectory:deployment-operation:";
const leasePrefix = "vectory:deployment-operation-lease:";
const maxOperationBytes = 2_000_000;
const maxOperations = 10;
const leaseDuration = 45_000;
const legacyKey = (actor: string) => `vectory:deployment-request:${actor}`;
const actorPrefix = (actor: string) =>
  `${operationPrefix}${encodeURIComponent(actor)}:`;
const operationKey = (op: Pick<DeploymentOperation, "actor_id" | "id">) =>
  `${actorPrefix(op.actor_id)}${op.id}`;
const leaseKey = (op: Pick<DeploymentOperation, "actor_id" | "id">) =>
  `${leasePrefix}${encodeURIComponent(op.actor_id)}:${op.id}`;
const changed = () => window.dispatchEvent(new Event(eventName));
// Cache parsed objects, never storage reads. A changed/removed record in another
// tab must be visible even before that tab's storage event reaches this window.
const parsedRecords = new Map<
  string,
  { raw: string; operation: DeploymentOperation }
>();
type StorageSnapshot = {
  storage: "local" | "session";
  key: string;
  raw: string;
};
// Unreadable bytes never become UI or network payloads. Only the exact opaque
// issue returned by a read can authorize removal of its unchanged snapshots.
const invalidRecords = new WeakMap<DeploymentStorageIssue, StorageSnapshot[]>();
type ActiveClaim = {
  operation: DeploymentOperation;
  token: string;
  timer: ReturnType<typeof setInterval>;
};
const active = new Map<string, ActiveClaim>();
const storageFailure =
  "Browser storage is unavailable. Enable local storage before sending a deployment so a lost response can be recovered after closing this tab.";
const capacityFailure =
  "There are already ten deployment requests to review for this account. Confirm or dismiss an existing request before sending another.";
const cleanupFailure =
  "The request reminder could not be removed from browser storage. It is still available for review; enable local storage and dismiss the reminder again.";

function freezeOperation<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeOperation);
    Object.freeze(value);
  }
  return value;
}
function withinSize(raw: string) {
  return (
    raw.length <= maxOperationBytes &&
    new TextEncoder().encode(raw).length <= maxOperationBytes
  );
}
function parseOperation(
  raw: string | null,
  actor: string,
  id?: string,
): DeploymentOperation | null {
  if (!raw || !withinSize(raw)) return null;
  const key = `${actor}:${id || "legacy"}`;
  const cached = parsedRecords.get(key);
  if (cached?.raw === raw) return cached.operation;
  try {
    const parsed = operationSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.actor_id !== actor ||
      (id !== undefined && parsed.data.id !== id)
    )
      return null;
    const operation = freezeOperation(parsed.data);
    if (parsedRecords.size >= 40)
      parsedRecords.delete(parsedRecords.keys().next().value!);
    parsedRecords.set(key, { raw, operation });
    return operation;
  } catch {
    return null;
  }
}
function storedKeys(actor: string): string[] {
  const prefix = actorPrefix(actor);
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}
function sameOperation(left: DeploymentOperation, right: DeploymentOperation) {
  // Zod emits the strict schema's key order; JSON insertion order is not part
  // of a request's identity (legacy writers can have a different order).
  const a = operationSchema.safeParse(left),
    b = operationSchema.safeParse(right);
  return (
    a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data)
  );
}
function corruptIssue(
  actor: string,
  snapshots: StorageSnapshot[],
  id?: string,
  message = "A saved deployment request cannot be read safely. Check its server result or deployment history before dismissing this browser reminder.",
): DeploymentStorageIssue {
  const issue: DeploymentStorageIssue = Object.freeze({
    actor_id: actor,
    ...(id && z.string().uuid().safeParse(id).success ? { id } : {}),
    kind: "corrupt",
    message,
  });
  invalidRecords.set(issue, snapshots);
  return issue;
}
function unavailable(actor: string): DeploymentStorageIssue {
  return { actor_id: actor, kind: "unavailable", message: storageFailure };
}
function migrateLegacy(
  actor: string,
  errors: DeploymentStorageIssue[],
): { legacy: DeploymentOperation | null; conflictKey?: string } {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(legacyKey(actor));
  } catch {
    errors.push(unavailable(actor));
    return { legacy: null };
  }
  if (raw === null) return { legacy: null };
  const legacy = parseOperation(raw, actor);
  if (!legacy) {
    errors.push(
      corruptIssue(
        actor,
        [{ storage: "session", key: legacyKey(actor), raw }],
        undefined,
        "A saved deployment reminder from this tab cannot be read safely. Its request identity is unavailable. Review deployment history before dismissing it.",
      ),
    );
    return { legacy: null };
  }
  try {
    const key = operationKey(legacy);
    const currentRaw = localStorage.getItem(key);
    if (currentRaw === null) {
      if (storedKeys(actor).length >= maxOperations) {
        errors.push({
          actor_id: actor,
          kind: "capacity",
          message: capacityFailure,
        });
        return { legacy };
      }
      const durableRaw = JSON.stringify(legacy);
      if (!withinSize(durableRaw)) throw Error(storageFailure);
      localStorage.setItem(key, durableRaw);
    }
    // Never overwrite a same-ID record, including an invalid or conflicting one.
    const verifiedRaw = localStorage.getItem(key);
    if (verifiedRaw === null) throw Error(storageFailure);
    const durable = parseOperation(verifiedRaw, actor, legacy.id);
    if (durable && sameOperation(durable, legacy)) {
      // A concurrent session repair must not be erased during migration.
      if (sessionStorage.getItem(legacyKey(actor)) !== raw)
        throw Error(storageFailure);
      sessionStorage.removeItem(legacyKey(actor));
      if (sessionStorage.getItem(legacyKey(actor)) !== null)
        throw Error(storageFailure);
    } else {
      errors.push(
        corruptIssue(
          actor,
          [
            { storage: "session", key: legacyKey(actor), raw },
            { storage: "local", key, raw: verifiedRaw },
          ],
          legacy.id,
          "Saved reminders disagree about this deployment request. Check its server result or deployment history before dismissing them. Neither saved payload can be retried safely.",
        ),
      );
      return { legacy: null, conflictKey: key };
    }
  } catch {
    // The old tab's record remains readable until a durable copy is confirmed.
    errors.push(unavailable(actor));
  }
  return { legacy };
}

export function readDeploymentRegistry(actor: string): DeploymentRegistry {
  const result: DeploymentRegistry = { operations: [], errors: [] };
  if (!operationBase.actor_id.safeParse(actor).success) {
    result.errors.push({
      actor_id: actor,
      kind: "unavailable",
      message: "Sign in again before reviewing saved deployment requests.",
    });
    return result;
  }
  const { legacy, conflictKey } = migrateLegacy(actor, result.errors);
  const records = new Map<string, DeploymentOperation>();
  try {
    const keys = storedKeys(actor).sort();
    for (const key of keys.slice(0, maxOperations)) {
      if (key === conflictKey) continue;
      const id = key.slice(actorPrefix(actor).length);
      let raw: string | null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        if (!result.errors.some((issue) => issue.kind === "unavailable"))
          result.errors.push(unavailable(actor));
        continue;
      }
      if (raw === null) continue;
      const operation = parseOperation(raw, actor, id);
      if (operation) records.set(operation.id, operation);
      else
        result.errors.push(
          corruptIssue(actor, [{ storage: "local", key, raw }], id),
        );
    }
    if (keys.length > maxOperations)
      result.errors.push({
        actor_id: actor,
        kind: "capacity",
        message:
          "Additional deployment reminders remain in browser storage. Resolve the displayed reminders, then refresh to review the rest.",
      });
  } catch {
    // A legacy session reminder remains usable for status lookup if migration fails.
    if (!result.errors.some((issue) => issue.kind === "unavailable"))
      result.errors.push(unavailable(actor));
  }
  if (legacy && !records.has(legacy.id)) records.set(legacy.id, legacy);
  result.operations = [...records.values()].sort(
    (a, b) =>
      a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id),
  );
  return result;
}
export function readDeploymentOperations(actor: string): DeploymentOperation[] {
  return readDeploymentRegistry(actor).operations;
}

export function readDeploymentOperation(
  actor: string,
): DeploymentOperation | null {
  return readDeploymentOperations(actor)[0] || null;
}
export function beginDeploymentOperation(
  actor: string,
  request: DeploymentCreateRequest,
  retrySupported: boolean,
  label: string,
): DeploymentOperation {
  const id = crypto.randomUUID();
  const operation = operationSchema.parse({
    actor_id: actor,
    id,
    label,
    recorded_at: new Date().toISOString(),
    retry_supported: retrySupported,
    kind: "create",
    request: {
      ...structuredClone(request),
      ...(retrySupported ? { request_id: id } : {}),
    },
  });
  return persistOperation(operation);
}
export function beginRollbackOperation(
  actor: string,
  deploymentId: string,
  retrySupported: boolean,
  label: string,
  preview?: RollbackPreview,
): DeploymentOperation {
  const reviewed = preview ? RollbackPreviewSchema.parse(preview) : undefined;
  if (
    reviewed &&
    (!reviewed.ready ||
      !reviewed.previous_version_id ||
      reviewed.source_deployment_id.toLowerCase() !==
        deploymentId.toLowerCase() ||
      !retrySupported)
  )
    throw Error("Review the current rollback scope before confirming.");
  const id = crypto.randomUUID();
  return persistOperation(
    operationSchema.parse({
      actor_id: actor,
      id,
      kind: "rollback",
      deployment_id: deploymentId,
      label: label.slice(0, 160),
      recorded_at: new Date().toISOString(),
      retry_supported: retrySupported,
      request: {
        ...(retrySupported ? { request_id: id } : {}),
        ...(reviewed ? { review_token: reviewed.review_token } : {}),
      },
      ...(reviewed
        ? {
            review: {
              version_id: reviewed.previous_version_id,
              version_number: reviewed.previous_version_number,
              configuration_name: reviewed.previous_configuration_name,
              device_ids: reviewed.eligible_devices.map((d) => d.device_id),
              excluded_count: reviewed.excluded_devices.length,
            },
          }
        : {}),
    }),
  );
}
function persistOperation(operation: DeploymentOperation): DeploymentOperation {
  const raw = JSON.stringify(operation);
  if (!withinSize(raw))
    throw Error(
      "This deployment request is too large to preserve safely in browser storage. Reduce its target list before sending it.",
    );
  const registry = readDeploymentRegistry(operation.actor_id);
  if (registry.errors.length) throw Error(registry.errors[0].message);
  const key = operationKey(operation);
  let registryFailure = "";
  try {
    // Individual keys prevent concurrent tabs from replacing one another's list.
    // This is a conservative capacity check, not an atomic cross-tab lock.
    if (storedKeys(operation.actor_id).length >= maxOperations)
      throw Error(capacityFailure);
    if (localStorage.getItem(key) !== null)
      throw Error(
        "A request with this identity is already saved. Review it before sending another.",
      );
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw Error(storageFailure);
    if (storedKeys(operation.actor_id).length > maxOperations)
      throw Error(capacityFailure);
    // Once visible to another tab, even this caller's unsent intent may have
    // been retried there. Never erase it automatically after a failed check.
    const current = readDeploymentRegistry(operation.actor_id);
    if (current.errors.length) {
      registryFailure = current.errors[0].message;
      throw Error(registryFailure);
    }
  } catch {
    changed();
    // The caller has not posted anything yet. Any record left by a failed
    // verification/removal stays visible and can safely be checked or dismissed.
    let full = false;
    try {
      full = storedKeys(operation.actor_id).length >= maxOperations;
    } catch {
      /* Storage remains unavailable. */
    }
    throw Error(registryFailure || (full ? capacityFailure : storageFailure));
  }
  changed();
  return parseOperation(raw, operation.actor_id, operation.id)!;
}
export function deploymentOperationAvailable(operation: DeploymentOperation) {
  const registry = readDeploymentRegistry(operation.actor_id);
  if (registry.errors.some((issue) => issue.kind === "unavailable"))
    return false;
  if (!registry.operations.some((saved) => sameOperation(saved, operation)))
    return false;
  try {
    const durable = parseOperation(
      localStorage.getItem(operationKey(operation)),
      operation.actor_id,
      operation.id,
    );
    return !!durable && sameOperation(durable, operation);
  } catch {
    return false;
  }
}

/** Explicit removal affects only the unchanged bytes from this exact review. */
export function dismissDeploymentStorageIssue(issue: DeploymentStorageIssue) {
  const snapshots = invalidRecords.get(issue);
  if (!snapshots)
    throw Error("Refresh the saved requests before dismissing this reminder.");
  try {
    // Preflight every alias before removing any; session first avoids a later
    // legacy read resurrecting a durable copy after a partial cleanup failure.
    for (const snapshot of snapshots) {
      const storage =
        snapshot.storage === "local" ? localStorage : sessionStorage;
      const current = storage.getItem(snapshot.key);
      if (current !== null && current !== snapshot.raw)
        throw Error(cleanupFailure);
    }
    for (const snapshot of snapshots) {
      const storage =
        snapshot.storage === "local" ? localStorage : sessionStorage;
      const current = storage.getItem(snapshot.key);
      if (current !== null && current !== snapshot.raw)
        throw Error(cleanupFailure);
      if (current !== null) storage.removeItem(snapshot.key);
      if (storage.getItem(snapshot.key) !== null) throw Error(cleanupFailure);
    }
  } catch {
    changed();
    throw Error(cleanupFailure);
  }
  changed();
}
export function finishDeploymentOperation(operation: DeploymentOperation) {
  try {
    const key = operationKey(operation);
    const raw = localStorage.getItem(key);
    const saved = parseOperation(raw, operation.actor_id, operation.id);
    if (raw !== null && (!saved || !sameOperation(saved, operation)))
      throw Error(cleanupFailure);
    // A failed session-storage read must not conceal a legacy copy which could
    // otherwise migrate back after the durable record is removed.
    const legacy = parseOperation(
      sessionStorage.getItem(legacyKey(operation.actor_id)),
      operation.actor_id,
    );
    if (legacy?.id === operation.id) {
      if (!sameOperation(legacy, operation)) throw Error(cleanupFailure);
      sessionStorage.removeItem(legacyKey(operation.actor_id));
      if (sessionStorage.getItem(legacyKey(operation.actor_id)) !== null)
        throw Error(cleanupFailure);
    }
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw Error(cleanupFailure);
  } catch {
    changed();
    throw Error(cleanupFailure);
  }
  setDeploymentRequestActive(operation, false);
  changed();
}

const leaseSchema = z
  .object({
    token: z.string().uuid(),
    issued_at: z.number().int().safe(),
    expires_at: z.number().int().safe(),
  })
  .strict();
function readLease(operation: DeploymentOperation) {
  try {
    const raw = localStorage.getItem(leaseKey(operation));
    if (!raw || raw.length > 512) return null;
    const parsed = leaseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const lease = parsed.data,
      now = Date.now();
    // Clock jumps and corrupt far-future leases must not hide a reminder forever.
    return lease.issued_at <= now &&
      lease.expires_at > now &&
      lease.expires_at - lease.issued_at <= leaseDuration &&
      lease.expires_at - now <= leaseDuration
      ? lease
      : null;
  } catch {
    return null;
  }
}
export function isDeploymentRequestActive(
  operation: DeploymentOperation,
): boolean {
  return active.has(operationKey(operation)) || !!readLease(operation);
}
function releaseClaim(claim: ActiveClaim) {
  const key = operationKey(claim.operation);
  if (active.get(key) !== claim) return;
  active.delete(key);
  clearInterval(claim.timer);
  try {
    const raw = localStorage.getItem(leaseKey(claim.operation));
    if (raw && JSON.parse(raw).token === claim.token)
      localStorage.removeItem(leaseKey(claim.operation));
  } catch {
    /* The bounded hint expires; the durable request is unaffected. */
  }
  if (!active.size) window.removeEventListener("pagehide", releaseOnPageHide);
}
export function releaseDeploymentRequestLeases(actor?: string) {
  for (const claim of active.values())
    if (actor === undefined || claim.operation.actor_id === actor)
      releaseClaim(claim);
  changed();
}
function releaseOnPageHide() {
  releaseDeploymentRequestLeases();
}
function renewClaim(claim: ActiveClaim) {
  if (active.get(operationKey(claim.operation)) !== claim) return;
  if (!deploymentOperationAvailable(claim.operation)) {
    releaseClaim(claim);
    changed();
    return;
  }
  const lease = readLease(claim.operation);
  if (lease && lease.token !== claim.token) {
    releaseClaim(claim);
    changed();
    return;
  }
  try {
    const now = Date.now();
    localStorage.setItem(
      leaseKey(claim.operation),
      JSON.stringify({
        token: claim.token,
        issued_at: now,
        expires_at: now + leaseDuration,
      }),
    );
  } catch {
    /* Activity hints are best effort. Server idempotency is authoritative. */
  }
}
export function setDeploymentRequestActive(
  operation: DeploymentOperation,
  value: boolean,
): boolean {
  const key = operationKey(operation);
  let acquired: ActiveClaim | undefined;
  if (value) {
    if (isDeploymentRequestActive(operation)) return false;
    if (!deploymentOperationAvailable(operation)) return false;
    const claim: ActiveClaim = {
      operation,
      token: crypto.randomUUID(),
      timer: undefined as unknown as ReturnType<typeof setInterval>,
    };
    acquired = claim;
    active.set(key, claim);
    claim.timer = setInterval(() => renewClaim(claim), 10_000);
    window.addEventListener("pagehide", releaseOnPageHide);
    renewClaim(claim);
  } else {
    const claim = active.get(key);
    if (claim) releaseClaim(claim);
  }
  changed();
  return !value || active.get(key) === acquired;
}
export function subscribeDeploymentOperations(
  actor: string,
  refresh: () => void,
) {
  const storage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key?.startsWith(actorPrefix(actor)) ||
      event.key?.startsWith(`${leasePrefix}${encodeURIComponent(actor)}:`) ||
      event.key === legacyKey(actor)
    )
      refresh();
  };
  window.addEventListener(eventName, refresh);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  // A crashed tab cannot dispatch a final storage event when its hint expires.
  const timer = setInterval(refresh, 5_000);
  return () => {
    clearInterval(timer);
    window.removeEventListener(eventName, refresh);
    window.removeEventListener("storage", storage);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("pageshow", refresh);
  };
}
export function useDeploymentOperation(actor: string) {
  const [, update] = useState(0);
  useEffect(
    () =>
      subscribeDeploymentOperations(actor, () => update((value) => value + 1)),
    [actor],
  );
  const { operations, errors } = readDeploymentRegistry(actor);
  const operation = operations[0] || null;
  return {
    operations,
    errors,
    refresh: () => update((value) => value + 1),
    pendingOperations: operations.filter(
      (op) => !isDeploymentRequestActive(op),
    ),
    operation,
    active: !!operation && isDeploymentRequestActive(operation),
  };
}
// Only for non-keyed pause/resume/cancel attempts. Never use an error response
// to clear durable create/rollback intent shared with other tabs.
export function isDeploymentActionRejection(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.serverRejection &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    ![
      "INVALID_RESPONSE",
      "UNSAFE_NUMBER",
      "CONTRACT_MISMATCH",
      "IDEMPOTENCY_CONFLICT",
    ].includes(error.code)
  );
}
