import { isSecretReference } from "./pipelineSchema";
import { isSecretField, secretNameOf } from "./secretFields";

export type PlainCredentialField = {
  path: string;
  key: string;
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
  [
    "token",
    "key",
    "secret",
    "auth",
    "team",
    "cookie",
    "signature",
    "session",
  ].some((part) => name.toLowerCase().includes(part));
const nativeReference = (text: string) =>
  !text.includes("vectory-secret:") && isSecretReference(text);
const placeholder = (text: string) =>
  ["changeme", "example", "redacted", "xxxxxxxx"].includes(
    text
      .trim()
      .replace(/^(?:Bearer|Basic) /, "")
      .toLowerCase(),
  );
const credentialLiteral = (text: string) => {
  const assignment = /^[A-Za-z0-9_.-]+=([^=;\s]+)$/.exec(text);
  const trailingValue = assignment?.[1] ?? text.replace(/^Token /, "");
  return (
    text.length > 0 &&
    !placeholder(text) &&
    !nativeReference(text) &&
    !nativeReference(trailingValue)
  );
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

function urlCredential(text: string): boolean {
  for (const candidate of text.match(/[A-Za-z0-9+.-]*:\/\/[^\s"'<>\\)]+/g) ??
    []) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      const tail = candidate.split("://", 2)[1] ?? "";
      const authority = tail.split(/[/?#]/, 1)[0];
      const userinfo = authority.includes("@")
        ? authority.split("@", 1)[0]
        : null;
      if (userinfo !== null && !userinfo.split(":").every(nativeReference))
        return true;
      const query = tail.split("?", 2)[1]?.split("#", 1)[0];
      if (query) {
        for (const [name, entry] of new URLSearchParams(query)) {
          if (queryNames.has(normalize(name)) && credentialLiteral(entry))
            return true;
        }
      }
      continue;
    }
    const nativeUserinfo = (part: string) => {
      try {
        return !part || nativeReference(decodeURIComponent(part));
      } catch {
        return false;
      }
    };
    if (!nativeUserinfo(url.username) || !nativeUserinfo(url.password))
      return true;
    for (const [name, entry] of url.searchParams) {
      if (queryNames.has(normalize(name)) && credentialLiteral(entry))
        return true;
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
      credentialLiteral(discord ? segments[3] : (segments.at(-1) ?? ""))
    )
      return true;
  }
  return false;
}

/** Locate a likely plaintext credential without returning its value. */
export function findPlainCredential(
  value: unknown,
  path: (string | number)[] = [],
  depth = 0,
  root: unknown = value,
): PlainCredentialField | null {
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
    ): PlainCredentialField => ({ path: location, key, kind });
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
    // Only an exact value at a generated credential field can use a device
    // secret today. The server and agent refuse every other occurrence.
    if (value.includes("vectory-secret:"))
      return typedSecretField && secretNameOf(value) !== null
        ? null
        : finding("unsupported_reference");
    if (nativeReference(value)) return null;
    if (typedSecretField) return finding("plaintext");
    const parent = path.at(-2);
    const named =
      typeof path.at(-1) === "number"
        ? ["valid_tokens", "access_keys"].includes(normalize(String(parent)))
        : credentialKey(key);
    const header = parent === "headers" && credentialHeader(key);
    const legacySinkAuth =
      section === "sinks" &&
      path.length === 4 &&
      path[2] === "auth" &&
      ["user", "password", "token"].includes(key);
    if (
      legacySinkAuth ||
      ((named || header) && credentialLiteral(value)) ||
      urlCredential(value) ||
      (["sources", "transforms", "sinks"].includes(String(section)) &&
        tokenShape(value))
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
