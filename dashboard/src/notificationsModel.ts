import { z } from "zod";
import type { StatusTone } from "./status";
import { relativeTime } from "./time";

/** What a channel can announce, in the order the form lists them. */
export const notificationEvents = [
  {
    value: "issue.opened",
    label: "Issue opened",
    description: "A device reports a problem, or one comes back.",
  },
  {
    value: "issue.resolved",
    label: "Issue resolved",
    description: "The problem went away on its own or after a fix.",
  },
  {
    value: "rollout.failed",
    label: "Rollout failed",
    description: "A rollout stopped on failures or delivery problems.",
  },
  {
    value: "rollout.rolled_back",
    label: "Rollout rolled back",
    description: "Someone rolled a deployment back.",
  },
  {
    value: "canary.paused",
    label: "Canary paused",
    description: "A canary waits because devices stopped delivering.",
  },
  {
    value: "device.offline",
    label: "Device offline",
    description: "No check-in for longer than you choose.",
  },
  {
    value: "device.recovered",
    label: "Device back online",
    description: "A device you were told about checks in again.",
  },
] as const;
export type NotificationEventType =
  (typeof notificationEvents)[number]["value"];
export const OFFLINE_MINUTES = { min: 5, max: 1440, default: 15 } as const;

export function eventLabel(type: string) {
  if (type === "test") return "Test message";
  if (type === "digest") return "Summary";
  return notificationEvents.find((e) => e.value === type)?.label ?? type;
}

const QuietHoursSchema = z.object({
  start: z.string(),
  end: z.string(),
  time_zone: z.string(),
  errors_bypass: z.boolean(),
});
export const RulesSchema = z.object({
  events: z.array(z.string()),
  offline_minutes: z.number().int(),
  min_severity: z.enum(["warning", "error"]),
  pipeline_ids: z.array(z.string()),
  group_ids: z.array(z.string()),
  quiet_hours: QuietHoursSchema.nullable(),
});
export type Rules = z.infer<typeof RulesSchema>;
export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["webhook", "email"]),
  enabled: z.boolean(),
  allow_private: z.boolean(),
  webhook: z
    .object({
      url_hint: z.string(),
      host: z.string(),
      header_name: z.string().nullable(),
      signing_secret_set: z.boolean(),
      header_value_set: z.boolean(),
    })
    .nullable(),
  email: z
    .object({
      host: z.string(),
      port: z.number().int(),
      security: z.enum(["starttls", "tls", "none"]),
      username: z.string().nullable(),
      password_set: z.boolean(),
      from: z.string(),
      to: z.array(z.string()),
    })
    .nullable(),
  rules: RulesSchema,
  secrets_readable: z.boolean(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.object({
    state: z.enum(["idle", "delivering", "failing", "off"]),
    last_attempt_at: z.string().nullable(),
    last_delivered_at: z.string().nullable(),
    last_error: z.string().nullable(),
    last_status_code: z.number().int().nullable(),
    pending: z.number().int().nonnegative(),
  }),
});
export type Channel = z.infer<typeof ChannelSchema>;
export const ChannelListSchema = z.object({
  items: z.array(ChannelSchema),
  max_channels: z.number().int().positive(),
});
export type ChannelList = z.infer<typeof ChannelListSchema>;
export const TestResultSchema = z.object({
  attempt_id: z.number().int(),
  delivered: z.boolean(),
  status_code: z.number().int().nullable(),
  latency_ms: z.number().int().nonnegative(),
  error: z.string().nullable(),
  at: z.string(),
});
export type TestResult = z.infer<typeof TestResultSchema>;
export const AttemptSchema = z.object({
  id: z.number().int(),
  delivery_id: z.string(),
  channel_id: z.string(),
  channel_name: z.string().nullable(),
  channel_exists: z.boolean(),
  kind: z.enum(["event", "digest", "test"]),
  type: z.string().nullable(),
  title: z.string().nullable(),
  attempt: z.number().int().positive(),
  at: z.string(),
  outcome: z.enum(["delivered", "retrying", "failed", "gave_up"]),
  status_code: z.number().int().nullable(),
  latency_ms: z.number().int().nonnegative(),
  error: z.string().nullable(),
  next_attempt_at: z.string().nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;
export const AttemptPageSchema = z.object({
  items: z.array(AttemptSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().min(1).max(50),
});
export type AttemptPage = z.infer<typeof AttemptPageSchema>;
export const PreviewSchema = z.object({
  example: z.literal(true),
  headline: z.string(),
  message: z.string(),
  context: z.string(),
  link: z.string().nullable(),
  webhook: z.object({
    text: z.string(),
    blocks: z.array(z.unknown()),
    event: z.record(z.string(), z.unknown()),
  }),
  email: z.object({ subject: z.string(), body: z.string() }),
});
export type Preview = z.infer<typeof PreviewSchema>;

/* ---------- Channel list ---------- */

/** Where a channel sends, without anything secret. */
export function destination(channel: Channel) {
  if (channel.kind === "email" && channel.email) {
    const count = channel.email.to.length;
    return `${count} ${count === 1 ? "recipient" : "recipients"} via ${channel.email.host}`;
  }
  return channel.webhook?.host ?? "Webhook";
}
/** "New issues and resolutions, rollout problems, offline after 15 min". */
export function rulesSummary(rules: Rules) {
  const has = (event: string) => rules.events.includes(event);
  const parts: string[] = [];
  if (has("issue.opened") && has("issue.resolved"))
    parts.push("Issues and resolutions");
  else if (has("issue.opened")) parts.push("New issues");
  else if (has("issue.resolved")) parts.push("Resolved issues");
  const rollouts = ["rollout.failed", "rollout.rolled_back", "canary.paused"]
    .filter(has)
    .map((e) =>
      e === "rollout.failed"
        ? "failed"
        : e === "rollout.rolled_back"
          ? "rolled back"
          : "paused",
    );
  if (rollouts.length)
    parts.push(
      rollouts.length === 3
        ? "rollout problems"
        : `${rollouts.join(" and ")} rollouts`,
    );
  if (has("device.offline"))
    parts.push(
      `offline after ${minutesText(rules.offline_minutes)}${has("device.recovered") ? " and back online" : ""}`,
    );
  else if (has("device.recovered")) parts.push("devices back online");
  const text = parts.join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Nothing";
}
export function minutesText(minutes: number) {
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} min`;
}
/** "Errors only · 2 pipelines · Quiet 22:00–07:00 (Europe/Berlin)". */
export function filtersSummary(rules: Rules) {
  const parts: string[] = [];
  if (rules.min_severity === "error") parts.push("Errors only");
  const count = (n: number, noun: string) =>
    `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (rules.pipeline_ids.length)
    parts.push(count(rules.pipeline_ids.length, "pipeline"));
  if (rules.group_ids.length)
    parts.push(count(rules.group_ids.length, "group"));
  if (rules.quiet_hours)
    parts.push(
      `Quiet ${rules.quiet_hours.start}–${rules.quiet_hours.end} (${rules.quiet_hours.time_zone})`,
    );
  return parts.join(" · ");
}
export type StatusView = { tone: StatusTone; label: string; detail: string };
/** What the list says about a channel's recent deliveries. */
export function channelStatus(channel: Channel, now = Date.now()): StatusView {
  const s = channel.status;
  const waiting = s.pending ? ` · ${s.pending} waiting` : "";
  if (!channel.enabled)
    return { tone: "neutral", label: "Off", detail: "Sends nothing" };
  if (!channel.secrets_readable)
    return {
      tone: "danger",
      label: "Needs secrets",
      detail: "Its saved secrets can't be read. Edit it and replace them.",
    };
  if (s.state === "failing")
    return {
      tone: "danger",
      label: "Failing",
      detail: `${s.last_error || "The last message didn't go through."}${waiting}`,
    };
  if (s.state === "delivering")
    return {
      tone: "success",
      label: "Delivering",
      detail: `Last delivered ${relativeTime(s.last_delivered_at, now)}${waiting}`,
    };
  return {
    tone: "neutral",
    label: "No messages yet",
    detail: s.pending ? `${s.pending} waiting` : "Send a test to check it",
  };
}

/* ---------- Delivery log ---------- */

export const attemptOutcomes = [
  { value: "delivered", label: "Delivered" },
  { value: "retrying", label: "Retrying" },
  { value: "failed", label: "Failed" },
  { value: "gave_up", label: "Gave up" },
] as const;
export type AttemptOutcome = (typeof attemptOutcomes)[number]["value"];
export function attemptView(
  attempt: Attempt,
  timeText: (at: string) => string,
): StatusView {
  const answered =
    attempt.status_code !== null
      ? `Answered ${attempt.status_code} in ${attempt.latency_ms.toLocaleString()} ms`
      : `${attempt.latency_ms.toLocaleString()} ms`;
  switch (attempt.outcome) {
    case "delivered":
      return { tone: "success", label: "Delivered", detail: answered };
    case "retrying":
      return {
        tone: "warning",
        label: "Retrying",
        detail: `${attempt.error || answered}${attempt.next_attempt_at ? ` Next try ${timeText(attempt.next_attempt_at)}.` : ""}`,
      };
    case "gave_up":
      return {
        tone: "danger",
        label: "Gave up",
        detail: `${attempt.error || answered} No more tries after ${attempt.attempt} attempts.`,
      };
    default:
      return {
        tone: "danger",
        label: "Failed",
        detail: `${attempt.error || answered}${attempt.kind === "test" ? "" : " Not retried: a retry wouldn't change it."}`,
      };
  }
}
export function attemptLabel(attempt: Attempt) {
  if (attempt.kind === "test") return "Test";
  return `${attempt.attempt} of 4`;
}

/* ---------- Channel form ---------- */

/**
 * A write-only value in the form. `keep` leaves the saved value alone,
 * `remove` deletes it, `set` sends a new one; `none` has nothing saved.
 */
export type SecretField =
  | { state: "keep" }
  | { state: "remove" }
  | { state: "set"; value: string }
  | { state: "none" };
export type ChannelDraft = {
  name: string;
  kind: "webhook" | "email";
  enabled: boolean;
  allowPrivate: boolean;
  url: SecretField;
  signingSecret: SecretField;
  headerName: string;
  headerValue: SecretField;
  host: string;
  port: string;
  security: "starttls" | "tls" | "none";
  username: string;
  password: SecretField;
  from: string;
  to: string;
  events: string[];
  offlineMinutes: string;
  errorsOnly: boolean;
  pipelineIds: string[];
  groupIds: string[];
  quiet: boolean;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
  errorsBypass: boolean;
};
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
export function timeZones(current = browserTimeZone()) {
  let zones: string[] = [];
  try {
    zones =
      (
        Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
      ).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return [...new Set(["UTC", current, ...zones])].sort((a, b) =>
    a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b),
  );
}
export function newDraft(
  kind: "webhook" | "email" = "webhook",
  zone = browserTimeZone(),
): ChannelDraft {
  return {
    name: "",
    kind,
    enabled: true,
    allowPrivate: false,
    url: { state: "set", value: "" },
    signingSecret: { state: "none" },
    headerName: "",
    headerValue: { state: "none" },
    host: "",
    port: "587",
    security: "starttls",
    username: "",
    password: { state: "none" },
    from: "",
    to: "",
    events: [
      "issue.opened",
      "issue.resolved",
      "rollout.failed",
      "device.offline",
      "device.recovered",
    ],
    offlineMinutes: String(OFFLINE_MINUTES.default),
    errorsOnly: false,
    pipelineIds: [],
    groupIds: [],
    quiet: false,
    quietStart: "22:00",
    quietEnd: "07:00",
    timeZone: zone,
    errorsBypass: true,
  };
}
const saved = (set: boolean): SecretField =>
  set ? { state: "keep" } : { state: "none" };
export function draftFromChannel(
  channel: Channel,
  zone = browserTimeZone(),
): ChannelDraft {
  const quiet = channel.rules.quiet_hours;
  const base = newDraft(channel.kind, zone);
  return {
    ...base,
    name: channel.name,
    enabled: channel.enabled,
    allowPrivate: channel.allow_private,
    url: channel.kind === "webhook" ? { state: "keep" } : { state: "none" },
    signingSecret: saved(!!channel.webhook?.signing_secret_set),
    headerName: channel.webhook?.header_name ?? "",
    headerValue: saved(!!channel.webhook?.header_value_set),
    host: channel.email?.host ?? "",
    port: String(channel.email?.port ?? 587),
    security: channel.email?.security ?? "starttls",
    username: channel.email?.username ?? "",
    password: saved(!!channel.email?.password_set),
    from: channel.email?.from ?? "",
    to: channel.email?.to.join(", ") ?? "",
    events: [...channel.rules.events],
    offlineMinutes: String(channel.rules.offline_minutes),
    errorsOnly: channel.rules.min_severity === "error",
    pipelineIds: [...channel.rules.pipeline_ids],
    groupIds: [...channel.rules.group_ids],
    quiet: !!quiet,
    quietStart: quiet?.start ?? base.quietStart,
    quietEnd: quiet?.end ?? base.quietEnd,
    timeZone: quiet?.time_zone ?? zone,
    errorsBypass: quiet?.errors_bypass ?? base.errorsBypass,
  };
}
export function parseRecipients(text: string) {
  return text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
const mailbox = (value: string) => {
  const address = value.match(/<([^>]+)>\s*$/)?.[1] ?? value;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address.trim());
};
const clock = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const headerToken = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const reservedHeaders = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "user-agent",
  "expect",
]);
/** What kind of literal IPv4 address a host is, to warn before saving. */
function ipv4Kind(host: string): "private" | "blocked" | null {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p)))
    return null;
  const [a, b] = parts.map(Number);
  if (a === 169 && b === 254) return "blocked";
  if (a === 0 || a >= 224) return "blocked";
  if (a === 127 || a === 10 || (a === 192 && b === 168)) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return null;
}
export function webhookUrlError(value: string, allowPrivate: boolean) {
  const text = value.trim();
  if (!text) return "Enter the webhook URL.";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Enter a full URL such as https://hooks.slack.com/services/…";
  }
  if (url.protocol === "http:" && !allowPrivate)
    return "Use https://. Plain http:// works only for private addresses, with Allow private network addresses on.";
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "Use an https:// URL.";
  if (url.username || url.password)
    return "Remove the user name and password from the URL. Put credentials in the header value instead.";
  if (url.hash) return "Remove the #fragment from the URL.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const kind = ipv4Kind(host);
  if (kind === "blocked")
    return `${host} is a link-local, metadata or reserved address, which Vectory never contacts.`;
  if (
    !allowPrivate &&
    (kind === "private" ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1")
  )
    return `${host} is a private address. Turn on Allow private network addresses to send there.`;
  return "";
}
export type DraftErrors = Partial<Record<keyof ChannelDraft | "form", string>>;
export function validateDraft(draft: ChannelDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Name this channel.";
  else if ([...name].length > 80) errors.name = "Use at most 80 characters.";
  if (draft.kind === "webhook") {
    if (draft.url.state === "set") {
      const error = webhookUrlError(draft.url.value, draft.allowPrivate);
      if (error) errors.url = error;
    }
    if (draft.signingSecret.state === "set") {
      const length = [...draft.signingSecret.value].length;
      if (length > 0 && length < 16)
        errors.signingSecret = "Use at least 16 characters.";
      else if (length > 256)
        errors.signingSecret = "Use at most 256 characters.";
    }
    const header = draft.headerName.trim();
    if (header) {
      if (!headerToken.test(header))
        errors.headerName = "Use letters, digits and - only.";
      else if (
        reservedHeaders.has(header.toLowerCase()) ||
        header.toLowerCase().startsWith("x-vectory-") ||
        header.toLowerCase().startsWith("proxy-")
      )
        errors.headerName = "Vectory sets this header itself. Choose another.";
      const value = draft.headerValue;
      if (value.state === "set") {
        if (!value.value) errors.headerValue = "Enter the header's value.";
        else if (!/^[\t\x20-\x7e]*$/.test(value.value))
          errors.headerValue = "Use printable ASCII characters only.";
      } else if (value.state !== "keep")
        errors.headerValue = "Enter the header's value.";
    }
  } else {
    const host = draft.host.trim();
    if (!host) errors.host = "Enter the SMTP server.";
    else if (
      /[/\s@]/.test(host) ||
      (host.includes(":") &&
        !host.includes("::") &&
        !/^[0-9a-f:]+$/i.test(host))
    )
      errors.host = "Enter a host name without a port.";
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      errors.port = "Enter a port from 1 to 65535.";
    if (draft.security === "none") {
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(
        host.toLowerCase(),
      );
      if (!loopback || !draft.allowPrivate)
        errors.security =
          "Unencrypted email only goes to a relay on this server (localhost), with Allow private network addresses on.";
    }
    if (draft.username.trim()) {
      if (draft.password.state === "set" && !draft.password.value)
        errors.password = "Enter the password for this user name.";
      else if (
        draft.password.state === "none" ||
        draft.password.state === "remove"
      )
        errors.password = "Enter the password for this user name.";
    }
    if (!draft.from.trim())
      errors.from = "Enter the address messages come from.";
    else if (!mailbox(draft.from)) errors.from = "Enter a valid address.";
    const to = parseRecipients(draft.to);
    if (!to.length) errors.to = "Enter at least one recipient.";
    else if (to.length > 10) errors.to = "Enter at most 10 recipients.";
    else {
      const bad = to.find((address) => !mailbox(address));
      if (bad) errors.to = `${bad} isn't a valid address.`;
    }
  }
  if (!draft.events.length) errors.events = "Choose at least one event.";
  if (draft.events.includes("device.offline")) {
    const minutes = Number(draft.offlineMinutes);
    if (
      !Number.isInteger(minutes) ||
      minutes < OFFLINE_MINUTES.min ||
      minutes > OFFLINE_MINUTES.max
    )
      errors.offlineMinutes = `Enter ${OFFLINE_MINUTES.min} to ${OFFLINE_MINUTES.max.toLocaleString()} minutes.`;
  }
  if (draft.quiet) {
    if (!clock.test(draft.quietStart) || !clock.test(draft.quietEnd))
      errors.quietStart = "Enter times like 22:00.";
    else if (draft.quietStart === draft.quietEnd)
      errors.quietStart = "Quiet hours need different start and end times.";
    if (!draft.timeZone) errors.timeZone = "Choose a time zone.";
  }
  return errors;
}
function secretValue(field: SecretField): string | null | undefined {
  switch (field.state) {
    case "set":
      return field.value ? field.value : undefined;
    case "remove":
      return null;
    default:
      return undefined;
  }
}
/**
 * The request body. Secrets left alone are omitted, so the server keeps
 * them; removed ones are sent as null; new ones as text.
 */
export function channelRequest(draft: ChannelDraft, revision?: number) {
  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    kind: draft.kind,
    enabled: draft.enabled,
    allow_private: draft.allowPrivate,
    rules: {
      events: notificationEvents
        .map((e) => e.value)
        .filter((e) => draft.events.includes(e)),
      offline_minutes: Number(draft.offlineMinutes) || OFFLINE_MINUTES.default,
      min_severity: draft.errorsOnly ? "error" : "warning",
      pipeline_ids: draft.pipelineIds,
      group_ids: draft.groupIds,
      quiet_hours: draft.quiet
        ? {
            start: draft.quietStart,
            end: draft.quietEnd,
            time_zone: draft.timeZone,
            errors_bypass: draft.errorsBypass,
          }
        : null,
    },
  };
  if (revision !== undefined) body.revision = revision;
  const put = (
    target: Record<string, unknown>,
    key: string,
    value: string | null | undefined,
  ) => {
    if (value !== undefined) target[key] = value;
  };
  if (draft.kind === "webhook") {
    const webhook: Record<string, unknown> = {};
    put(
      webhook,
      "url",
      draft.url.state === "set" ? draft.url.value.trim() : undefined,
    );
    put(webhook, "signing_secret", secretValue(draft.signingSecret));
    const header = draft.headerName.trim();
    webhook.header_name = header || null;
    if (header) put(webhook, "header_value", secretValue(draft.headerValue));
    body.webhook = webhook;
  } else {
    const email: Record<string, unknown> = {
      host: draft.host.trim(),
      port: Number(draft.port),
      security: draft.security,
      username: draft.username.trim() || null,
      from: draft.from.trim(),
      to: parseRecipients(draft.to),
    };
    if (draft.username.trim())
      put(email, "password", secretValue(draft.password));
    body.email = email;
  }
  return body;
}

/* ---------- Detection thresholds ---------- */

export const ThresholdsSchema = z.object({
  sink_errors_per_minute: z.number().int(),
  error_drops_per_minute: z.number().int(),
  buffer_full_percent: z.number().int(),
  stall_checks: z.number().int(),
  canary_checks: z.number().int(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;
export const DetectionSchema = z.object({
  thresholds: ThresholdsSchema,
  defaults: ThresholdsSchema,
  bounds: z.record(z.string(), z.object({ min: z.number(), max: z.number() })),
  revision: z.number().int().nonnegative(),
  updated_at: z.string().nullable(),
  updated_by_name: z.string().nullable(),
  evaluation_interval_seconds: z.number().int().positive(),
});
export type Detection = z.infer<typeof DetectionSchema>;
export const detectionFields: {
  key: keyof Thresholds;
  label: string;
  description: string;
  /** The unit after a value of 1, then after any other value. */
  one: string;
  unit: string;
}[] = [
  {
    key: "sink_errors_per_minute",
    label: "Failing destination",
    description:
      "A sink counts as failing when at least this many of its requests fail in a minute.",
    one: "failed request a minute",
    unit: "failed requests a minute",
  },
  {
    key: "error_drops_per_minute",
    label: "Dropped events",
    description:
      "A component counts as losing events when errors make it drop at least this many a minute.",
    one: "event a minute",
    unit: "events a minute",
  },
  {
    key: "buffer_full_percent",
    label: "Full buffer",
    description:
      "A buffer this full counts as full. Once it's full, Vector holds back every path that feeds it.",
    one: "% full",
    unit: "% full",
  },
  {
    key: "stall_checks",
    label: "Stalled pipeline",
    description:
      "A stall opens when this many checks in a row find events arriving and none delivered.",
    one: "check in a row",
    unit: "checks in a row",
  },
  {
    key: "canary_checks",
    label: "Canary measurement",
    description:
      "A canary waits for this many checks of each device's delivery before it releases the next wave.",
    one: "check per device",
    unit: "checks per device",
  },
];
export type ThresholdForm = Record<keyof Thresholds, string>;
/** "failed request a minute" after 1, "failed requests a minute" otherwise. */
export function thresholdUnit(
  field: (typeof detectionFields)[number],
  value: string,
) {
  return value.trim() === "1" ? field.one : field.unit;
}
/** "Default 1 · allowed 1 to 10,000", or "The default · …" when it is. */
export function thresholdHint(
  field: (typeof detectionFields)[number],
  value: string,
  detection: Detection,
) {
  const bounds = detection.bounds[field.key];
  const range = bounds
    ? ` · allowed ${bounds.min.toLocaleString()} to ${bounds.max.toLocaleString()}`
    : "";
  const fallback = detection.defaults[field.key];
  return value.trim() === String(fallback)
    ? `The default${range}`
    : `Default ${fallback.toLocaleString()}${range}`;
}
export function thresholdForm(values: Thresholds): ThresholdForm {
  return Object.fromEntries(
    detectionFields.map((f) => [f.key, String(values[f.key])]),
  ) as ThresholdForm;
}
export function thresholdErrors(form: ThresholdForm, detection: Detection) {
  const errors: Partial<Record<keyof Thresholds, string>> = {};
  for (const field of detectionFields) {
    const bounds = detection.bounds[field.key];
    const value = Number(form[field.key]);
    if (
      form[field.key].trim() === "" ||
      !Number.isInteger(value) ||
      (bounds && (value < bounds.min || value > bounds.max))
    )
      errors[field.key] = bounds
        ? `Enter a whole number from ${bounds.min.toLocaleString()} to ${bounds.max.toLocaleString()}.`
        : "Enter a whole number.";
  }
  return errors;
}
export function thresholdValues(form: ThresholdForm): Thresholds {
  return Object.fromEntries(
    detectionFields.map((f) => [f.key, Number(form[f.key])]),
  ) as Thresholds;
}
export function sameThresholds(a: Thresholds, b: Thresholds) {
  return detectionFields.every((f) => a[f.key] === b[f.key]);
}
