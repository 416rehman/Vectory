import { fileArgumentCalls } from "./vrlFileArguments";

/** The component catalog, read on demand: it is large and only this check needs it. */
export type AgentCatalog = typeof import("./generated/vector-catalog.json");

/**
 * VRL functions that reach outside the event: the environment, secrets,
 * enrichment tables, DNS, HTTP and files (a JSON schema or a protobuf
 * descriptor). A restricted device refuses them. The same names are in the
 * server (`DEVICE_VRL_FUNCTIONS`) and the agent (`externalVRL`);
 * `tests/security/test_vrl_function_lists.py` fails when the lists drift.
 * `parse_etld` and `parse_groks` reach a file only when a call passes one, so
 * they are not listed here: see `fileArgumentFunctions`.
 */
export const deviceVrlFunctions = [
  "get_env_var",
  "get_secret",
  "set_secret",
  "remove_secret",
  "get_enrichment_table_record",
  "find_enrichment_table_records",
  "dns_lookup",
  "reverse_dns",
  "http_request",
  "validate_json_schema",
  "parse_proto",
  "encode_proto",
] as const;
/**
 * A call, not a mention: `name(` or `name!(` that is not the end of a longer
 * identifier or a field path. A metric named `http_requests_total` or an event
 * value `"http_request"` is data. The server and the agent match the same way.
 */
const deviceVrlCall = new RegExp(
  `(?:^|[^A-Za-z0-9_.])(?:${deviceVrlFunctions.join("|")})\\s*(?:!\\s*)?\\(`,
);
export function callsDeviceFunction(program: string): boolean {
  return deviceVrlCall.test(program);
}
/**
 * Why a pipeline's `api` block needs a full-mode device, whatever its address
 * and whether or not it is enabled: the one sentence the dashboard gives.
 */
export const localApiReason =
  "Vector's local API has no authentication; any local user could read live events";
/**
 * The two AWS credential shapes no host allowance can permit. A credentials
 * file can make Vector run a program, and an AWS-signing sink without explicit
 * keys signs with the host's own identity. The agent (`policy.go`) and the
 * server (`rollout.rs`) hold the same rules, with the same names and paths;
 * `tests/security/test_capability_lists.py` fails when the copies drift.
 */
const credentialsFileKey = "credentials_file";
const awsExplicitKeys = ["access_key_id", "secret_access_key"];
const awsAmbientKeys = ["assume_role", "imds", "profile"];
/**
 * Where each restricted-mode sink that takes an AWS credential reads it once
 * `auth.strategy` is `aws`: Elasticsearch flattens the credential into `auth`,
 * the shared HTTP authentication of the others nests it as `auth.auth`.
 */
const awsCredentialPaths = new Map([
  ["elasticsearch", ["auth"]],
  ["http", ["auth", "auth"]],
  ["loki", ["auth", "auth"]],
  ["prometheus_exporter", ["auth", "auth"]],
]);
/**
 * Space as Go's `strings.TrimSpace` and Rust's `trim` read it, which the agent
 * and the server use to tell a blank key from a real one. `String.trim` also
 * trims U+FEFF and leaves U+0085.
 */
const blank =
  /^[\t-\r \u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*$/u;
function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/**
 * Whether a `credentials_file` key stands anywhere below an `auth` key, however
 * deep, in an object or a list, with either name in any case.
 */
function credentialsFileBelowAuth(value: unknown, belowAuth = false): boolean {
  if (Array.isArray(value))
    return value.some((item) => credentialsFileBelowAuth(item, belowAuth));
  return Object.entries(asObject(value) ?? {}).some(([key, child]) => {
    const lower = key.toLowerCase();
    return (
      (belowAuth && lower === credentialsFileKey) ||
      credentialsFileBelowAuth(child, belowAuth || lower === "auth")
    );
  });
}
/**
 * Whether an AWS credential object names its own keys and borrows nothing from
 * the host: both keys are non-blank strings, and no role to assume, metadata
 * client setting or profile is set (null and false mean not set).
 */
function explicitAwsCredential(credential: Record<string, unknown> = {}) {
  return (
    awsExplicitKeys.every((key) => {
      const value = credential[key];
      return typeof value === "string" && !blank.test(value);
    }) &&
    Object.entries(credential).every(
      ([key, value]) =>
        !awsAmbientKeys.includes(key.toLowerCase()) ||
        value == null ||
        value === false,
    )
  );
}
/**
 * Whether a sink signs with the AWS strategy and its credential, in the object
 * where that sink reads it, is not explicit. Only that object counts: keys
 * anywhere else make nothing explicit.
 */
function signsWithHostIdentity(component: any) {
  const path = awsCredentialPaths.get(component?.type);
  const strategy = asObject(component?.auth)?.strategy;
  if (!path || typeof strategy !== "string" || strategy.toLowerCase() !== "aws")
    return false;
  let credential = asObject(component);
  for (const key of path) credential = asObject(credential?.[key]);
  return !explicitAwsCredential(credential);
}
/**
 * What a pipeline needs from the devices that run it, worked out the way the
 * server and the agent decide it: Full Vector mode for anything outside the
 * restricted component set, and, in restricted mode, local approval for each
 * destination, listener and file root. Read by the deploy dialog, and by
 * anything that wants to say so before a pipeline is chosen (template cards,
 * the pipeline library).
 */
export function fullModeRequirements(
  config: Record<string, any>,
  agentCatalog: AgentCatalog,
): string[] {
  const required = new Set<string>();
  // `api` is not among them: Vector's local API has no authentication, so the
  // host decides whether it exists, never a pipeline.
  const restrictedRoots = new Set([
    "sources",
    "transforms",
    "sinks",
    "data_dir",
    "acknowledgements",
    "healthchecks",
    "timezone",
    "tests",
  ]);
  for (const key of Object.keys(config))
    if (!restrictedRoots.has(key))
      required.add(
        key === "api"
          ? `Global setting: api (${localApiReason})`
          : `Global setting: ${key}`,
      );
  for (const kind of ["sources", "transforms", "sinks"]) {
    for (const component of Object.values(config[kind] || {}) as any[]) {
      if (
        !agentCatalog.components.some(
          (known) =>
            known.kind === kind &&
            known.type === component?.type &&
            known.device_capability === "allowed",
        )
      )
        required.add(`${kind.slice(0, -1)}: ${component?.type || "unknown"}`);
      if (component?.type === "console" && component.target !== "stderr")
        required.add("Console output to stdout");
      // `remap.file` loads a VRL program from the device's disk.
      if (
        kind === "transforms" &&
        component?.type === "remap" &&
        component.file != null
      )
        required.add("Native capability: file");
      // No host allowance permits an AWS credentials file or the host's own
      // AWS identity.
      if (credentialsFileBelowAuth(component))
        required.add(`Native capability: ${credentialsFileKey}`);
      if (signsWithHostIdentity(component))
        required.add(
          "AWS credentials from the host (without both keys, or with assume_role, imds or profile)",
        );
    }
  }
  /**
   * Unit tests insert sample events into transforms: their events are data,
   * not resources, so only their VRL can need a full-mode device.
   */
  function inspect(value: any, testsOnly = false) {
    if (typeof value === "string") {
      if (!testsOnly && /\$[A-Za-z_{]|SECRET\[|\{\{|%\{/.test(value))
        required.add("Native secrets, environment values or dynamic templates");
      if (callsDeviceFunction(value) || fileArgumentCalls(value).length > 0)
        required.add("VRL access to device resources");
    } else if (Array.isArray(value))
      value.forEach((item) => inspect(item, testsOnly));
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (
          !testsOnly &&
          [
            "command",
            "exec",
            "provider",
            "secret",
            "secrets",
            "source_files",
            "files",
            "enrichment_tables",
          ].includes(key.toLowerCase())
        )
          required.add(`Native capability: ${key}`);
        if (
          !testsOnly &&
          ["verify_certificate", "verify_hostname"].includes(
            key.toLowerCase(),
          ) &&
          child === false
        )
          required.add("Disabled TLS verification");
        inspect(child, testsOnly);
      }
  }
  for (const [key, child] of Object.entries(config)) {
    if (key === "tests") inspect(child, true);
    else inspect({ [key]: child });
  }
  return [...required];
}

/** What a restricted device must approve locally before it runs a config. */
export type HostApprovals = {
  destinations: string[];
  listeners: string[];
  fileRoots: string[];
};
const destinationKeys = new Set(["endpoint", "endpoints", "uri", "url"]);
function destination(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const host = url.hostname.toLowerCase();
    return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  } catch {
    return null;
  }
}
/**
 * Whether an address is a loopback IP literal with a port, such as
 * 127.0.0.1:9598 or [::1]:9598 (as the agent decides it; a name like
 * localhost is not one).
 */
export function loopbackListener(address: string) {
  const match =
    /^(?:\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(
      address,
    );
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return false;
  const ipv4 = (value: string) => {
    const octets = value.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && +octet < 256)
    );
  };
  if (match[2]) return ipv4(match[2]) && match[2].startsWith("127.");
  const host = match[1].toLowerCase();
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) return ipv4(mapped[1]) && mapped[1].startsWith("127.");
  return /^(0{0,4}:){2,7}0{0,3}1$/.test(host) || host === "::1";
}
/**
 * The loopback Prometheus exporter fed only by internal_metrics sources that
 * restricted mode runs without a listener allowance: Vectory's monitoring
 * pair (the first such sink by ID, as the agent picks it). Null when the
 * pipeline has none.
 */
export function monitoringExporter(config: Record<string, unknown>) {
  const sources = (config.sources as Record<string, any>) || {};
  const sinks = (config.sinks as Record<string, any>) || {};
  for (const id of Object.keys(sinks).sort()) {
    const sink = sinks[id];
    if (
      sink?.type === "prometheus_exporter" &&
      typeof sink.address === "string" &&
      loopbackListener(sink.address) &&
      Array.isArray(sink.inputs) &&
      sink.inputs.length > 0 &&
      sink.inputs.every(
        (input: unknown) =>
          typeof input === "string" &&
          sources[input]?.type === "internal_metrics",
      )
    )
      return id;
  }
  return null;
}
/** The directory to approve for a path: the part before any wildcard. */
function fileRoot(path: string) {
  const wildcard = path.search(/[*?[]/);
  if (wildcard < 0) return path.replace(/\/+$/, "") || "/";
  const head = path.slice(0, wildcard);
  return head.slice(0, head.lastIndexOf("/")) || "/";
}
/**
 * Destinations, listeners and file roots a pipeline uses, found the way the
 * agent's restricted-mode check finds them. A restricted host refuses the
 * version until its local allowances list each one; the dashboard can't grant
 * them.
 */
export function hostApprovals(config: Record<string, unknown>): HostApprovals {
  const destinations = new Set<string>();
  const listeners = new Set<string>();
  const fileRoots = new Set<string>();
  // A `path` names a file only for a Unix socket. For an http_server or loki
  // it is the URL path, which needs no file allowance.
  const walk = (value: unknown, key: string, pathIsFile: boolean) => {
    if (Array.isArray(value))
      value.forEach((item) => walk(item, key, pathIsFile));
    else if (value && typeof value === "object")
      for (const [child, nested] of Object.entries(value))
        walk(nested, child.toLowerCase(), pathIsFile);
    else if (typeof value === "string") {
      if (destinationKeys.has(key) || value.includes("://")) {
        const found = destination(value);
        if (found) destinations.add(found);
      }
      if (key === "address") listeners.add(value);
      if (
        (key === "include" ||
          key === "exclude" ||
          (key === "path" && pathIsFile) ||
          key.endsWith("_file") ||
          key.endsWith("_path") ||
          key.endsWith("_dir")) &&
        value.startsWith("/")
      )
        fileRoots.add(fileRoot(value));
    }
  };
  // Restricted mode runs the monitoring exporter without an allowance.
  const exporter = monitoringExporter(config);
  for (const kind of ["sources", "transforms", "sinks"])
    for (const [id, component] of Object.entries(
      (config[kind] as Record<string, any>) || {},
    ))
      walk(
        kind === "sinks" && id === exporter
          ? { ...component, address: undefined }
          : component,
        kind,
        component?.type === "syslog" && component?.mode === "unix",
      );
  if (typeof config.data_dir === "string" && config.data_dir.startsWith("/"))
    fileRoots.add(fileRoot(config.data_dir));
  return {
    destinations: [...destinations].sort(),
    listeners: [...listeners].sort(),
    fileRoots: [...fileRoots].sort(),
  };
}
export function hasHostApprovals(approvals: HostApprovals) {
  return (
    approvals.destinations.length +
      approvals.listeners.length +
      approvals.fileRoots.length >
    0
  );
}
/** The allowances file a restricted host needs for these approvals. */
export function allowancesFile(approvals: HostApprovals) {
  return JSON.stringify(
    {
      allowed_file_roots: approvals.fileRoots,
      allowed_network_hosts: approvals.destinations,
      allowed_listen_addresses: approvals.listeners,
    },
    null,
    2,
  );
}

/**
 * One short chip for a template card or a pipeline row: "Full Vector" when a
 * restricted device would refuse it outright, "Host approval: ..." when the host
 * has to allow its destinations, listeners or paths, or null when any device
 * runs it as is.
 */
export function describeNeeds(
  config: Record<string, unknown>,
  agentCatalog: AgentCatalog,
): {
  kind: "full" | "approval" | "none";
  label: string | null;
  detail: string | null;
} {
  const full = fullModeRequirements(
    config as Record<string, any>,
    agentCatalog,
  );
  if (full.length)
    return {
      kind: "full",
      label: "Needs Full Vector",
      detail: `Uses ${full.join(", ")}. Runs only on devices in Full Vector mode.`,
    };
  const approvals = hostApprovals(config);
  const items = [
    ...approvals.fileRoots,
    ...approvals.destinations,
    ...approvals.listeners,
  ];
  if (!items.length) return { kind: "none", label: null, detail: null };
  const shown = items.slice(0, 2).join(", ");
  return {
    kind: "approval",
    label: `Host approval: ${shown}${items.length > 2 ? ` +${items.length - 2}` : ""}`,
    detail: `A restricted device runs it after its host approves ${items.join(", ")}.`,
  };
}
