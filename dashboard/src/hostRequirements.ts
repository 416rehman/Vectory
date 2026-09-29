/** The component catalog, read on demand: it is large and only this check needs it. */
export type AgentCatalog = typeof import("./generated/vector-catalog.json");

/**
 * What a pipeline needs from the devices that run it, worked out the way the
 * agent decides it: Full Vector mode for anything outside the restricted
 * component set, and, in restricted mode, local approval for each destination,
 * listener and file root. Read by the deploy dialog, and by anything that wants
 * to say so before a pipeline is chosen (template cards, the pipeline library).
 */
function isLoopbackSocketAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(
    value,
  );
  if (ipv4)
    return (
      Number(ipv4[1]) === 127 &&
      ipv4.slice(2, 5).every((part) => Number(part) <= 255) &&
      Number(ipv4[5]) <= 65535
    );
  if (!/^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(value)) return false;
  try {
    const address = new URL(`http://${value}`);
    return (
      address.hostname === "[::1]" &&
      Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535
    );
  } catch {
    return false;
  }
}
export function fullModeRequirements(
  config: Record<string, any>,
  agentCatalog: AgentCatalog,
): string[] {
  const required = new Set<string>();
  const restrictedRoots = new Set([
    "sources",
    "transforms",
    "sinks",
    "data_dir",
    "api",
    "acknowledgements",
    "healthchecks",
    "timezone",
  ]);
  for (const key of Object.keys(config))
    if (!restrictedRoots.has(key)) required.add(`Global setting: ${key}`);
  if (
    config.api?.enabled === true &&
    !isLoopbackSocketAddress(config.api.address)
  )
    required.add("API listener outside loopback");
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
    }
  }
  function inspect(value: any) {
    if (typeof value === "string") {
      if (/\$[A-Za-z_{]|SECRET\[|\{\{|%\{/.test(value))
        required.add("Native secrets, environment values or dynamic templates");
      if (
        /get_env_var|get_secret|set_secret|remove_secret|dns_lookup|get_enrichment_table|find_enrichment_table/i.test(
          value,
        )
      )
        required.add("VRL access to device resources");
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (
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
          ["verify_certificate", "verify_hostname"].includes(
            key.toLowerCase(),
          ) &&
          child === false
        )
          required.add("Disabled TLS verification");
        inspect(child);
      }
  }
  inspect(config);
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
  const walk = (value: unknown, key: string) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === "object")
      for (const [child, nested] of Object.entries(value))
        walk(nested, child.toLowerCase());
    else if (typeof value === "string") {
      if (destinationKeys.has(key) || value.includes("://")) {
        const found = destination(value);
        if (found) destinations.add(found);
      }
      if (key === "address") listeners.add(value);
      if (
        (key === "include" ||
          key === "exclude" ||
          key === "path" ||
          key.endsWith("_file") ||
          key.endsWith("_path") ||
          key.endsWith("_dir")) &&
        value.startsWith("/")
      )
        fileRoots.add(fileRoot(value));
    }
  };
  for (const kind of ["sources", "transforms", "sinks"])
    walk(config[kind] || {}, kind);
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
