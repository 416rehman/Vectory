import { z } from "zod";

export class APIError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let csrf = "";
export function setCSRF(value: string) {
  csrf = value;
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
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
  if (!response.ok)
    throw new APIError(
      data?.error?.code || "REQUEST_FAILED",
      data?.error?.message || `Request failed (${response.status}).`,
      response.status,
    );
  const expected = schema || responseSchema(path, options.method || "GET");
  if (expected) {
    const result = expected.safeParse(data);
    if (!result.success)
      throw new APIError(
        "CONTRACT_MISMATCH",
        "The server response does not match this dashboard version.",
        502,
      );
    return result.data as T;
  }
  return data;
}
export const post = <T = unknown>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["viewer", "editor", "operator", "admin"]),
});
export const SessionSchema = z.object({
  user: UserSchema,
  csrf_token: z.string(),
});
export type User = z.infer<typeof UserSchema>;
export type Config = Record<string, any>;
export type Graph = { nodes: any[]; edges: any[] };
export type Configuration = {
  id: string;
  name: string;
  description: string;
  revision: number;
  graph: Graph;
  config: Config;
  created_at: string;
  updated_at: string;
};
export type Version = {
  id: string;
  configuration_id: string;
  number: number;
  graph: Graph;
  config: Config;
  artifact: string;
  sha256: string;
  size: number;
  created_at: string;
  message: string;
  validation: any;
};
export type Device = {
  id: string;
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
  assignment?: { id: string; priority: number; reason: string };
  created_at: string;
};
export type Group = {
  id: string;
  name: string;
  description: string;
  device_ids: string[];
};
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
export type Deployment = {
  id: string;
  name?: string;
  version_id?: string;
  policy?: Policy;
  selector: Selector;
  priority: number;
  target_mode: string;
  status: string;
  scheduled_at?: string;
  created_at: string;
  targets: {
    device_id: string;
    state: string;
    generation: number;
    error?: string;
  }[];
  rollout: {
    kind: string;
    canary_size: number;
    batch_size: number;
    observation_seconds: number;
    failure_threshold: number;
  };
};
export type Audit = {
  id: string;
  actor: string;
  action: string;
  target: string;
  outcome: string;
  created_at: string;
};
export type Issue = {
  id: string;
  device_id: string;
  code: string;
  stage: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  resolved: boolean;
};
export type Token = {
  id: string;
  name: string;
  expires_at: string;
  uses: number;
  max_uses?: number;
  name_prefix?: string;
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
export const DeviceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    apply_state: z.string(),
    desired_generation: z.number(),
    reported_generation: z.number(),
  })
  .passthrough();
export const ConfigurationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    config: z.record(z.string(), z.unknown()),
    graph: z.object({
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
    }),
  })
  .passthrough();
export const listSchema = (schema: z.ZodType) => z.array(schema);
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
  if (path === "/session" || path === "/login" || path === "/bootstrap")
    return SessionSchema;
  if (path === "/status")
    return z.object({ initialized: z.boolean(), version: z.string() });
  if (method !== "GET") return undefined;
  if (path === "/devices") return z.array(DeviceSchema);
  if (/^\/devices\/[^/]+\/telemetry$/.test(path))
    return z.object({
      device_id: z.string(),
      samples: z.array(telemetrySchema).max(120),
    });
  if (/^\/devices\/[^/]+$/.test(path)) return DeviceSchema;
  if (path === "/configurations") return z.array(ConfigurationSchema);
  if (/^\/configurations\/[^/]+$/.test(path)) return ConfigurationSchema;
  if (path === "/users") return z.array(UserSchema);
  const record = z.object({ id: z.string() }).passthrough();
  if (
    [
      "/groups",
      "/deployments",
      "/policies",
      "/tokens",
      "/issues",
      "/audit",
    ].includes(path)
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
