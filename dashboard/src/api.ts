import { z } from "zod";
import { assertExactNumbers, stringifyExactJSON } from "./configurationNumbers";
import { RollbackPreviewSchema } from "./rollbackReview";
import { AssignmentRemovalPreviewSchema } from "./assignmentRemovalModel";
import { ScheduledAssignmentRefreshPreviewSchema } from "./scheduledAssignmentRefreshModel";
import {
  MfaConfirmSchema,
  MfaDisableSchema,
  MfaSetupSchema,
  MfaStatusSchema,
} from "./mfaActionModel";

export class APIError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public serverRejection = false,
  ) {
    super(message);
  }
}
// Shape validation cannot establish which record a singleton response belongs
// to. Check the raw envelope even when a caller supplies a projection schema.
function assertResponseIdentity(path: string, method: string, value: unknown) {
  const route = path.split("?")[0];
  let match: RegExpMatchArray | null = null;
  let field = "id";
  let resource = "device details";
  if (method === "GET") {
    match = route.match(/^\/devices\/([^/]+)(\/telemetry)?$/);
    if (match?.[2]) {
      field = "device_id";
      resource = "device metrics";
    }
    if (!match) {
      match = route.match(/^\/versions\/([^/]+)$/);
      resource = "pipeline version details";
    }
    if (
      !match &&
      ![
        "/configurations/library",
        "/configurations/requests",
        "/configurations/publish-requests",
      ].includes(route)
    ) {
      match = route.match(/^\/configurations\/([^/]+)$/);
      resource = "pipeline details";
    }
  } else if (method === "POST") {
    match = route.match(/^\/devices\/([^/]+)\/retry$/);
  }
  if (!match) return;
  let expected: string | undefined;
  try {
    expected = decodeURIComponent(match[1]);
  } catch {
    // Invalid path encodings cannot establish a requested identity.
  }
  const actual =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[field]
      : undefined;
  if (!expected || typeof actual !== "string" || actual !== expected)
    throw new APIError(
      "IDENTITY_MISMATCH",
      `The returned ${resource} do not match the requested record. Refresh to load the correct details.`,
      502,
    );
}
let csrf = "";
let csrfVersion = 0;
let sessionValid = true;
let sessionEpoch = 0;
const sessionInterruptions = new Set<(error: APIError) => void>();
export function isSessionValid() {
  return sessionValid;
}
export function getSessionEpoch() {
  return sessionEpoch;
}
function sessionFailure() {
  return new APIError(
    "SESSION_ENDED",
    "Your session ended. Your local work is still here. Sign in again before making another request.",
    0,
  );
}
function changeSessionValidity(valid: boolean) {
  sessionValid = valid;
  sessionEpoch++;
  for (const interrupt of [...sessionInterruptions])
    interrupt(sessionFailure());
}
export function invalidateSession() {
  if (!sessionValid) return;
  changeSessionValidity(false);
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("vectory:session-ended"));
}
export function getCSRFVersion() {
  return csrfVersion;
}
// Transient request binding only; never persist or log this credential.
export function getCSRFToken() {
  return csrf;
}
export function setCSRF(value: string) {
  // Only authentication/initialization and explicit credential rotation call
  // this setter. Passive session probes must not restore an invalid context.
  if (!!value !== sessionValid) changeSessionValidity(!!value);
  if (csrf === value) return;
  csrf = value;
  csrfVersion++;
  // Notify other tabs without placing credentials in browser storage.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("vectory:session-changed"));
    try {
      window.localStorage?.setItem(
        "vectory-session-change",
        `${Date.now()}-${Math.random()}`,
      );
    } catch {
      /* Focus refresh also works when storage is unavailable. */
    }
  }
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const route = path.split("?")[0];
  const method = (options.method || "GET").toUpperCase();
  const publicRoute = [
    "/status",
    "/session",
    "/login",
    "/login/mfa",
    "/bootstrap",
    "/password-reset",
  ].includes(route);
  if (!publicRoute && !sessionValid) throw sessionFailure();
  const sentCSRF = csrf;
  const sentEpoch = sessionEpoch;
  const controller = new AbortController();
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  const interrupt = (reason: unknown) => {
    rejectInterrupted(reason);
    controller.abort(reason);
  };
  const parentAborted = () => interrupt(options.signal?.reason);
  if (options.signal?.aborted) throw options.signal.reason;
  options.signal?.addEventListener("abort", parentAborted, { once: true });
  if (!publicRoute) sessionInterruptions.add(interrupt);
  async function execute(): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      credentials: "same-origin",
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(sentCSRF ? { "X-CSRF-Token": sentCSRF } : {}),
        ...options.headers,
      },
    });
    const text = await response.text();
    if (!publicRoute && (!sessionValid || sentEpoch !== sessionEpoch))
      throw sessionFailure();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new APIError(
        "INVALID_RESPONSE",
        "The server returned an unreadable response.",
        response.status,
      );
    }
    try {
      assertExactNumbers(data, "response");
    } catch (failure) {
      throw new APIError("UNSAFE_NUMBER", (failure as Error).message, 422);
    }
    if (!response.ok) {
      if (
        response.status === 401 &&
        data?.error?.code === "UNAUTHENTICATED" &&
        sentCSRF &&
        sentCSRF === csrf &&
        !["/login", "/login/mfa", "/bootstrap", "/password-reset"].includes(
          route,
        )
      ) {
        // Keep this request's authoritative401 error, while interrupting every
        // other protected request, including work stalled in response.text().
        sessionInterruptions.delete(interrupt);
        invalidateSession();
      }
      throw new APIError(
        data?.error?.code || "REQUEST_FAILED",
        data?.error?.message || `Request failed (${response.status}).`,
        response.status,
        typeof data?.error?.code === "string" &&
          typeof data?.error?.message === "string",
      );
    }
    const expected = schema || responseSchema(path, method);
    if (expected) {
      const result = expected.safeParse(data);
      if (!result.success)
        throw new APIError(
          "CONTRACT_MISMATCH",
          "The server response does not match this dashboard version.",
          502,
        );
      assertResponseIdentity(path, method, data);
      return result.data as T;
    }
    assertResponseIdentity(path, method, data);
    return data;
  }
  try {
    return await Promise.race([execute(), interrupted]);
  } finally {
    sessionInterruptions.delete(interrupt);
    options.signal?.removeEventListener("abort", parentAborted);
  }
}
export const post = <T = unknown>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: stringifyExactJSON(body) });
export const put = <T = unknown>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
) => api<T>(path, { method: "PUT", body: stringifyExactJSON(body), signal });
// A client deadline stops waiting; it does not establish whether a mutation committed.
export async function withRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 30000,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) throw parentSignal.reason;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(parentSignal?.reason);
      controller.abort(parentSignal?.reason);
    };
    parentSignal?.addEventListener("abort", cancel, { once: true });
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new APIError(
          "REQUEST_TIMEOUT",
          "The response is taking too long. The server may still be processing this request.",
          0,
        ),
      );
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), deadline, canceled]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
  }
}
export const boundedPost = <T = unknown>(
  path: string,
  body: unknown = {},
  timeoutMs = 30000,
) =>
  withRequestDeadline(
    (signal) =>
      api<T>(path, { method: "POST", body: stringifyExactJSON(body), signal }),
    timeoutMs,
  );
export const boundedAPI = <T = unknown>(path: string, timeoutMs = 30000) =>
  withRequestDeadline((signal) => api<T>(path, { signal }), timeoutMs);
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["viewer", "editor", "operator", "admin"]),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
});
export const SessionSchema = z.object({
  user: UserSchema,
  csrf_token: z.string(),
});
export const LoginChallengeSchema = z.object({
  mfa_required: z.literal(true),
  challenge_token: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.iso.datetime({ offset: true }),
});
export const LoginSchema = z.union([SessionSchema, LoginChallengeSchema]);
export type LoginChallenge = z.infer<typeof LoginChallengeSchema>;
export type User = z.infer<typeof UserSchema>;
export type Config = Record<string, any>;
export type Graph = { nodes: any[]; edges: any[] };
export type VariableDeclaration = {
  name: string;
  path: string;
  type: "string" | "integer" | "boolean";
};
export type Configuration = {
  id: string;
  name: string;
  description: string;
  revision: number;
  archived?: boolean;
  archived_at?: string | null;
  graph: Graph;
  config: Config;
  variables?: VariableDeclaration[];
  created_at: string;
  updated_at: string;
};
export type Version = {
  id: string;
  configuration_id: string;
  number: number;
  graph: Graph;
  config: Config;
  variables?: VariableDeclaration[];
  artifact: string;
  sha256: string;
  size: number;
  created_at: string;
  message: string;
  validation: any;
  author_id?: string;
  author?: string;
  source_revision?: number;
};
const publishRevision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const PublishReceiptSchema = z
  .object({
    id: z.string().uuid(),
    configuration_id: z.string().uuid(),
    request_id: z.string().uuid(),
    number: publishRevision,
    source_revision: publishRevision,
    graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }),
    config: z.record(z.string(), z.any()),
    variables: z.array(z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(["string", "integer", "boolean"]),
    })).optional(),
    artifact: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative().max(1048576),
    created_at: z.string().datetime({ offset: true }),
    message: z
      .string()
      .refine((text) => new TextEncoder().encode(text).length <= 2000),
    validation: z.object({ valid: z.literal(true) }).passthrough(),
    author_id: z.string().optional(),
    author: z.string().optional(),
  })
  .passthrough();
export type PublishReceipt = z.infer<typeof PublishReceiptSchema>;
export const PublishRequestLookupSchema = z
  .discriminatedUnion("found", [
    z
      .object({ request_id: z.string().uuid(), found: z.literal(false) })
      .strict(),
    z
      .object({
        request_id: z.string().uuid(),
        found: z.literal(true),
        version: PublishReceiptSchema,
      })
      .strict(),
  ])
  .refine(
    (result) =>
      !result.found || result.request_id === result.version.request_id,
  );
export type PublishRequestLookup = z.infer<typeof PublishRequestLookupSchema>;
export const PublishRequestPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            request_id: z.string().uuid(),
            configuration_id: z.string().uuid(),
            version_id: z.string().uuid(),
            number: publishRevision,
            source_revision: publishRevision,
            created_at: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .max(50),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: publishRevision,
    page_size: z.number().int().min(1).max(50),
  })
  .strict();
export type PublishRequestPage = z.infer<typeof PublishRequestPageSchema>;
export type Assignment = { id: string; priority: number; reason: string };
export type DeploymentPreviewOutcome = {
  device_id: string;
  resource: "configuration" | "policy";
  outcome: "requested" | "higher_priority" | "conflict";
  assignment?: Assignment;
};
export type DeploymentPreview = {
  request_correlation?: boolean;
  devices: Device[];
  conflicts: unknown[];
  warnings: string[];
  outcomes?: DeploymentPreviewOutcome[];
  create_idempotency?: boolean;
  artifact_previews?: {
    device_id: string;
    sha256: string;
    size: number;
  }[];
  blockers?: {
    deployment_id?: string;
    device_ids: string[];
    resource: "configuration" | "policy";
    code:
      | "ACTIVE_CANARY_OVERLAP"
      | "FULL_VECTOR_MODE_REQUIRED"
      | "VECTOR_VERSION_INCOMPATIBLE";
    reason: string;
  }[];
};
export type Device = {
  retry_preconditions?: boolean;
  configuration_attempt?: ConfigurationAttempt;
  reported_apply_state?: string;
  id: string;
  configuration_mode?: "restricted" | "full";
  effective_policy?: Policy;
  name: string;
  os: string;
  arch: string;
  agent_version: string;
  vector_version: string;
  last_seen?: string;
  status: string;
  labels: Record<string, string>;
  desired_generation: number;
  reported_generation: number;
  desired_version_id?: string;
  desired_sha256?: string | null;
  actual_sha256?: string;
  applied_template_sha256?: string;
  secret_revision?: number;
  uses_local_secrets?: boolean;
  apply_state: string;
  sync_paused: boolean;
  local_paused?: boolean;
  pause_acknowledged: boolean;
  telemetry?: {
    sampled_at: string;
    events_per_second?: number | null;
    errors?: number | null;
  };
  assignment?: Assignment;
  policy_assignment?: Assignment;
  created_at: string;
};
export type Group = {
  id: string;
  name: string;
  description: string;
  device_ids: string[];
  revision?: number;
  request_id?: string;
};
export const GroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    device_ids: z.array(z.string()),
    // Older servers remain readable but cannot provide safe editing.
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .passthrough();
export const GroupCreateReceiptSchema = GroupSchema.extend({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type GroupCreateReceipt = z.infer<typeof GroupCreateReceiptSchema>;
export const GroupRequestLookupSchema = z
  .discriminatedUnion("found", [
    z
      .object({ request_id: z.string().uuid(), found: z.literal(false) })
      .strict(),
    z
      .object({
        request_id: z.string().uuid(),
        found: z.literal(true),
        group: GroupCreateReceiptSchema,
      })
      .strict(),
  ])
  .refine(
    (result) => !result.found || result.group.request_id === result.request_id,
  );
export type GroupRequestLookup = z.infer<typeof GroupRequestLookupSchema>;
export const GroupRequestPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            request_id: z.string().uuid(),
            group_id: z.string().uuid(),
            group_name: z
              .string()
              .refine((name) => [...name].length <= 240)
              .nullable(),
            created_at: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .max(50),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    page_size: z.number().int().min(1).max(50),
  })
  .strict();
export type GroupRequestPage = z.infer<typeof GroupRequestPageSchema>;
export type Selector = {
  device_ids: string[];
  group_ids: string[];
  exclude_ids: string[];
};
export type Policy = {
  heartbeat_seconds: number;
  sync_paused: boolean;
  telemetry_enabled: boolean;
};
export const AgentPolicySchema = z
  .object({
    heartbeat_seconds: z.number().int().min(10).max(3600),
    sync_paused: z.boolean(),
    telemetry_enabled: z.boolean(),
  })
  .strict();
const policyRequestId = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const policyName = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= 120 && !value.includes("\0"),
  );
export const SavedPolicySchema = z
  .object({
    id: policyRequestId,
    name: policyName,
    policy: AgentPolicySchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type SavedPolicy = z.infer<typeof SavedPolicySchema>;
export const PolicyCreateReceiptSchema = SavedPolicySchema.extend({
  request_id: policyRequestId,
  create_idempotency: z.literal(true),
}).strict();
export type PolicyCreateReceipt = z.infer<typeof PolicyCreateReceiptSchema>;
export const PolicyRequestLookupSchema = z
  .discriminatedUnion("found", [
    z
      .object({
        create_idempotency: z.literal(true),
        request_id: policyRequestId,
        found: z.literal(false),
      })
      .strict(),
    z
      .object({
        create_idempotency: z.literal(true),
        request_id: policyRequestId,
        found: z.literal(true),
        policy: PolicyCreateReceiptSchema,
      })
      .strict(),
  ])
  .refine(
    (value) => !value.found || value.request_id === value.policy.request_id,
  );
export const PolicyRequestPageSchema = z
  .object({
    create_idempotency: z.literal(true),
    items: z
      .array(
        z
          .object({
            request_id: policyRequestId,
            policy_id: policyRequestId,
            policy_name: z
              .string()
              .refine((value) => [...value].length <= 120)
              .nullable(),
            created_at: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .max(50),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    page_size: z.number().int().min(1).max(50),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.request_id)).size ===
        value.items.length &&
      value.items.length <= value.page_size &&
      value.items.length <= value.total,
  );
export type PolicyRequestPage = z.infer<typeof PolicyRequestPageSchema>;
export type Deployment = {
  request_correlation?: boolean;
  rollback_review?: boolean;
  rollback_idempotency?: boolean;
  id: string;
  name?: string | null;
  version_id?: string | null;
  policy?: Policy | null;
  selector: Selector;
  priority: number;
  target_mode: string;
  status: string;
  scheduled_at?: string | null;
  created_at: string;
  targets: {
    device_id: string;
    state: string;
    generation: number;
    error?: string | null;
  }[];
  rollout: {
    kind: string;
    canary_size: number;
    batch_size: number;
    observation_seconds: number;
    failure_threshold: number;
  };
};
const deploymentUUID = z.string().uuid();
const deploymentUUIDEqual = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
const deploymentSelectorSchema = z.object({
  device_ids: z.array(deploymentUUID),
  group_ids: z.array(deploymentUUID),
  exclude_ids: z.array(deploymentUUID),
});
export const DeploymentReceiptSchema = z
  .object({
    id: deploymentUUID,
    request_id: deploymentUUID,
    operation: z.enum(["create", "rollback"]),
    source_deployment_id: deploymentUUID.nullable(),
    request_correlation: z.literal(true),
    name: z.string().nullable().optional(),
    version_id: deploymentUUID.nullable().optional(),
    policy: z
      .object({
        heartbeat_seconds: z.number().int().min(10).max(3600),
        sync_paused: z.boolean(),
        telemetry_enabled: z.boolean(),
      })
      .nullable()
      .optional(),
    selector: deploymentSelectorSchema,
    priority: z.number().int().min(-1000000).max(1000000),
    target_mode: z.enum(["snapshot", "persistent"]),
    status: z.enum([
      "scheduled",
      "active",
      "paused",
      "completed",
      "cancelled",
      "failed",
      "missed",
      "unassigned",
    ]),
    scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
    created_at: z.string().datetime({ offset: true }),
    targets: z.array(
      z
        .object({
          device_id: deploymentUUID,
          state: z.string(),
          generation: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
          error: z.string().nullable().optional(),
          original: z.boolean().optional(),
        })
        .passthrough(),
    ),
    rollout: z.object({
      kind: z.enum(["all", "canary"]),
      canary_size: z.number().int().min(1).max(10000),
      batch_size: z.number().int().min(1).max(10000),
      observation_seconds: z.number().int().min(0).max(86400),
      failure_threshold: z.number().int().min(0).max(10000),
    }),
    rollback_review: z.boolean().optional(),
    rollback_idempotency: z.boolean().optional(),
  })
  .passthrough()
  .refine((receipt) =>
    receipt.operation === "create"
      ? receipt.source_deployment_id === null
      : receipt.source_deployment_id !== null &&
        !deploymentUUIDEqual(receipt.id, receipt.source_deployment_id),
  );
export type DeploymentReceipt = z.infer<typeof DeploymentReceiptSchema>;
export const DeploymentRequestLookupSchema = z
  .discriminatedUnion("found", [
    z.object({ request_id: deploymentUUID, found: z.literal(false) }).strict(),
    z
      .object({
        request_id: deploymentUUID,
        found: z.literal(true),
        operation: z.enum(["create", "rollback"]),
        source_deployment_id: deploymentUUID.nullable(),
        deployment: DeploymentReceiptSchema,
      })
      .strict(),
  ])
  .refine(
    (response) =>
      !response.found ||
      (deploymentUUIDEqual(
        response.request_id,
        response.deployment.request_id,
      ) &&
        response.operation === response.deployment.operation &&
        (response.source_deployment_id === null
          ? response.deployment.source_deployment_id === null
          : response.deployment.source_deployment_id !== null &&
            deploymentUUIDEqual(
              response.source_deployment_id,
              response.deployment.source_deployment_id,
            ))),
  );
export type DeploymentRequestLookup = z.infer<
  typeof DeploymentRequestLookupSchema
>;
export type DeploymentSummary = Omit<
  Deployment,
  "targets" | "selector" | "name" | "version_id" | "policy" | "scheduled_at"
> & {
  name: string | null;
  version_id: string | null;
  policy: Policy | null;
  scheduled_at: string | null;
  configuration_id: string | null;
  configuration_name: string | null;
  version_number: number | null;
  target_count: number;
  verified_count: number;
  state_counts: Record<string, number>;
  canary_gate?: unknown;
};
export type DeploymentPage = {
  request_history?: boolean;
  items: DeploymentSummary[];
  total: number;
  page: number;
  page_size: number;
};
const boundedCharacters = (limit: number) =>
  z
    .string()
    .refine(
      (value) => [...value].length <= limit,
      `Must contain at most ${limit} characters`,
    );
export const DeploymentRequestSummarySchema = z
  .object({
    request_id: z.string().uuid(),
    operation: z.enum(["create", "rollback"]),
    source_deployment_id: z.string().uuid().nullable(),
    deployment_id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
    deployment_name: boundedCharacters(120).nullable(),
    deployment_status: boundedCharacters(64).nullable(),
    configuration_name: boundedCharacters(240).nullable(),
    version_number: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    resource: z.enum(["configuration", "policy"]),
    scheduled_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .refine(
    (row) =>
      (row.operation === "rollback") === (row.source_deployment_id !== null),
  );
export const DeploymentRequestPageSchema = z
  .object({
    items: z.array(DeploymentRequestSummarySchema).max(50),
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    page_size: z.number().int().min(1).max(50),
  })
  .strict();
export type DeploymentRequestSummary = z.infer<
  typeof DeploymentRequestSummarySchema
>;
export type DeploymentRequestPage = z.infer<typeof DeploymentRequestPageSchema>;
export type DeploymentTarget = Omit<Deployment["targets"][number], "error"> & {
  gate_reason?: unknown;
  device_name: string | null;
  error: string | null;
  original: boolean;
};
export type DeploymentTargetPage = {
  items: DeploymentTarget[];
  total: number;
  page: number;
  page_size: number;
};
export type Audit = {
  id: string;
  actor: string;
  actor_id?: string;
  actor_kind?: "user" | "device" | "system" | "unknown";
  action: string;
  target: string;
  target_name?: string | null;
  target_id?: string | null;
  target_kind?: string;
  target_exists?: boolean;
  device_id?: string | null;
  issue_revision?: number;
  reason?: string;
  outcome: string;
  created_at: string | null;
};
export const AuditSummarySchema = z.object({
  id: z.string(),
  actor_id: z.string(),
  actor: z.string(),
  actor_kind: z.enum(["user", "device", "system", "unknown"]),
  action: z.string(),
  target: z.string(),
  target_id: z.string().nullable(),
  target_exists: z.boolean().optional(),
  target_kind: z.enum([
    "user",
    "device",
    "configuration",
    "deployment",
    "group",
    "policy",
    "token",
    "issue",
    "signing_key",
    "server",
    "unknown",
  ]),
  target_name: z.string().nullable(),
  device_id: z.string().nullable(),
  outcome: z.string(),
  created_at: z.string().nullable(),
  request_id: z.string().nullable(),
});
const auditNumber = z.number().int().nonnegative();
export const AuditDetailsSchema = z.object({
  reason: z.string().optional(),
  previous_group_revision: auditNumber.max(Number.MAX_SAFE_INTEGER).optional(),
  group_revision: auditNumber.max(Number.MAX_SAFE_INTEGER).optional(),
  issue_revision: auditNumber.optional(),
  secret_revision: auditNumber.optional(),
  previous_secret_revision: auditNumber.optional(),
  actual_sha256: z.string().optional(),
  applied_template_sha256: z.string().optional(),
  device_id: z.string().optional(),
  previous_generation: auditNumber.optional(),
  generation: auditNumber.optional(),
  previous_policy_generation: auditNumber.optional(),
  policy_generation: auditNumber.optional(),
  secret_revision_floor: auditNumber.optional(),
  version_id: z.string().optional(),
  sha256: z.string().optional(),
  policy_sha256: z.string().optional(),
  browser_sessions: auditNumber.optional(),
  password_reset_codes: auditNumber.optional(),
  enrollment_tokens_to_revoke: auditNumber.optional(),
  mfa_recovery_codes: auditNumber.optional(),
  previous_device_id: z.string().optional(),
  replacement_device_id: z.string().optional(),
  deployment_id: z.string().optional(),
  previous_signing_key_id: z.string().optional(),
  signing_key_id: z.string().optional(),
});
export const AuditDetailSchema = AuditSummarySchema.extend({
  details: AuditDetailsSchema,
});
export const AuditHistoryPageSchema = z.object({
  items: z.array(AuditSummarySchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
const auditFilterText = (limit: number) =>
  z
    .string()
    .refine(
      (value) => Array.from(value).length <= limit,
      "Audit filter exceeds the supported length",
    );
export const AuditExportFiltersSchema = z.object({
  search: auditFilterText(200).optional(),
  action: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{0,128}$/)
    .optional(),
  family: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{0,128}$/)
    .optional(),
  outcome: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{0,128}$/)
    .optional(),
  actor_id: auditFilterText(128).optional(),
  device_id: z
    .string()
    .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
    .optional(),
  target_id: auditFilterText(256).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export const AuditExportSchema = z.object({
  id: z.string(),
  row_count: z.number().int().nonnegative(),
  byte_count: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  filters: AuditExportFiltersSchema,
  created_at: z.string(),
  expires_at: z.string(),
  download_path: z
    .string()
    .regex(/^\/api\/v1\/audit\/exports\/[0-9a-f-]+\/download$/),
});
export type AuditSummary = z.infer<typeof AuditSummarySchema>;
export type AuditDetail = z.infer<typeof AuditDetailSchema>;
export type AuditHistoryPage = z.infer<typeof AuditHistoryPageSchema>;
export type AuditExport = z.infer<typeof AuditExportSchema>;
export const IssueSchema = z.object({
  id: z.string(),
  device_id: z.string(),
  device_name: z.string().nullable(),
  device_revoked: z.boolean().nullable(),
  code: z.string(),
  stage: z.string(),
  message: z.string(),
  count: z.number().int().nonnegative(),
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
  desired_version_id: z.string().nullable(),
  resolved: z.boolean(),
  revision: z.number().int().positive(),
  acknowledged: z.boolean(),
  acknowledged_at: z.string().nullable(),
  acknowledged_by: z.string().nullable(),
  acknowledged_by_name: z.string().nullable(),
  acknowledgement_reason: z.string().nullable(),
  disposition: z.enum(["open", "acknowledged", "resolved"]),
});
export type Issue = z.infer<typeof IssueSchema>;
export const IssueHistoryPageSchema = z.object({
  items: z.array(IssueSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type IssueHistoryPage = z.infer<typeof IssueHistoryPageSchema>;
export type Token = {
  id: string;
  name: string;
  expires_at: string;
  uses: number;
  max_uses?: number | null;
  name_prefix?: string | null;
  revoked: boolean;
  created_at: string;
};
export type Release = {
  name: string;
  os: string;
  arch: string;
  version: string;
  sha256: string;
  size: number;
  url: string;
  signed: boolean;
};
export const ConfigurationAttemptSchema = z
  .object({
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    version_id: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    secret_revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    state: z.enum([
      "desired",
      "downloaded",
      "validated",
      "written",
      "reload_requested",
      "verified_applied",
      "verification_unknown",
      "failed",
      "rolled_back",
      "paused",
    ]),
    error: z
      .object({
        code: z.string().min(1).max(128),
        stage: z.string().min(1).max(128),
        message: z.string().max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConfigurationAttempt = z.infer<typeof ConfigurationAttemptSchema>;
export const DeviceSchema = z
  .object({
    id: z.string(),
    configuration_mode: z.enum(["restricted", "full"]).default("restricted"),
    effective_policy: z
      .object({
        heartbeat_seconds: z.number().int().min(10).max(3600),
        sync_paused: z.boolean(),
        telemetry_enabled: z.boolean(),
      })
      .strict()
      .optional(),
    assignment: z
      .object({
        id: z.string().uuid(),
        priority: z.number().int(),
        reason: z.string(),
      })
      .optional(),
    policy_assignment: z
      .object({
        id: z.string().uuid(),
        priority: z.number().int(),
        reason: z.string(),
      })
      .optional(),
    name: z.string(),
    status: z.string(),
    apply_state: z.string(),
    reported_apply_state: z.string().optional(),
    configuration_attempt: ConfigurationAttemptSchema.optional(),
    desired_generation: z.number(),
    reported_generation: z.number(),
    desired_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  })
  .passthrough();
export const ConfigurationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    archived: z.boolean().default(false),
    archived_at: z.string().nullable().optional(),
    config: z.record(z.string(), z.unknown()),
    variables: z.array(z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(["string", "integer", "boolean"]),
    })).optional(),
    graph: z.object({
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
    }),
  })
  .passthrough();
// A creation receipt identifies the existing result; replay may return a later
// edited or archived draft, so revision/name/config must not match the intent.
export const PipelineCreateReceiptSchema = ConfigurationSchema.extend({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  description: z.string(),
  revision: publishRevision,
  graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }),
  config: z.record(z.string(), z.any()),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  archived: z.boolean(),
  archived_at: z.string().datetime({ offset: true }).nullable(),
});
export type PipelineCreateReceipt = z.infer<typeof PipelineCreateReceiptSchema>;
const pipelineRequestOrigin = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    source_configuration_id: z.null(),
    source_revision: z.null(),
  }),
  z.object({
    operation: z.literal("duplicate"),
    source_configuration_id: z.string().uuid(),
    source_revision: publishRevision,
  }),
]);
export const PipelineRequestLookupSchema = z
  .discriminatedUnion("found", [
    z
      .object({ request_id: z.string().uuid(), found: z.literal(false) })
      .strict(),
    z
      .object({
        request_id: z.string().uuid(),
        found: z.literal(true),
        operation: z.enum(["create", "duplicate"]),
        source_configuration_id: z.string().uuid().nullable(),
        source_revision: publishRevision.nullable(),
        configuration: PipelineCreateReceiptSchema,
      })
      .strict(),
  ])
  .refine(
    (result) =>
      !result.found ||
      (result.request_id === result.configuration.request_id &&
        pipelineRequestOrigin.safeParse(result).success &&
        result.configuration.id !== result.source_configuration_id),
  );
export type PipelineRequestLookup = z.infer<typeof PipelineRequestLookupSchema>;
export const PipelineRequestPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            request_id: z.string().uuid(),
            operation: z.enum(["create", "duplicate"]),
            source_configuration_id: z.string().uuid().nullable(),
            source_revision: publishRevision.nullable(),
            configuration_id: z.string().uuid(),
            configuration_name: z
              .string()
              .refine((value) => [...value].length <= 240)
              .nullable(),
            created_at: z.string().datetime({ offset: true }),
          })
          .strict()
          .refine(
            (item) =>
              pipelineRequestOrigin.safeParse(item).success &&
              item.configuration_id !== item.source_configuration_id,
          ),
      )
      .max(50),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: publishRevision,
    page_size: z.number().int().min(1).max(50),
  })
  .strict();
export type PipelineRequestPage = z.infer<typeof PipelineRequestPageSchema>;
export const listSchema = (schema: z.ZodType) => z.array(schema);
export const PipelineSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  component_counts: z.object({
    sources: z.number().int().nonnegative(),
    transforms: z.number().int().nonnegative(),
    sinks: z.number().int().nonnegative(),
  }),
  latest_version: z
    .object({
      id: z.string(),
      number: z.number().int().positive(),
      created_at: z.string(),
      // Additive: absent from servers before the library status fields.
      author: z.string().nullable().optional(),
      draft_changed: z.boolean().optional(),
    })
    .nullable(),
  assigned_devices: z.number().int().nonnegative().optional(),
});
export const PipelineLibraryPageSchema = z.object({
  items: z.array(PipelineSummarySchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type PipelineSummary = z.infer<typeof PipelineSummarySchema>;
export type PipelineLibraryPage = z.infer<typeof PipelineLibraryPageSchema>;
const metricSchema = z.number().min(0).max(1e15).nullable().optional();
const telemetrySchema = z
  .object({
    sampled_at: z.string(),
    events_per_second: metricSchema,
    errors: metricSchema,
    uptime_seconds: metricSchema,
    memory_bytes: metricSchema,
    cpu_seconds: metricSchema,
    discarded_events: metricSchema,
    buffer_bytes: metricSchema,
    components: z
      .array(
        z.object({
          id: z.string().max(100),
          type: z.string().max(100).optional(),
          events_per_second: metricSchema,
          errors: metricSchema,
          discarded_events: metricSchema,
          buffer_bytes: metricSchema,
        }),
      )
      .max(50)
      .optional(),
  })
  .passthrough();
function responseSchema(path: string, method: string): z.ZodType | undefined {
  path = path.split("?")[0];
  if (path === "/policies/requests" && method === "GET")
    return PolicyRequestPageSchema;
  if (/^\/policies\/requests\/[^/]+$/.test(path) && method === "GET")
    return PolicyRequestLookupSchema;
  if (path === "/configurations/requests" && method === "GET")
    return PipelineRequestPageSchema;
  if (/^\/configurations\/requests\/[^/]+$/.test(path) && method === "GET")
    return PipelineRequestLookupSchema;
  if (path === "/configurations/publish-requests" && method === "GET")
    return PublishRequestPageSchema;
  if (
    /^\/configurations\/publish-requests\/[^/]+$/.test(path) &&
    method === "GET"
  )
    return PublishRequestLookupSchema;
  if (/^\/deployments\/[^/]+\/rollback-preview$/.test(path) && method === "GET")
    return RollbackPreviewSchema;
  if (path === "/groups/requests" && method === "GET")
    return GroupRequestPageSchema;
  if (/^\/groups\/requests\/[^/]+$/.test(path) && method === "GET")
    return GroupRequestLookupSchema;
  if (path === "/groups")
    return method === "POST" ? GroupSchema : z.array(GroupSchema);
  if (/^\/groups\/[^/]+$/.test(path)) return GroupSchema;
  if (path === "/login") return LoginSchema;
  if (path === "/mfa" && method === "GET") return MfaStatusSchema;
  if (path === "/mfa/setup" && method === "POST") return MfaSetupSchema;
  if (path === "/mfa/confirm" && method === "POST") return MfaConfirmSchema;
  if (path === "/mfa/disable" && method === "POST") return MfaDisableSchema;
  if (path === "/deployments/requests" && method === "GET")
    return DeploymentRequestPageSchema;
  if (path === "/audit/history") return AuditHistoryPageSchema;
  if (path === "/audit/exports" && method === "POST") return AuditExportSchema;
  if (path === "/audit/exports" && method === "GET")
    return z.array(AuditExportSchema).max(2);
  if (/^\/audit\/[^/]+$/.test(path) && method === "GET")
    return AuditDetailSchema;
  if (/^\/issues\/[^/]+\/(acknowledge|reopen)$/.test(path)) return IssueSchema;
  if (path === "/issues/history") return IssueHistoryPageSchema;
  if (path === "/issues") return z.array(IssueSchema);
  if (/^\/issues\/[^/]+$/.test(path)) return IssueSchema;
  if (
    path === "/session" ||
    path === "/login/mfa" ||
    path === "/bootstrap" ||
    path === "/account/password"
  )
    return SessionSchema;
  if (
    (path === "/users" && method === "POST") ||
    (/^\/users\/[^/]+$/.test(path) && method === "PUT")
  )
    return UserSchema;
  if (/^\/users\/[^/]+\/password-reset$/.test(path))
    return z.object({ code: z.string(), expires_at: z.string() });
  if (path === "/status")
    return z.object({ initialized: z.boolean(), version: z.string() });
  if (
    (path === "/configurations" && method === "POST") ||
    (/^\/configurations\/[^/]+\/(draft|duplicate|archive|unarchive|restore)$/.test(
      path,
    ) &&
      method !== "GET")
  )
    return ConfigurationSchema;
  if (method === "POST" && /^\/devices\/[^/]+\/retry$/.test(path))
    return DeviceSchema;
  if (
    method === "POST" &&
    /^\/deployments\/[^/]+\/unassign-preview$/.test(path)
  )
    return AssignmentRemovalPreviewSchema;
  if (method === "POST" && /^\/deployments\/[^/]+\/refresh-preview$/.test(path))
    return ScheduledAssignmentRefreshPreviewSchema;
  if (method !== "GET") return undefined;
  if (/^\/deployments\/requests\/[^/]+$/.test(path))
    return DeploymentRequestLookupSchema;
  if (path === "/devices") return z.array(DeviceSchema);
  if (/^\/devices\/[^/]+\/telemetry$/.test(path))
    return z.object({
      device_id: z.string(),
      samples: z.array(telemetrySchema).max(120),
    });
  if (/^\/devices\/[^/]+$/.test(path)) return DeviceSchema;
  if (path === "/configurations") return z.array(ConfigurationSchema);
  if (path === "/configurations/library") return PipelineLibraryPageSchema;
  if (/^\/configurations\/[^/]+\/history$/.test(path))
    return z.object({
      items: z.array(
        z
          .object({
            id: z.string(),
            configuration_id: z.string(),
            created_at: z.string(),
          })
          .passthrough(),
      ),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      page_size: z.number().int().positive(),
    });
  if (/^\/configurations\/[^/]+\/revisions\/[^/]+$/.test(path))
    return z
      .object({
        id: z.string(),
        configuration_id: z.string(),
        revision: z.number(),
        config: z.record(z.string(), z.unknown()),
        graph: z.object({
          nodes: z.array(z.unknown()),
          edges: z.array(z.unknown()),
        }),
      })
      .passthrough();
  if (/^\/configurations\/[^/]+$/.test(path)) return ConfigurationSchema;
  if (path === "/users") return z.array(UserSchema);
  const record = z.object({ id: z.string() }).passthrough();
  if (
    ["/deployments", "/policies", "/tokens", "/issues", "/audit"].includes(path)
  )
    return z.array(record);
  if (/^\/configurations\/[^/]+\/(versions|revisions)$/.test(path))
    return z.array(record);
  if (path === "/releases")
    return z.array(
      z
        .object({
          name: z.string(),
          os: z.string(),
          arch: z.string(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          url: z.string(),
          signed: z.boolean(),
        })
        .passthrough(),
    );
  return undefined;
}
export function can(user: User, permission: "edit" | "operate" | "admin") {
  if (!sessionValid) return false;
  return permission === "admin"
    ? user.role === "admin"
    : permission === "operate"
      ? ["operator", "admin"].includes(user.role)
      : ["editor", "admin"].includes(user.role);
}
export function when(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unavailable"
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function ago(value?: string | null) {
  if (!value) return "Never connected";
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  return diff < 60000
    ? "Just now"
    : diff < 3600000
      ? `${Math.floor(diff / 60000)}m ago`
      : diff < 86400000
        ? `${Math.floor(diff / 3600000)}h ago`
        : `${Math.floor(diff / 86400000)}d ago`;
}
export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
