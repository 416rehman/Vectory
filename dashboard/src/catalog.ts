import type { Config, Graph } from "./api";
export type Kind = "sources" | "transforms" | "sinks";
export type Component = {
  type: string;
  label: string;
  kind: Kind;
  description: string;
  defaults: Config;
  fields: {
    key: string;
    label: string;
    type?: "number" | "vrl" | "array" | "boolean";
    required?: boolean;
  }[];
};
export const catalog: Component[] = [
  {
    type: "demo_logs",
    label: "Demo logs",
    kind: "sources",
    description: "Generate synthetic events for a safe first pipeline.",
    defaults: { format: "json", interval: 1 },
    fields: [
      { key: "format", label: "Log format", required: true },
      { key: "interval", label: "Interval (seconds)", type: "number" },
    ],
  },
  {
    type: "file",
    label: "File",
    kind: "sources",
    description: "Read log files from approved paths on your device.",
    defaults: { include: ["/var/log/app/*.log"] },
    fields: [
      {
        key: "include",
        label: "Included paths",
        type: "array",
        required: true,
      },
    ],
  },
  {
    type: "syslog",
    label: "Syslog",
    kind: "sources",
    description: "Receive standard syslog messages over TCP.",
    defaults: { address: "127.0.0.1:5140", mode: "tcp" },
    fields: [
      { key: "address", label: "Listen address", required: true },
      { key: "mode", label: "Transport", required: true },
    ],
  },
  {
    type: "http_server",
    label: "HTTP server",
    kind: "sources",
    description: "Accept events through a local HTTP endpoint.",
    defaults: { address: "127.0.0.1:8088", encoding: "json" },
    fields: [
      { key: "address", label: "Listen address", required: true },
      { key: "encoding", label: "Encoding", required: true },
    ],
  },
  {
    type: "opentelemetry",
    label: "OpenTelemetry",
    kind: "sources",
    description: "Receive OTLP logs, metrics, and traces.",
    defaults: {
      grpc: { address: "127.0.0.1:4317" },
      http: { address: "127.0.0.1:4318" },
    },
    fields: [],
  },
  {
    type: "remap",
    label: "Remap",
    kind: "transforms",
    description: "Parse, enrich, and reshape events with VRL.",
    defaults: { source: '.environment = "development"' },
    fields: [
      { key: "source", label: "VRL program", type: "vrl", required: true },
    ],
  },
  {
    type: "filter",
    label: "Filter",
    kind: "transforms",
    description: "Keep only the events that match a condition.",
    defaults: { condition: '.level != "debug"' },
    fields: [
      { key: "condition", label: "VRL condition", type: "vrl", required: true },
    ],
  },
  {
    type: "route",
    label: "Route",
    kind: "transforms",
    description: "Send events to named conditional outputs.",
    defaults: {
      route: { errors: '.level == "error"', other: '.level != "error"' },
    },
    fields: [],
  },
  {
    type: "sample",
    label: "Sample",
    kind: "transforms",
    description: "Retain a representative subset of events.",
    defaults: { rate: 10 },
    fields: [
      { key: "rate", label: "One in every", type: "number", required: true },
    ],
  },
  {
    type: "console",
    label: "Console",
    kind: "sinks",
    description: "Inspect synthetic events in standard error.",
    defaults: { encoding: { codec: "json" }, target: "stderr" },
    fields: [
      { key: "encoding.codec", label: "Encoding", required: true },
      { key: "target", label: "Output target" },
    ],
  },
  {
    type: "http",
    label: "HTTP",
    kind: "sinks",
    description: "Deliver events to an approved HTTPS endpoint.",
    defaults: { uri: "https://logs.example.com", encoding: { codec: "json" } },
    fields: [
      { key: "uri", label: "Destination URL", required: true },
      { key: "encoding.codec", label: "Encoding", required: true },
    ],
  },
  {
    type: "elasticsearch",
    label: "Elasticsearch",
    kind: "sinks",
    description: "Index events in an Elasticsearch cluster.",
    defaults: {
      endpoints: ["https://elasticsearch.example.com:9200"],
      mode: "bulk",
    },
    fields: [
      { key: "endpoints", label: "Endpoints", type: "array", required: true },
    ],
  },
  {
    type: "loki",
    label: "Grafana Loki",
    kind: "sinks",
    description: "Ship labeled logs to a Loki endpoint.",
    defaults: {
      endpoint: "https://loki.example.com",
      encoding: { codec: "json" },
      labels: { service: "vectory" },
    },
    fields: [{ key: "endpoint", label: "Endpoint", required: true }],
  },
];
export const starter: Config = {
  sources: { demo: { type: "demo_logs", format: "json", interval: 1 } },
  transforms: {
    enrich: {
      type: "remap",
      inputs: ["demo"],
      source: '.environment = "development"\n.managed_by = "vectory"',
    },
  },
  sinks: {
    output: {
      type: "console",
      inputs: ["enrich"],
      encoding: { codec: "json" },
      target: "stderr",
    },
  },
};
export function getPath(value: Config, path: string): any {
  return path.split(".").reduce((o, k) => o?.[k], value);
}
export function outputPorts(component: Config): string[] {
  if (component.type === "route")
    return [...Object.keys(component.route || {}), "_unmatched"];
  if (component.type === "opentelemetry") return ["logs", "metrics", "traces"];
  if (component.type === "remap" && component.reroute_dropped === true)
    return ["output", "dropped"];
  return ["output"];
}
type EventType = "logs" | "metrics" | "traces";
const allEvents: EventType[] = ["logs", "metrics", "traces"];
function acceptedEvents(type: string): EventType[] {
  if (["sample"].includes(type)) return ["logs", "traces"];
  if (["loki", "elasticsearch", "reduce", "log_to_metric"].includes(type))
    return ["logs"];
  if (type === "prometheus_exporter") return ["metrics"];
  return allEvents;
}
function inferEvents(
  config: Config,
  reference: string,
  seen = new Set<string>(),
): EventType[] {
  const [id, port] = reference.split(".");
  if (seen.has(id)) return allEvents;
  seen.add(id);
  const c = config.sources?.[id] || config.transforms?.[id];
  if (!c) return allEvents;
  if (c.type === "opentelemetry" && allEvents.includes(port as EventType))
    return [port as EventType];
  if (["demo_logs", "file", "syslog", "http_server"].includes(c.type))
    return ["logs"];
  if (["internal_metrics", "log_to_metric"].includes(c.type))
    return ["metrics"];
  if (
    ["remap", "filter", "route", "sample", "reduce"].includes(c.type) &&
    Array.isArray(c.inputs)
  )
    return [
      ...new Set<EventType>(
        c.inputs.flatMap((input: unknown) =>
          typeof input === "string"
            ? inferEvents(config, input, new Set(seen))
            : allEvents,
        ),
      ),
    ];
  return allEvents;
}
export function setPath(value: Config, path: string, next: any): Config {
  const copy = structuredClone(value);
  const parts = path.split(".");
  let at = copy;
  for (const key of parts.slice(0, -1)) {
    at[key] ??= {};
    at = at[key];
  }
  at[parts.at(-1)!] = next;
  return copy;
}
export function toGraph(config: Config, existing?: Graph): Graph {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (const [col, kind] of (
    ["sources", "transforms", "sinks"] as Kind[]
  ).entries()) {
    Object.entries(config[kind] || {}).forEach(
      ([id, component]: [string, any], i) => {
        if (
          !component ||
          typeof component !== "object" ||
          Array.isArray(component)
        )
          return;
        const old = existing?.nodes.find((n) => n.id === id);
        nodes.push({
          id,
          type: "component",
          position: old?.position || { x: col * 290 + 60, y: i * 170 + 100 },
          data: { kind, component, label: id },
        });
        for (const [j, input] of (Array.isArray(component.inputs)
          ? component.inputs
          : []
        ).entries()) {
          if (typeof input !== "string") continue;
          const dot = input.indexOf(".");
          edges.push({
            id: `${input}-${id}-${j}`,
            source: dot < 0 ? input : input.slice(0, dot),
            sourceHandle: dot < 0 ? "output" : input.slice(dot + 1),
            target: id,
            targetHandle: "input",
            type: "smoothstep",
            animated: false,
          });
        }
      },
    );
  }
  for (const node of nodes)
    node.data.disconnected =
      node.data.kind === "sources"
        ? !edges.some((e) => e.source === node.id)
        : !edges.some((e) => e.target === node.id);
  return { nodes, edges };
}
export function validateGraph(config: Config): string[] {
  const errors: string[] = [];
  const all = new Map<string, { kind: Kind; c: Config }>();
  for (const kind of ["sources", "transforms", "sinks"] as Kind[])
    for (const [id, c] of Object.entries(config[kind] || {}) as [
      string,
      Config,
    ][]) {
      if (all.has(id)) errors.push(`Duplicate component ID: ${id}`);
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id))
        errors.push(`Invalid component ID: ${id}`);
      if (
        !c ||
        typeof c !== "object" ||
        Array.isArray(c) ||
        typeof c.type !== "string"
      ) {
        errors.push(`${id}: component type is required`);
        continue;
      }
      all.set(id, { kind, c });
    }
  for (const [id, { kind, c }] of all) {
    if (kind !== "sources" && (!Array.isArray(c.inputs) || !c.inputs.length))
      errors.push(`${id}: connect at least one input`);
    for (const input of Array.isArray(c.inputs) ? c.inputs : []) {
      if (typeof input !== "string") {
        errors.push(`${id}: input must be a string`);
        continue;
      }
      const [source, ...outputs] = input.split(".");
      const item = all.get(source);
      if (!item) errors.push(`${id}: missing input ${input}`);
      else if (item.kind === "sinks")
        errors.push(`${id}: a sink cannot be an input`);
      else if (
        outputs.length &&
        !outputPorts(item.c).includes(outputs.join("."))
      )
        errors.push(`${id}: unknown output ${input}`);
      else if (!outputPorts(item.c).includes("output") && !outputs.length)
        errors.push(
          `${id}: choose a named ${item.c.type === "route" ? "route" : "component"} output`,
        );
      else if (
        item &&
        !inferEvents(config, input).some((type) =>
          acceptedEvents(c.type).includes(type),
        )
      )
        errors.push(`${id}: incompatible event types from ${input}`);
    }
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) {
      errors.push(`Cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    for (const input of Array.isArray(all.get(id)?.c.inputs)
      ? all.get(id)!.c.inputs
      : [])
      if (typeof input === "string") visit(input.split(".")[0]);
    active.delete(id);
    visited.add(id);
  }
  for (const id of all.keys()) visit(id);
  return [...new Set(errors)];
}
export function connect(
  config: Config,
  source: string,
  target: string,
  handle = "output",
): Config {
  const copy = structuredClone(config);
  const src = (["sources", "transforms", "sinks"] as Kind[]).find(
    (k) => copy[k]?.[source],
  );
  const dst = (["sources", "transforms", "sinks"] as Kind[]).find(
    (k) => copy[k]?.[target],
  );
  if (!src || !dst || src === "sinks" || dst === "sources" || source === target)
    throw Error("Connect a source or transform to a transform or sink.");
  const ref = handle === "output" ? source : `${source}.${handle}`;
  copy[dst][target].inputs = [
    ...new Set([
      ...(Array.isArray(copy[dst][target].inputs)
        ? copy[dst][target].inputs
        : []),
      ref,
    ]),
  ];
  const errors = validateGraph(copy).filter(
    (e) =>
      e.startsWith("Cycle") ||
      (e.startsWith(target + ":") &&
        /incompatible|unknown output|named .+ output/.test(e)),
  );
  if (errors.length) throw Error(errors[0]);
  return copy;
}
