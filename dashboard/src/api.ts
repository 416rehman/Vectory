import { z } from "zod";
import type { DataPlaneSummary } from "./status";
import {
  assertExactNumbers,
  parseLosslessJSON,
  stringifyExactJSON,
} from "./configurationNumbers";

/** Sample and test runs echo event payloads: keep big integers exact. */
const EVENT_PAYLOAD_ROUTES = ["/vrl/test", "/configurations/test"];
import { RollbackPreviewSchema } from "./rollbackReview";
import { AssignmentRemovalPreviewSchema } from "./assignmentRemovalModel";
import { ScheduledAssignmentRefreshPreviewSchema } from "./scheduledAssignmentRefreshModel";
import {
  MfaConfirmSchema,
  MfaDisableSchema,
  MfaSetupSchema,
  MfaStatusSchema,
} from "./mfaActionModel";
import {
  AttemptPageSchema,
  ChannelListSchema,
  ChannelSchema,
  DetectionSchema,
  PreviewSchema,
  TestResultSchema,
} from "./notificationsModel";
import {
  ConfigurationTelemetrySchema,
  DiagnosticsSchema,
  HostRuntimeSchema,
  TelemetryHistorySchema,
  TelemetrySummarySchema,
  VectorLogSummarySchema,
  VersionTelemetrySchema,
  type HostRuntime,
  type TelemetrySample,
  type VectorLogSummary,
} from "./runtimeModel";

export class APIError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public serverRejection = false,
    /** Seconds from a 429 response's Retry-After header. */
    public retryAfter?: number,
    /** GET /session 401 only: why this browser's session ended. */
    public reason?: string,
  ) {
    super(message);
  }
}
/** A protected read or write stopped because the browser session ended. */
export function isSessionInterruption(error: unknown) {
  return (
    error instanceof APIError &&
    (error.code === "SESSION_ENDED" ||
      (error.status === 401 && error.code === "UNAUTHENTICATED"))
  );
}
// Shape validation cannot establish which record a singleton response belongs
// to. Check the raw envelope even when a caller supplies a projection schema.
function assertResponseIdentity(path: string, method: string, value: unknown) {
  const route = path.split("?")[0];
  let match: RegExpMatchArray | null = null;
  let field = "id";
  let resource = "device details";
  if (method === "GET") {
    // The inventory is a list, not the device with ID "inventory".
    match =
      route === "/devices/inventory"
        ? null
        : route.match(/^\/devices\/([^/]+)(\/telemetry)?$/);
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
/**
 * A browser network failure ("Failed to fetch", "Load failed", "NetworkError
 * when attempting to fetch resource.") in words people can act on. It is never
 * a server rejection: a change sent before the connection failed may or may
 * not have been saved. An abort keeps its own reason.
 */
function networkFailure(failure: unknown, method: string, signal: AbortSignal) {
  if (!(failure instanceof TypeError) || signal.aborted) return failure;
  return new APIError(
    "NETWORK_UNAVAILABLE",
    method === "GET"
      ? "Vectory didn't answer. It may be restarting, or the network is down."
      : "Vectory didn't answer, so it isn't known whether this change was saved. It may be restarting, or the network is down.",
    0,
  );
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
    "/invite/preview",
    "/invite/accept",
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
    let response: Response, text: string;
    try {
      response = await fetch(`/api/v1${path}`, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(sentCSRF ? { "X-CSRF-Token": sentCSRF } : {}),
          ...options.headers,
        },
      });
      text = await response.text();
    } catch (failure) {
      throw networkFailure(failure, method, controller.signal);
    }
    if (!publicRoute && (!sessionValid || sentEpoch !== sessionEpoch))
      throw sessionFailure();
    const events = EVENT_PAYLOAD_ROUTES.includes(route);
    let data: any;
    try {
      data = text
        ? events
          ? parseLosslessJSON(text)
          : JSON.parse(text)
        : null;
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
      const message = (failure as Error).message;
      throw new APIError(
        "UNSAFE_NUMBER",
        events
          ? `${message.split(":")[0]}: Vector returned a whole number larger than this browser can show exactly. Nothing was changed.`
          : message,
        422,
      );
    }
    if (!response.ok) {
      if (
        response.status === 401 &&
        data?.error?.code === "UNAUTHENTICATED" &&
        sentCSRF &&
        sentCSRF === csrf &&
        ![
          "/login",
          "/login/mfa",
          "/bootstrap",
          "/password-reset",
          "/invite/preview",
          "/invite/accept",
        ].includes(route)
      ) {
        // Keep this request's authoritative401 error, while interrupting every
        // other protected request, including work stalled in response.text().
        sessionInterruptions.delete(interrupt);
        invalidateSession();
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new APIError(
        data?.error?.code || "REQUEST_FAILED",
        data?.error?.message || `Request failed (${response.status}).`,
        response.status,
        typeof data?.error?.code === "string" &&
          typeof data?.error?.message === "string",
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        typeof data?.error?.reason === "string" ? data.error.reason : undefined,
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
  /** When this sign-in ends; absent from older servers. */
  expires_at: z.string().optional(),
});
/** GET /users rows: the account plus its sign-in security state. */
export const PersonSchema = UserSchema.extend({
  status: z.enum(["invited", "active", "disabled"]).optional(),
  mfa_enabled: z.boolean().optional(),
  last_login_at: z.string().nullable().optional(),
  invite_expires_at: z.string().nullable().optional(),
});
export type Person = z.infer<typeof PersonSchema>;
export const SessionSummarySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  current: z.boolean(),
  created_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  expires_at: z.string(),
  user_agent: z.string().nullable(),
  client_address: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
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
    variables: z
      .array(
        z.object({
          name: z.string(),
          path: z.string(),
          type: z.enum(["string", "integer", "boolean"]),
        }),
      )
      .optional(),
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
export type Assignment = {
  id: string;
  priority: number;
  reason: string;
  /** Display provenance; absent on older servers. */
  name?: string | null;
  target_mode?: string;
  status?: string;
  policy_id?: string | null;
  policy_name?: string | null;
  created_at?: string | null;
  created_by_name?: string | null;
};
/** Names and numbers for an assignment; never selectors, targets or values. */
export type AssignmentDescription = {
  id: string;
  name: string | null;
  resource: "configuration" | "policy";
  priority: number;
  target_mode: string;
  status: string;
  created_at: string | null;
  version_id: string | null;
  version_number: number | null;
  configuration_id: string | null;
  configuration_name: string | null;
  policy: Policy | null;
  policy_id: string | null;
  policy_name: string | null;
  created_by_name?: string | null;
  /** A rollback: the deployment it rolled back. */
  rollback_of?: string | null;
};
export type DeploymentPreviewOutcome = {
  device_id: string;
  resource: "configuration" | "policy";
  outcome: "requested" | "higher_priority" | "conflict" | "replace";
  assignment?: Assignment;
  winner?: AssignmentDescription;
  replaces?: AssignmentDescription;
};
export type PreviewConflict = {
  device_id: string;
  assignment_ids: string[];
  priority: number;
  resource: "configuration" | "policy";
  assignments?: AssignmentDescription[];
};
export type PreviewReplacement = {
  assignment: AssignmentDescription;
  device_ids: string[];
  retires_assignment?: boolean;
};
/** Who a canary rollout releases first, in order, and why. */
export type CanaryPlan = {
  size: number;
  chosen_by_you: boolean;
  device_ids: string[];
  devices: {
    device_id: string;
    device_name: string | null;
    chosen: boolean;
    readiness: "ready" | "no_metrics" | "failing" | "paused" | "away";
    reason: string;
  }[];
};
export type DeploymentPreview = {
  request_correlation?: boolean;
  /** Canary rollouts only: null for others, absent on older servers. */
  canary?: CanaryPlan | null;
  /** The previewed version's pipeline name; older servers omit it. */
  configuration_name?: string | null;
  devices: Device[];
  conflicts: PreviewConflict[];
  warnings: string[];
  outcomes?: DeploymentPreviewOutcome[];
  replacements?: PreviewReplacement[];
  suggested_replaces?: PreviewReplacement[];
  suggested_priority?: number | null;
  /** Everything, at any tier, that keeps a reviewed device from the request. */
  replacements_needed?: PreviewReplacement[];
  winning_priority?: number | null;
  paused_device_ids?: string[];
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
  /** Device secret names bound on the host, from its last check-in. Names only. */
  secret_names?: string[];
  apply_state: string;
  sync_paused: boolean;
  local_paused?: boolean;
  pause_acknowledged: boolean;
  telemetry?: TelemetrySample | null;
  host_runtime?: HostRuntime;
  vector_log_summary?: VectorLogSummary;
  assignment?: Assignment;
  policy_assignment?: Assignment;
  created_at: string;
  /** Current check-in interval; the longer one until a change is acknowledged. */
  check_in_seconds?: number;
  desired_version?: VersionLabel | null;
  /** Last verified managed version; null means the adopted local config. */
  running_version?: (VersionLabel & { generation?: number }) | null;
  /** Data-plane health measured on the running version (newer servers). */
  data_plane?: DataPlaneSummary | null;
  /**
   * What keeps the agent running: a service manager, or none (after setup's
   * single check-in, nothing until the operator runs it). Newer agents.
   */
  service_manager?: "systemd" | "launchd" | "windows" | "none";
  /** Whether Vector runs, from the latest check-in; absent when unknown. */
  vector_running?: boolean;
  /**
   * Its newest version failed, but it verifiably keeps running an earlier one
   * and delivers on it. Present only then; `status` stays what the agent
   * reported.
   */
  held_on_previous_version?: boolean;
  /** `GET /devices/{id}?include=groups` only: its groups by name, at most 100. */
  groups?: DeviceGroups;
  /** `GET /devices/{id}` from servers offering wake-ups. */
  wake?: WakeProjection;
  /** SHA-256 of the running agent build, from the latest check-in. */
  agent_sha256?: string;
  /** The agent's state directory on the host, from the latest check-in. */
  state_dir?: string;
};
/**
 * Whether the device's agent holds a wait right now, so a change reaches it
 * within seconds. What the server knows at that instant; never delivery.
 */
export type WakeProjection = { listening: boolean };
export type VersionLabel = {
  id: string;
  number: number | null;
  configuration_id: string | null;
  configuration_name: string | null;
};
export type Group = {
  id: string;
  name: string;
  description: string;
  device_ids: string[];
  revision?: number;
  request_id?: string;
  /** Group lists from newer servers. */
  member_count?: number;
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
    /** The devices the request chose to release first, when it chose any. */
    canary_device_ids?: string[];
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
      canary_device_ids: z.array(deploymentUUID).max(100).optional(),
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
  /** Applied but not delivering (newer servers); state_counts keeps them as applied. */
  degraded?: number;
  canary_gate?: unknown;
  created_by_name?: string | null;
  policy_id?: string | null;
  policy_name?: string | null;
  rollback_available?: boolean;
  completed_at?: string | null;
  failed_at?: string | null;
  failure_reason?: string | null;
  cancelled_at?: string | null;
  removed_at?: string | null;
  status_before_removal?: string | null;
  status_before_rollback?: string | null;
  rolled_back_at?: string | null;
  rolled_back_by?: string | null;
  rolled_back_to_version?: number | null;
  /** The pipeline the rollback restored; often not this deployment's own. */
  rolled_back_to_configuration_name?: string | null;
  rollback_of?: string | null;
  rollback_of_version?: number | null;
  rollback_of_configuration_name?: string | null;
  replaced_by?: {
    deployment_id: string;
    device_count: number;
    at: string;
    version_number: number | null;
    configuration_name?: string | null;
  }[];
  replaces?: {
    deployment_id: string;
    version_number: number | null;
    configuration_name?: string | null;
    /** The replaced assignment is itself a rollback, running what it restored. */
    rollback?: boolean;
  }[];
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
  released_at?: string | null;
  verified_at?: string | null;
  last_seen?: string | null;
  replaced_by?: string | null;
  diagnostic?: string | null;
  /** The agent's reported failure stage ("validation", "rollback", …). */
  failure_stage?: string | null;
  check_in_seconds?: number | null;
  timeline?: { state: string; at: string }[];
  /** Target pages from servers offering wake-ups (see WakeProjection). */
  wake?: WakeProjection | null;
  /** Verified, but an open data-plane issue says it isn't delivering. */
  delivery?: {
    code: string;
    title: string;
    message?: string | null;
    hint?: string | null;
  } | null;
};
export type RolloutLane = {
  kind: "canary" | "batch" | "all" | "added" | "not_released";
  index: number;
  state: "verified" | "in_progress" | "failed" | "queued" | "stopped";
  released_at: string | null;
  verified_at: string | null;
  /** Someone released this stage before the one ahead of it finished. */
  released_early?: { by_name: string | null; at: string } | null;
  size: number;
  counts: Record<string, number>;
  devices: { device_id: string; device_name: string | null; state: string }[];
  more: number;
};
/** What a canary device delivers: events per second, errors per minute, buffer fill. */
export type CanaryWatchReading = {
  events_in_per_second: number | null;
  events_out_per_second: number | null;
  errors_per_minute: number | null;
  buffer_utilization: number | null;
};
export type CanaryWatchDevice = {
  device_id: string;
  device_name: string | null;
  released_at: string;
  /** Why the gate is not counting this device as verified; null when it is. */
  gate_reason: string | null;
  /** Its latest sample; null when it reports no fresh telemetry. */
  now: (CanaryWatchReading & { sampled_at: string }) | null;
  /** Averages over the minutes before its release; null when there are none. */
  baseline: (CanaryWatchReading & { minutes: number }) | null;
  /** Delivery checks so far against the number the gate needs. */
  samples: { measured: number; needed: number } | null;
};
export type CanaryWatch = {
  window_seconds: number;
  evaluated_at: string;
  devices: CanaryWatchDevice[];
  /** Canary devices beyond the ones listed. */
  more: number;
};
export type RolloutFailure = {
  state: string;
  message: string | null;
  diagnostic: string | null;
  /** Degraded groups: what to do about the delivery problem. */
  fix?: string | null;
  /** The leading finding's code (ADDRESS_IN_USE, VRL_E100, DATA_PLANE_…). */
  code?: string | null;
  /** The component and field it names, when it names them. */
  component_id?: string | null;
  field?: string | null;
  /** Degraded groups: that component's buffer fill (0–1), when reported. */
  buffer_utilization?: number | null;
  count: number;
  /** Every device in the group (bounded); `devices` names the first few. */
  device_ids?: string[];
  devices: { device_id: string; device_name: string | null }[];
};
export type RolloutLanes = {
  deployment_id: string;
  status: string;
  evaluated_at: string;
  stages: RolloutLane[];
  failures: RolloutFailure[];
  removed_count: number;
  check_in_seconds: number | null;
  next_admission_at: string | null;
  /** Canary rollouts with a released canary; absent on older servers. */
  canary_watch?: CanaryWatch | null;
};
export type SavedPolicyListItem = SavedPolicy & {
  revision?: number;
  updated_at?: string;
  applied_device_count?: number;
  /** Given this template before its latest edit; still on the earlier values. */
  outdated_device_count?: number;
  applied_devices?: { id: string; name: string }[];
};
export type GroupMembershipState = {
  assignment_id: string | null;
  assignment_name: string | null;
  version_id: string | null;
  configuration_name: string | null;
  version_number: number | null;
  generation: number;
  policy: Policy | null;
} | null;
export type GroupMembershipPreview = {
  group_id: string;
  revision: number;
  stale: boolean;
  ready: boolean;
  blockers: { code: string; reason: string }[];
  devices: {
    device_id: string;
    device_name: string | null;
    change: "added" | "removed";
    configuration: {
      changed: boolean;
      before: GroupMembershipState;
      after: GroupMembershipState;
      pending: AssignmentDescription | null;
    };
    policy: {
      changed: boolean;
      before: GroupMembershipState;
      after: GroupMembershipState;
      pending: AssignmentDescription | null;
    };
  }[];
};
const membershipState = z
  .object({ assignment_id: z.string().nullable() })
  .passthrough()
  .nullable();
const membershipPart = z
  .object({
    changed: z.boolean(),
    before: membershipState,
    after: membershipState,
    pending: z.object({ id: z.string() }).passthrough().nullable(),
  })
  .passthrough();
const GroupMembershipPreviewSchema = z
  .object({
    group_id: z.string(),
    revision: z.number().int().nonnegative(),
    stale: z.boolean(),
    ready: z.boolean(),
    blockers: z.array(z.object({ code: z.string(), reason: z.string() })),
    devices: z
      .array(
        z
          .object({
            device_id: z.string(),
            device_name: z.string().nullable(),
            change: z.enum(["added", "removed"]),
            configuration: membershipPart,
            policy: membershipPart,
          })
          .passthrough(),
      )
      .max(10000),
  })
  .passthrough() as unknown as z.ZodType<GroupMembershipPreview>;
/** Values each device already uses for a new version of the same pipeline. */
export type BindingSuggestions = {
  devices: Record<string, Record<string, string | number | boolean>>;
  sources: Record<
    string,
    {
      deployment_id: string;
      version_number: number | null;
      /** The pipeline it came from, which may be the one this was duplicated from. */
      configuration_id?: string;
      configuration_name?: string | null;
    }
  >;
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
  // Enrollment attempts, refused ones included (bounded by the server).
  reason_code: z.string().max(64).optional(),
  name: z.string().max(100).optional(),
  token_id: z.string().max(128).optional(),
  agent_os: z.string().max(64).optional(),
  agent_arch: z.string().max(64).optional(),
  agent_version: z.string().max(64).optional(),
  configuration_mode: z.string().max(16).optional(),
  client_address: z.string().max(64).optional(),
  // Notification channel and detection threshold changes, in words. The
  // server cuts it at 500 characters (code points, not UTF-16 units).
  summary: z
    .string()
    .refine((value) => Array.from(value).length <= 500)
    .optional(),
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
  scope: z.enum(["changes", "security"]).optional(),
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
  // Rendered by the server from the code and first diagnostic.
  title: z.string().max(120).optional(),
  message: z.string(),
  diagnostics: DiagnosticsSchema.default([]),
  // Distinct failed attempts; `reports` counts every check-in.
  count: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative().optional(),
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
  desired_version_id: z.string().nullable(),
  version_number: z.number().int().positive().nullable().optional(),
  configuration_id: z.string().nullable().optional(),
  configuration_name: z.string().nullable().optional(),
  deployment_id: z.string().nullable().optional(),
  resolved: z.boolean(),
  resolved_reason: z
    .enum([
      "verified",
      "unassigned",
      "healthy",
      "superseded",
      "unmonitored",
      "revoked",
    ])
    .nullable()
    .optional(),
  resolved_at: z.string().nullable().optional(),
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
/** Issues of one version failing with one code, across devices. */
export const IssueGroupSchema = z.object({
  key: z.string(),
  code: z.string(),
  title: z.string(),
  message: z.string(),
  diagnostics: DiagnosticsSchema,
  version_id: z.string().nullable(),
  version_number: z.number().int().positive().nullable(),
  configuration_id: z.string().nullable(),
  configuration_name: z.string().nullable(),
  deployment_ids: z.array(z.string()).max(50),
  device_count: z.number().int().nonnegative(),
  issue_count: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative(),
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
  devices: z.array(IssueSchema).max(50),
});
export type IssueGroup = z.infer<typeof IssueGroupSchema>;
export const IssueGroupPageSchema = z.object({
  items: z.array(IssueGroupSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type IssueGroupPage = z.infer<typeof IssueGroupPageSchema>;
export type Token = {
  id: string;
  name: string;
  expires_at: string;
  uses: number;
  max_uses?: number | null;
  name_prefix?: string | null;
  /** Set when the token enrolls only this device name (newer servers). */
  device_name?: string;
  revoked: boolean;
  created_at: string;
  /** Preapproved device names, each of which can enroll once. */
  allowed_names?: string[];
  /** Token list only: preapproved names that already enrolled. */
  enrolled_names?: string[];
  /** Labels every device the token enrolls receives. */
  labels?: Record<string, string>;
  recovery_device_id?: string;
  recovery_name?: string;
  /** Usage added by the token list: who created it and what it enrolled. */
  created_by?: { id: string; name: string | null } | null;
  last_used_at?: string | null;
  device_count?: number;
  devices?: {
    id: string;
    name: string;
    revoked: boolean;
    enrolled_at: string | null;
  }[];
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
  /** "bundled" with the server image, or from the operator "mirror". */
  source?: "bundled" | "mirror";
};
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
// Values reach copyable shell commands, so every field is checked strictly.
const ReleaseSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/),
  os: z.enum(["linux", "darwin", "windows"]),
  arch: z.enum(["amd64", "arm64"]),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  sha256: sha256Hex,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string().regex(/^\/api\/v1\/releases\/[A-Za-z0-9._-]+$/),
  signed: z.boolean(),
  source: z.enum(["bundled", "mirror"]).optional(),
});
const agentOrigin = z
  .string()
  .regex(
    /^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/,
  );
export const AgentInstallSchema = z.object({
  agent_url: agentOrigin.nullable(),
  agent_url_configured: z.boolean(),
  listener_enabled: z.boolean(),
  dashboard_url: z.string().nullable(),
  certificate: z
    .object({
      available: z.boolean(),
      publicly_trusted: z.boolean(),
      ca_sha256: sha256Hex.nullable(),
      ca_fingerprint: z.string().max(95).nullable().optional(),
      // Public, like the fingerprint. Only base64 lines between the markers,
      // so a command can carry it in single quotes.
      ca_pem: z
        .string()
        .max(16384)
        .regex(
          /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END CERTIFICATE-----\n?$/,
        )
        .nullable()
        .optional(),
      ca_name: z.string().max(200).nullable().optional(),
      ca_issuer: z.string().max(200).nullable().optional(),
      ca_not_after: z.string().nullable().optional(),
      problem: z.string().max(1000).nullable(),
    })
    .nullable(),
  downloads_enabled: z.boolean(),
  installer: z
    .object({
      url: z.string(),
      sha256: sha256Hex,
      platforms: z.array(z.string()),
    })
    .nullable(),
  default_install_dir: z.string(),
  releases: z.array(ReleaseSchema).max(100),
  catalog_problems: z.array(z.string()).max(200),
});
export type AgentInstall = z.infer<typeof AgentInstallSchema>;
const boundedText = (max: number) => z.string().max(max).nullable();
export const EnrollmentEventSchema = z.object({
  id: boundedText(128),
  created_at: boundedText(64),
  outcome: z.enum(["success", "failure"]),
  reason_code: boundedText(64),
  device_id: boundedText(128),
  device_name: boundedText(100),
  token_id: boundedText(128),
  agent_os: boundedText(64),
  agent_arch: boundedText(64),
  agent_version: boundedText(64),
  configuration_mode: boundedText(16),
  client_address: boundedText(64),
});
export type EnrollmentEvent = z.infer<typeof EnrollmentEventSchema>;
export const EnrollmentActivitySchema = z.object({
  events: z.array(EnrollmentEventSchema).max(50),
  now: z.string(),
});
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
        diagnostics: DiagnosticsSchema.optional(),
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
      .passthrough()
      .optional(),
    policy_assignment: z
      .object({
        id: z.string().uuid(),
        priority: z.number().int(),
        reason: z.string(),
      })
      .passthrough()
      .optional(),
    name: z.string(),
    status: z.string(),
    apply_state: z.string(),
    reported_apply_state: z.string().optional(),
    configuration_attempt: ConfigurationAttemptSchema.optional(),
    host_runtime: HostRuntimeSchema.optional(),
    vector_log_summary: VectorLogSummarySchema.optional(),
    desired_generation: z.number(),
    reported_generation: z.number(),
    desired_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
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
    variables: z
      .array(
        z.object({
          name: z.string(),
          path: z.string(),
          type: z.enum(["string", "integer", "boolean"]),
        }),
      )
      .optional(),
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
  // Additive: devices grouped by the version of this pipeline they last verified.
  running_versions: z
    .array(
      z.object({
        id: z.string(),
        number: z.number().int().positive(),
        devices: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export const PipelineLibraryPageSchema = z.object({
  items: z.array(PipelineSummarySchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type PipelineSummary = z.infer<typeof PipelineSummarySchema>;
export type PipelineLibraryPage = z.infer<typeof PipelineLibraryPageSchema>;

/* Fleet-scale reads: paged devices, member-free groups, the Overview's fleet numbers. */
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rate = z.number().nonnegative().nullable();
export const GroupRefSchema = z.object({ id: z.string(), name: z.string() });
const groupRefs = (limit: number) =>
  z.object({ total: count, items: z.array(GroupRefSchema).max(limit) });
export type DeviceGroups = z.infer<ReturnType<typeof groupRefs>>;
/** The Devices page's status filter values (healthBucket), plus revoked. */
export const inventoryStatuses = [
  "applied",
  "degraded",
  "held",
  "updating",
  "check",
  "failed",
  "offline",
  "paused",
  "unmanaged",
  "revoked",
] as const;
/** Quick views; `not_on_desired` is the page's "drift". */
export const inventoryViews = [
  "failing",
  "not_on_desired",
  "offline",
  "paused",
  "no_telemetry",
] as const;
export const DeviceInventoryCountsSchema = z.object({
  status: z.object(
    Object.fromEntries(inventoryStatuses.map((s) => [s, count])) as Record<
      (typeof inventoryStatuses)[number],
      typeof count
    >,
  ),
  views: z.object(
    Object.fromEntries(inventoryViews.map((v) => [v, count])) as Record<
      (typeof inventoryViews)[number],
      typeof count
    >,
  ),
});
export const DeviceInventoryPageSchema = z.object({
  items: z.array(DeviceSchema).max(100),
  total: count,
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(100),
  counts: DeviceInventoryCountsSchema,
  device_groups: z.record(z.string(), groupRefs(10)),
});
export const DeviceInventoryIdsSchema = z.object({
  ids: z.array(z.string()).max(10000),
  total: count,
  truncated: z.boolean(),
});
export type DeviceInventoryCounts = z.infer<typeof DeviceInventoryCountsSchema>;
export type DeviceInventoryPage = z.infer<typeof DeviceInventoryPageSchema>;
export type DeviceInventoryIds = z.infer<typeof DeviceInventoryIdsSchema>;
/** `GET /groups?slim=1` rows: the group without device_ids. */
export const GroupSummarySchema = GroupSchema.omit({ device_ids: true }).extend(
  { member_count: count },
);
export const GroupMemberPageSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        status: z.string(),
      }),
    )
    .max(100),
  total: count,
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(100),
});
export type GroupSummary = z.infer<typeof GroupSummarySchema>;
export type GroupMemberPage = z.infer<typeof GroupMemberPageSchema>;
export const OverviewCountsSchema = z.object({
  total: count,
  health: z.object(
    Object.fromEntries(
      inventoryStatuses.filter((s) => s !== "revoked").map((s) => [s, count]),
    ) as Record<
      Exclude<(typeof inventoryStatuses)[number], "revoked">,
      typeof count
    >,
  ),
  connection: z.object({ online: count, offline: count, never: count }),
  checked_in: count,
  waiting_device: z.object({ id: z.string(), name: z.string() }).nullable(),
  telemetry: z.object({
    eligible: count,
    reporting: count,
    stale: count,
    disabled: count,
    events_in_per_second: rate,
    events_in_devices: count,
    events_out_per_second: rate,
    events_out_devices: count,
    errors: rate,
    errors_per_minute: rate,
    newest_sample_at: z.string().nullable(),
  }),
});
export const OverviewAttentionDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  cause: z.enum([
    "degraded",
    "failed",
    "rolled_back",
    "check_required",
    "held",
    "offline",
  ]),
  status: z.string(),
  reason: z.string().nullable(),
  title: z.string().nullable(),
  fix: z.string().nullable(),
  code: z.string().nullable(),
  component_id: z.string().nullable(),
  since: z.string().nullable(),
  version_id: z.string().nullable(),
  version_number: z.number().int().nullable(),
  configuration_id: z.string().nullable(),
  configuration_name: z.string().nullable(),
});
export const OverviewBusyDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  events_in_per_second: z.number().nonnegative(),
  events_out_per_second: rate,
});
export const OverviewRunningSchema = z.object({
  configuration_id: z.string(),
  configuration_name: z.string().nullable(),
  version_id: z.string(),
  version: z.number().int().nullable(),
  device_count: count,
  devices_reporting: count,
  groups: z
    .array(z.object({ id: z.string(), name: z.string(), device_count: count }))
    .max(3),
  more_groups: count,
  events_in_per_second: rate,
  events_out_per_second: rate,
  state: z.enum(["running", "canary", "not_delivering"]),
  not_delivering: count,
  canary: z
    .object({
      deployment_id: z.string(),
      phase: z.enum(["observing", "measuring", "waiting"]),
      device_count: count,
      device_names: z.array(z.string()).max(5),
    })
    .nullable(),
});
/** What `GET /overview` adds for a fleet; `slim=1` also leaves `devices` out. */
export const OverviewFleetSchema = z.object({
  counts: OverviewCountsSchema,
  attention_devices: z.array(OverviewAttentionDeviceSchema).max(20),
  attention_devices_total: count,
  busiest: z.array(OverviewBusyDeviceSchema).max(5),
  running: z.array(OverviewRunningSchema).max(20),
  running_total: count,
});
export type OverviewCounts = z.infer<typeof OverviewCountsSchema>;
export type OverviewAttentionDevice = z.infer<
  typeof OverviewAttentionDeviceSchema
>;
export type OverviewBusyDevice = z.infer<typeof OverviewBusyDeviceSchema>;
export type OverviewRunning = z.infer<typeof OverviewRunningSchema>;
export type OverviewFleet = z.infer<typeof OverviewFleetSchema>;

function responseSchema(path: string, method: string): z.ZodType | undefined {
  const slim = /(?:^|&)slim=(?:1|true)(?:&|$)/.test(path.split("?")[1] || "");
  path = path.split("?")[0];
  if (method === "GET") {
    if (path === "/devices/inventory") return DeviceInventoryPageSchema;
    if (path === "/devices/inventory/ids") return DeviceInventoryIdsSchema;
    if (/^\/groups\/[^/]+\/members$/.test(path)) return GroupMemberPageSchema;
    if (path === "/groups" && slim) return z.array(GroupSummarySchema);
  }
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
  if (path === "/groups/membership-preview" && method === "POST")
    return GroupMembershipPreviewSchema;
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
  if (path === "/issues/groups") return IssueGroupPageSchema;
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
  if (path === "/notifications/channels")
    return method === "POST" ? ChannelSchema : ChannelListSchema;
  if (/^\/notifications\/channels\/[^/]+\/test$/.test(path))
    return TestResultSchema;
  if (/^\/notifications\/channels\/[^/]+$/.test(path))
    return method === "DELETE"
      ? z.object({ ok: z.literal(true) })
      : ChannelSchema;
  if (path === "/notifications/preview") return PreviewSchema;
  if (path === "/notifications/deliveries") return AttemptPageSchema;
  if (path === "/detection") return DetectionSchema;
  if (method !== "GET") return undefined;
  if (/^\/deployments\/requests\/[^/]+$/.test(path))
    return DeploymentRequestLookupSchema;
  if (path === "/devices") return z.array(DeviceSchema);
  if (/^\/devices\/[^/]+\/telemetry$/.test(path)) return TelemetryHistorySchema;
  if (path === "/telemetry/summary") return TelemetrySummarySchema;
  if (/^\/versions\/[^/]+\/telemetry$/.test(path))
    return VersionTelemetrySchema;
  if (/^\/configurations\/[^/]+\/telemetry$/.test(path))
    return ConfigurationTelemetrySchema;
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
  if (path === "/users") return z.array(PersonSchema);
  if (path === "/account/sessions" && method === "GET")
    return z.object({ sessions: z.array(SessionSummarySchema) });
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
/**
 * Save `content` as a file. The link is attached while it is clicked and the
 * blob URL outlives the click: some browsers cancel a download whose URL is
 * revoked, or whose link is detached, before the save starts. This starts a
 * save; it cannot know whether the file was kept.
 */
export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
