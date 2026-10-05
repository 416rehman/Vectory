import { useEffect, useState } from "react";
import { z } from "zod";
import { assertExactNumbers } from "./configurationNumbers";
import { APIError } from "./api";
import {
  credentialPreflightMessage,
  findPlainCredential,
} from "./credentialFields";

// Only a plaintext credential refusal proves the exact immutable payload can
// never be accepted, including by an earlier same-key POST in another tab.
// Other refusals describe this attempt, not necessarily that earlier one.
export function isDefinitivePipelineCreationRejection(
  failure: unknown,
  sent: boolean,
): failure is APIError {
  return (
    sent &&
    failure instanceof APIError &&
    failure.serverRejection &&
    failure.status === 400 &&
    failure.code === "INVALID_INPUT" &&
    failure.reason === "plaintext_credential"
  );
}

export type PipelineCreationRefusalProblem = {
  path: string;
  message: string;
};

/** Only project bounded, field-level diagnostics from the server refusal. */
export function pipelineCreationRefusalProblems(
  failure: unknown,
): PipelineCreationRefusalProblem[] {
  if (!(failure instanceof APIError) || !Array.isArray(failure.problems))
    return [];
  return failure.problems
    .slice(0, 20)
    .filter(
      (problem): problem is Record<string, unknown> =>
        !!problem && typeof problem === "object" && !Array.isArray(problem),
    )
    .filter(
      (problem) =>
        typeof problem.path === "string" &&
        problem.path.length <= 300 &&
        typeof problem.message === "string" &&
        problem.message.length <= 500,
    )
    .map((problem) => ({
      path: problem.path as string,
      message: problem.message as string,
    }));
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** The server limits the saved pipeline name by UTF-8 bytes, not input characters. */
export function pipelineNameError(name: string): string {
  const savedName = name.trim();
  if (!savedName) return "Enter a pipeline name to create a draft.";
  if (bytes(savedName) > 120)
    return "This name is too long. Shorten it to fit within 120 UTF-8 bytes.";
  return "";
}
export function pipelineCopyName(name: string) {
  let prefix = "";
  for (const point of name) {
    if (bytes(prefix + point) > 115) break;
    prefix += point;
  }
  return `${prefix} copy`;
}
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const actorSchema = z.string().min(1).max(128);
const metadata = {
  name: z
    .string()
    .refine(
      (v) => v.trim().length > 0 && bytes(v) <= 120,
      "Use a pipeline name of at most 120 UTF-8 bytes.",
    ),
  description: z
    .string()
    .refine(
      (v) => bytes(v) <= 2000,
      "Use a description of at most 2000 UTF-8 bytes.",
    ),
};
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const variableDeclaration = z
  .object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["string", "integer", "boolean"]),
  })
  .strict();
const createFields = {
  ...metadata,
  config: z.custom<Record<string, any>>(
    (v) => !!v && typeof v === "object" && !Array.isArray(v),
  ),
  graph: z
    .object({
      nodes: z.array(z.unknown()).max(1000),
      edges: z.array(z.unknown()).max(5000),
    })
    .strict(),
  variables: z.array(variableDeclaration).max(64).optional(),
};
const duplicateFields = { ...metadata, revision };
const inputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      request: z.object(createFields).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("duplicate"),
      source_configuration_id: uuid,
      request: z.object(duplicateFields).strict(),
    })
    .strict(),
]);
const common = {
  actor_id: actorSchema,
  id: uuid,
  recorded_at: z.string().datetime(),
};
const operationSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        ...common,
        operation: z.literal("create"),
        source_configuration_id: z.null(),
        request: z.object({ ...createFields, request_id: uuid }).strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        operation: z.literal("duplicate"),
        source_configuration_id: uuid,
        request: z.object({ ...duplicateFields, request_id: uuid }).strict(),
      })
      .strict(),
  ])
  .refine((op) => op.id === op.request.request_id);
export type PipelineCreationInput = z.infer<typeof inputSchema>;
export type PipelineCreationOperation = z.infer<typeof operationSchema>;
// JSON-only input and exact numbers prevent silent coercion during durable replay.
function exactJSON(value: unknown, depth = 0): void {
  if (depth > 100)
    throw Error("Pipeline data is nested too deeply to retain safely.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    assertExactNumbers(value);
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw Error("Pipeline data must contain only JSON values.");
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i))
        throw Error("Pipeline arrays cannot contain missing entries.");
      exactJSON(value[i], depth + 1);
    }
  } else for (const child of Object.values(value)) exactJSON(child, depth + 1);
}
function validatedBody(request: unknown) {
  exactJSON(request);
  const raw = JSON.stringify(request);
  if (bytes(raw) > 1048576)
    throw Error(
      "The pipeline request exceeds the 1 MiB request limit. Reduce its content before sending.",
    );
  return raw;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export type PipelineCreationStorageIssue = {
  actor_id: string;
  id?: string;
  kind: "unavailable" | "corrupt" | "capacity";
  message: string;
};
export type PipelineCreationOperations = {
  operations: PipelineCreationOperation[];
  errors: PipelineCreationStorageIssue[];
};

const prefix = "vectory:pipeline-creation:";
const eventName = "vectory:pipeline-creation-request";
const maxBytes = 2_097_152;
const maxRecords = 10;
const actorPrefix = (actor: string) => `${prefix}${encodeURIComponent(actor)}:`;
const keyFor = (
  operation: Pick<PipelineCreationOperation, "actor_id" | "id">,
) => `${actorPrefix(operation.actor_id)}${operation.id}`;
const cache = new Map<
  string,
  { raw: string; operation: PipelineCreationOperation }
>();
// Raw corrupt data stays private to an exact-read dismissal, never sent to the API.
const invalidRecords = new WeakMap<
  PipelineCreationStorageIssue,
  { key: string; raw: string }
>();
const storageError =
  "Browser storage is unavailable. Enable local storage before creating a pipeline so a lost response can be recovered after closing this tab.";
const capacityError =
  "Review the saved pipeline requests before creating another. This browser retains up to ten requests per account.";
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
    validatedBody(result.data.request);
    const operation = freeze(result.data);
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(key, { raw, operation });
    return operation;
  } catch {
    return null;
  }
}
function equivalent(
  left: PipelineCreationOperation,
  right: PipelineCreationOperation,
) {
  const a = operationSchema.safeParse(left),
    b = operationSchema.safeParse(right);
  return a.success && b.success && canonical(a.data) === canonical(b.data);
}

export function readPipelineCreationOperations(
  actor: string,
): PipelineCreationOperations {
  const result: PipelineCreationOperations = { operations: [], errors: [] };
  if (!actorSchema.safeParse(actor).success) {
    result.errors.push({
      actor_id: actor,
      kind: "unavailable",
      message: "Sign in again before reviewing saved pipeline requests.",
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
        const issue: PipelineCreationStorageIssue = {
          actor_id: actor,
          ...(uuid.safeParse(id).success ? { id } : {}),
          kind: "corrupt",
          message:
            "A saved pipeline request cannot be read safely. Check its server result or your recent pipeline requests before dismissing this browser reminder.",
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

export function beginPipelineCreationOperation(
  actor: string,
  request: PipelineCreationInput,
): PipelineCreationOperation {
  exactJSON(request);
  const input = inputSchema.safeParse(request);
  if (!input.success)
    throw Error(
      input.error.issues[0]?.message ||
        "Review the pipeline details before creating it.",
    );
  const payload = input.data.request;
  const credential =
    findPlainCredential(payload.name, ["name"]) ||
    findPlainCredential(payload.description, ["description"]) ||
    (input.data.operation === "create"
      ? findPlainCredential(input.data.request.config) ||
        findPlainCredential(input.data.request.graph, ["graph"]) ||
        findPlainCredential(input.data.request.variables || [], ["variables"])
      : null);
  if (credential) throw Error(credentialPreflightMessage(credential));
  if (!actorSchema.safeParse(actor).success)
    throw Error("Sign in again before creating a pipeline.");
  const id = crypto.randomUUID();
  const operation = operationSchema.parse({
    actor_id: actor,
    id,
    recorded_at: new Date().toISOString(),
    operation: input.data.operation,
    source_configuration_id:
      input.data.operation === "duplicate"
        ? input.data.source_configuration_id
        : null,
    request: { ...input.data.request, request_id: id },
  });
  validatedBody(operation.request);
  const raw = JSON.stringify(operation),
    key = keyFor(operation);
  if (!withinSize(raw))
    throw Error(
      "This pipeline request is too large to retain safely. Reduce its content before sending.",
    );
  const current = readPipelineCreationOperations(actor);
  if (current.errors.length) throw Error(current.errors[0].message);
  if (current.operations.length)
    throw Error(
      "Review the saved pipeline requests before creating another pipeline.",
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

export function pipelineCreationOperationAvailable(
  operation: PipelineCreationOperation,
) {
  const current = readPipelineCreationOperations(operation.actor_id);
  return (
    !current.errors.some((issue) => issue.kind === "unavailable") &&
    current.operations.some((saved) => equivalent(saved, operation))
  );
}
export function finishPipelineCreationOperation(
  operation: PipelineCreationOperation,
) {
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
export function dismissPipelineCreationStorageIssue(
  issue: PipelineCreationStorageIssue,
) {
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

export function subscribePipelineCreationOperations(
  actor: string,
  refresh: () => void,
) {
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
export function usePipelineCreationOperations(actor: string) {
  const [, refresh] = useState(0);
  useEffect(
    () =>
      subscribePipelineCreationOperations(actor, () =>
        refresh((value) => value + 1),
      ),
    [actor],
  );
  return readPipelineCreationOperations(actor);
}

export function pipelineCreationPath(op: PipelineCreationOperation) {
  return op.operation === "create"
    ? "/configurations"
    : `/configurations/${op.source_configuration_id}/duplicate`;
}
export function assertPipelineCreationResult(
  op: PipelineCreationOperation,
  result: {
    request_id: string;
    operation: "create" | "duplicate";
    source_configuration_id: string | null;
    source_revision: number | null;
    configuration: { request_id: string; id: string };
  },
) {
  if (
    result.request_id !== op.id ||
    result.configuration.request_id !== op.id ||
    result.operation !== op.operation ||
    result.source_configuration_id !== op.source_configuration_id ||
    result.source_revision !==
      (op.operation === "duplicate" ? op.request.revision : null) ||
    result.configuration.id === op.source_configuration_id
  )
    throw Error(
      "The result does not match the saved pipeline request. Check its status before trying again.",
    );
}
