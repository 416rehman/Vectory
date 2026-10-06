import { isSecretReference } from "./pipelineSchema";
import { isSecretField, secretNameOf } from "./secretFields";

export type PlainCredentialField = {
  path: string;
  key: string;
  steps: readonly (string | number)[];
  kind: "plaintext" | "unsupported_reference" | "scan_limit";
};

const normalize = (name: string) => name.toLowerCase().replace(/[-.]/g, "_");
const ordinaryKeyNames = new Set([
  "cache_size_per_key",
  "client_key",
  "client_metadata_key",
  "emit_events_discarded_per_key",
  "exchange_key",
  "file_key",
  "global_host_key",
  "global_log_schema_host_key",
  "global_timestamp_key",
  "headers_key",
  "host_key",
  "id_key",
  "include_key",
  "kms_key",
  "labels_key",
  "max_tracked_key",
  "message_key",
  "metadata_key",
  "offset_key",
  "partition_key",
  "path_key",
  "pid_key",
  "port_key",
  "properties_key",
  "redis_key",
  "routing_key",
  "sample_rate_key",
  "severity_key",
  "source_key",
  "source_type_key",
  "ssekms_key",
  "subject_key",
  "tag_cardinality_tracked_key",
  "tag_key",
  "timestamp_key",
  "timestamp_nanos_key",
  "topic_key",
]);
const credentialNames = [
  "password",
  "passwd",
  "api_key",
  "apikey",
  "access_key_id",
  "secret_access_key",
  "token",
  "valid_tokens",
  "access_keys",
  "bearer",
  "authorization",
  "proxy_authorization",
  "client_secret",
  "private_key",
  "cookie",
  "set_cookie",
  "x_honeycomb_team",
  "dd_api_key",
  "x_api_key",
  "x_auth_token",
  "private_token",
  "x_insert_key",
  "x_license_key",
  "signature",
  "sig",
];
const queryNames = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "auth",
  "sig",
  "signature",
  "secret",
  "client_secret",
  "password",
]);
const credentialKey = (name: string) => {
  const key = normalize(name);
  return (
    !ordinaryKeyNames.has(key) &&
    (credentialNames.some(
      (candidate) => key === candidate || key.endsWith(`_${candidate}`),
    ) ||
      ["_token", "_key", "_secret", "_password", "_signature"].some((suffix) =>
        key.endsWith(suffix),
      ))
  );
};
const credentialHeader = (name: string) =>
  ["token", "key", "secret", "auth", "cookie", "signature", "session"].some(
    (part) => name.toLowerCase().includes(part),
  );
const nativeReference = (text: string) =>
  !text.includes("vectory-secret:") && isSecretReference(text);
const placeholder = (text: string) =>
  ["changeme", "example", "redacted", "xxxxxxxx"].includes(
    text
      .trim()
      .replace(/^(?:Bearer|Basic|Token) /i, "")
      .toLowerCase(),
  );
const credentialLiteral = (text: string, minLength = 1) => {
  const value = text.trim();
  if (value.length < minLength || placeholder(value) || nativeReference(value))
    return false;
  const assignments = value.split(/;\s*/);
  if (
    assignments.every((entry) => {
      const assignment = /^[A-Za-z0-9_.-]+=([^=;\s]+)$/.exec(entry);
      return (
        assignment &&
        (nativeReference(assignment[1]) || placeholder(assignment[1]))
      );
    })
  )
    return false;
  return !nativeReference(value.replace(/^Token /i, ""));
};

function tokenShape(text: string): boolean {
  if (
    text.includes("-----BEGIN ") &&
    text.includes("PRIVATE KEY-----") &&
    text.includes("-----END ")
  )
    return true;
  for (const word of text.split(/[^A-Za-z0-9_.-]+/)) {
    if (/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(word)) return true;
    const jwt = word.split(".");
    if (jwt.length === 3 && jwt[1].length >= 8 && jwt[2].length >= 8) {
      try {
        const header = JSON.parse(
          atob(jwt[0].replace(/-/g, "+").replace(/_/g, "/")),
        );
        if (typeof header?.alg === "string") return true;
      } catch {
        /* Not a JWT header. */
      }
    }
    if (
      /^(?:xox[abeprs]-|ghp_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}$/.test(
        word,
      )
    )
      return true;
  }
  return false;
}

function urlCredential(text: string): "credential" | "scan_limit" | null {
  // Find separators first: a scheme-first regex backtracks quadratically on
  // long ordinary strings (recovery drafts may contain large field names).
  const candidates: string[] = [];
  for (
    let separator = text.indexOf("://");
    separator !== -1;
    separator = text.indexOf("://", separator + 3)
  ) {
    let start = separator;
    while (start > 0 && /[A-Za-z0-9+.-]/.test(text[start - 1])) start--;
    let end = separator + 3;
    while (end < text.length && !/[\s"'<>\\]/.test(text[end])) {
      end++;
      if (end - start > 16 * 1024 + 1) return "scan_limit";
    }
    let candidate = text.slice(start, end);
    if (text[start - 1] === "(" && candidate.endsWith(")"))
      candidate = candidate.slice(0, -1);
    candidates.push(candidate);
    if (candidates.length > 64) return "scan_limit";
  }
  for (const candidate of candidates) {
    if (new TextEncoder().encode(candidate).length > 16 * 1024)
      return "scan_limit";
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      const tail = candidate.split("://", 2)[1] ?? "";
      const authority = tail.split(/[/?#]/, 1)[0];
      const userinfo = authority.includes("@")
        ? authority.split("@", 1)[0]
        : null;
      if (
        userinfo !== null &&
        userinfo.split(":").some((part) => credentialLiteral(part))
      )
        return "credential";
      const query = tail.split("?", 2)[1]?.split("#", 1)[0];
      if (query) {
        for (const [name, entry] of new URLSearchParams(query)) {
          if (queryNames.has(normalize(name)) && credentialLiteral(entry))
            return "credential";
        }
      }
      continue;
    }
    const nativeUserinfo = (part: string) => {
      try {
        return !credentialLiteral(decodeURIComponent(part));
      } catch {
        return false;
      }
    };
    if (!nativeUserinfo(url.username) || !nativeUserinfo(url.password))
      return "credential";
    for (const [name, entry] of url.searchParams) {
      if (queryNames.has(normalize(name)) && credentialLiteral(entry))
        return "credential";
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part.replace(/\+/g, " "));
        } catch {
          return part;
        }
      });
    const discord =
      [
        "discord.com",
        "discordapp.com",
        "canary.discord.com",
        "ptb.discord.com",
      ].includes(host) &&
      segments[0] === "api" &&
      segments[1] === "webhooks" &&
      segments.length >= 4;
    const webhook =
      (host === "hooks.slack.com" &&
        segments[0] === "services" &&
        segments.length >= 4) ||
      discord ||
      ((host === "webhook.office.com" ||
        host.endsWith(".webhook.office.com")) &&
        segments.length > 0) ||
      (host === "outlook.office.com" &&
        segments[0] === "webhook" &&
        segments.length > 1);
    if (
      webhook &&
      credentialLiteral(discord ? segments[3] : (segments.at(-1) ?? ""), 8)
    )
      return "credential";
  }
  return null;
}

/** Locate a likely plaintext credential without returning its value. */
export function findPlainCredential(
  value: unknown,
  path: (string | number)[] = [],
  depth = 0,
  root: unknown = value,
): PlainCredentialField | null {
  // Synthetic events are test data, not deployed component configuration.
  if (
    path[0] === "tests" &&
    typeof path[1] === "number" &&
    path[2] === "inputs" &&
    typeof path[3] === "number" &&
    ["log_fields", "metric", "value"].includes(String(path[4]))
  )
    return null;
  if (depth > 40)
    return {
      path: path
        .map((step, index) =>
          typeof step === "number"
            ? `[${step}]`
            : index === 0
              ? step
              : `.${step}`,
        )
        .join(""),
      key: String(path.at(-1) ?? "value"),
      steps: [...path],
      kind: "scan_limit",
    };
  if (value == null) return null;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    const key = String(path.at(-1) ?? "value");
    const location = path
      .map((step, index) =>
        typeof step === "number"
          ? `[${step}]`
          : index === 0
            ? step
            : `.${step}`,
      )
      .join("");
    const finding = (
      kind: PlainCredentialField["kind"],
    ): PlainCredentialField => ({
      path: location,
      key,
      steps: [...path],
      kind,
    });
    const [section, component] = path;
    const item =
      typeof section === "string" &&
      typeof component === "string" &&
      root &&
      typeof root === "object"
        ? (root as Record<string, Record<string, { type?: unknown }>>)[
            section
          ]?.[component]
        : undefined;
    const typedSecretField =
      typeof section === "string" &&
      ["sources", "transforms", "sinks"].includes(section) &&
      typeof item?.type === "string" &&
      isSecretField(section, item.type, path.slice(2));
    const typedSecretAncestor =
      typeof section === "string" &&
      ["sources", "transforms", "sinks"].includes(section) &&
      typeof item?.type === "string" &&
      path
        .slice(3)
        .some((_, index) =>
          isSecretField(section, item.type as string, path.slice(2, index + 3)),
        );
    // Only an exact value at a generated credential field can use a device
    // secret today. The server and agent refuse every other occurrence.
    if (value.includes("vectory-secret:"))
      return typedSecretField && secretNameOf(value) !== null
        ? null
        : finding("unsupported_reference");
    if (nativeReference(value)) return null;
    if (typedSecretField || typedSecretAncestor) return finding("plaintext");
    const parent = path.at(-2);
    const named =
      typeof path.at(-1) === "number"
        ? ["valid_tokens", "access_keys"].includes(normalize(String(parent)))
        : credentialKey(key);
    const header =
      typeof parent === "string" &&
      normalize(parent) === "headers" &&
      credentialHeader(key);
    const ancestorStart = ["sources", "transforms", "sinks"].includes(
      String(section),
    )
      ? 2
      : 0;
    const namedAncestor = path
      .slice(ancestorStart, -1)
      .some(
        (step, index) =>
          typeof step === "string" &&
          (credentialKey(step) ||
            (index > 0 &&
              normalize(String(path[ancestorStart + index - 1])) ===
                "headers" &&
              credentialHeader(step))),
      );
    const legacySinkAuth =
      section === "sinks" &&
      path[2] === "auth" &&
      ["user", "password", "token"].includes(String(path[3]));
    const urlFinding = urlCredential(value);
    if (urlFinding === "scan_limit") return finding("scan_limit");
    if (
      legacySinkAuth ||
      ((named || header || namedAncestor) && credentialLiteral(value)) ||
      urlFinding === "credential" ||
      tokenShape(value)
    )
      return finding("plaintext");
    return null;
  }
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findPlainCredential(
        value[index],
        [...path, index],
        depth + 1,
        root,
      );
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = findPlainCredential(entry, [...path, key], depth + 1, root);
    if (found) return found;
  }
  return null;
}

/** Safe copy for preflight failures; the value itself never enters the message. */
export function credentialPreflightMessage(finding: PlainCredentialField) {
  if (finding.kind === "scan_limit")
    return `${finding.path} is too complex to check safely for credentials. Simplify it before retrying.`;
  if (finding.kind === "unsupported_reference")
    return `${finding.path} uses a device secret outside a supported credential field. Remove it or use a supported credential field.`;
  return `${finding.path} appears to contain a credential. Remove the value before saving this request. Use a device secret in a supported component field, or a native Vector reference on a full-mode device where available.`;
}

/** All findings for shared detector fixtures and field-level import feedback. */
export function credentialFindings(config: unknown): PlainCredentialField[] {
  const findings: PlainCredentialField[] = [];
  function visit(value: unknown, path: (string | number)[], depth: number) {
    if (
      path[0] === "tests" &&
      typeof path[1] === "number" &&
      path[2] === "inputs" &&
      typeof path[3] === "number" &&
      ["log_fields", "metric", "value"].includes(String(path[4]))
    )
      return;
    if (depth > 40 || typeof value === "string") {
      const finding = findPlainCredential(value, path, depth, config);
      if (finding) findings.push(finding);
      return;
    }
    if (Array.isArray(value))
      value.forEach((entry, index) =>
        visit(entry, [...path, index], depth + 1),
      );
    else if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value))
        visit(entry, [...path, key], depth + 1);
  }
  visit(config, [], 0);
  return findings.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}
