import type { Config, Graph } from "./api";
import generatedCatalog from "./generated/vector-catalog.json";
import generatedSchema from "./generated/vector-schema.json";
import {
  requiredSchemaIssues,
  isSecretReference,
  type Schema,
} from "./pipelineSchema";
export const vectorSchema: Schema = generatedSchema;
export const vectorCatalogVersion = generatedCatalog.vector_version;
export type Kind = "sources" | "transforms" | "sinks";
export type Component = {
  type: string;
  label: string;
  kind: Kind;
  description: string;
  defaults: Config;
  schema_ref?: string;
  docs_url?: string;
  device_capability?: string;
  coverage?: string;
  platforms?: string[];
  curated?: boolean;
  fields: {
    key: string;
    label: string;
    type?: "number" | "vrl" | "array" | "boolean";
    required?: boolean;
    hint?: string;
    options?: string[];
  }[];
};
/**
 * A new remap step: a short guide in comments only, so a new step passes
 * events through unchanged until you write the first line.
 */
export const REMAP_STARTER = `# Runs once for every event; "." is the event. Uncomment a line to try it.
# Set a field:      .environment = "production"
# Remove a field:   del(.password)
# Parse JSON text:  . = merge(., object!(parse_json!(.message)))
`;
const curatedCatalog: Component[] = [
  {
    type: "demo_logs",
    label: "Synthetic logs",
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
    label: "Log files",
    kind: "sources",
    description: "Read log files from approved paths on your device.",
    defaults: { include: [] },
    fields: [
      {
        key: "include",
        label: "Included paths",
        type: "array",
        required: true,
        hint: "One path per line, such as /var/log/app/*.log. Paths must be allowed on the device.",
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
    label: "HTTP endpoint",
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
    fields: [
      {
        key: "grpc.address",
        label: "gRPC listen address",
        required: true,
        hint: "Local address for OTLP gRPC, usually 127.0.0.1:4317.",
      },
      {
        key: "http.address",
        label: "HTTP listen address",
        required: true,
        hint: "Local address for OTLP HTTP, usually 127.0.0.1:4318.",
      },
    ],
  },
  {
    type: "remap",
    label: "Edit fields",
    kind: "transforms",
    description: "Parse, enrich, and reshape events with VRL.",
    defaults: { source: REMAP_STARTER },
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
    label: "Route by condition",
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
    label: "Console output",
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
    label: "HTTP destination",
    kind: "sinks",
    description: "Deliver events to an approved HTTPS endpoint.",
    defaults: { uri: "", encoding: { codec: "json" } },
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
      endpoints: [],
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
      endpoint: "",
      encoding: { codec: "json" },
      labels: { job: "vector" },
    },
    fields: [{ key: "endpoint", label: "Endpoint", required: true }],
  },
];
/**
 * The one name for each component type, used by the node card, picker,
 * inspector, Problems panel and publish review. The Vector type is shown
 * beside it in mono.
 */
const DISPLAY_LABELS: Record<string, string> = {
  aws_s3: "Amazon S3",
  aws_cloudwatch_logs: "CloudWatch Logs",
  aws_cloudwatch_metrics: "CloudWatch Metrics",
  aws_kinesis_firehose: "Amazon Data Firehose",
  aws_kinesis_streams: "Amazon Kinesis",
  datadog_agent: "Datadog Agent",
  datadog_logs: "Datadog Logs",
  datadog_metrics: "Datadog Metrics",
  datadog_traces: "Datadog Traces",
  datadog_events: "Datadog Events",
  gcp_cloud_storage: "Google Cloud Storage",
  gcp_pubsub: "Google Cloud Pub/Sub",
  kafka: "Apache Kafka",
  opentelemetry: "OpenTelemetry",
  kubernetes_logs: "Kubernetes Logs",
  docker_logs: "Docker Logs",
  remap: "Remap",
  route: "Route",
  exclusive_route: "Exclusive route",
  sample: "Sample",
  filter: "Filter",
  http_server: "HTTP Server",
  http_client: "HTTP Client",
  splunk_hec_logs: "Splunk HEC Logs",
  splunk_hec_metrics: "Splunk HEC Metrics",
  "sources:file": "Log files",
  "sinks:file": "File output",
  demo_logs: "Demo logs",
  console: "Console",
  blackhole: "Discard events",
};

/**
 * Words people search for that a component's name or description leaves out:
 * the products it reads (nginx, apache), the job it does (archive, discard)
 * and the names other tools use for it.
 */
const SEARCH_KEYWORDS: Record<string, string> = {
  "sources:file":
    "nginx apache httpd haproxy log logs files tail read path glob access error application app text disk",
  "sources:syslog": "rsyslog syslog-ng linux messages network udp tcp",
  "sources:journald": "systemd journal linux service units",
  "sources:kubernetes_logs": "k8s kubernetes pods containers cluster",
  "sources:docker_logs": "container containers docker compose",
  "sources:demo_logs": "synthetic sample test fake generate example demo",
  "sources:http_server": "webhook http endpoint receive listen post rest api",
  "sources:opentelemetry": "otel otlp collector traces metrics logs grpc",
  "sources:host_metrics": "cpu memory disk network system node machine",
  "sources:internal_metrics": "vector monitoring self telemetry health",
  "sources:kafka": "redpanda topic consumer stream queue",
  "sources:prometheus_scrape": "scrape exporter metrics endpoint",
  "sources:stdin": "pipe standard input terminal",
  "transforms:remap":
    "vrl edit fields parse modify rename script code json regex",
  "transforms:route": "split branch condition if else fan out",
  "transforms:exclusive_route": "split branch condition if else first match",
  "transforms:filter": "drop keep discard where condition remove",
  "transforms:sample": "sampling reduce volume rate percent thin",
  "transforms:dedupe": "duplicates duplicate unique repeated",
  "transforms:reduce": "aggregate combine multiline merge group stack trace",
  "transforms:throttle": "rate limit cap quota burst",
  "transforms:log_to_metric": "counter gauge histogram convert",
  "sinks:aws_s3": "s3 amazon aws bucket archive object storage backup",
  "sinks:loki": "grafana logs labels",
  "sinks:elasticsearch": "opensearch elk search index kibana",
  "sinks:console": "stdout stderr print debug terminal",
  "sinks:blackhole": "discard drop null devnull throw away",
  "sinks:prometheus_exporter": "scrape metrics grafana endpoint",
  "sinks:http": "webhook post rest api endpoint",
  "sinks:file": "write disk local save",
  "sinks:kafka": "redpanda topic producer stream queue",
  "sinks:datadog_logs": "dd datadog",
  "sinks:splunk_hec_logs": "splunk hec",
};
export function searchKeywords(kind: Kind, type: string) {
  return SEARCH_KEYWORDS[`${kind}:${type}`] || "";
}

export function displayLabel(type: string, kind?: Kind, fallback?: string) {
  return (
    (kind && DISPLAY_LABELS[`${kind}:${type}`]) ||
    (Object.hasOwn(DISPLAY_LABELS, type) ? DISPLAY_LABELS[type] : "") ||
    fallback ||
    type ||
    "Component"
  );
}
// Starting values for schema-only components where Vector needs a choice.
const schemaDefaults: Record<string, Config> = {
  "sinks:aws_s3": { encoding: { codec: "json" }, compression: "gzip" },
};
export const catalog: Component[] = [
  ...curatedCatalog.map(
    (item) =>
      ({
        ...generatedCatalog.components.find(
          (component) =>
            component.kind === item.kind && component.type === item.type,
        ),
        ...item,
        label: displayLabel(item.type, item.kind, item.label),
        curated: true,
      }) as Component,
  ),
  ...generatedCatalog.components
    .filter(
      (component) =>
        !curatedCatalog.some(
          (item) =>
            item.kind === component.kind && item.type === component.type,
        ),
    )
    .map(
      (component) =>
        ({
          ...component,
          label: displayLabel(
            component.type,
            component.kind as Kind,
            component.label,
          ),
          kind: component.kind as Kind,
          defaults: structuredClone(
            schemaDefaults[`${component.kind}:${component.type}`] ?? {},
          ),
          fields: [],
          curated: false,
        }) as Component,
    ),
];
export function componentSchema(component: Component): Schema | undefined {
  return component.schema_ref ? { $ref: component.schema_ref } : undefined;
}
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
export function sameConfiguration(left: Config, right: Config): boolean {
  const canonical = (value: Config) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  return canonical(left) === canonical(right);
}
export function getPath(value: Config, path: string): any {
  return path.split(".").reduce((o, k) => o?.[k], value);
}
export function outputPorts(component: Config): string[] {
  if (component.type === "memory")
    return [
      "output",
      ...(component.source_config?.export_expired_items === true
        ? ["expired"]
        : []),
    ];
  if (component.type === "route")
    return [
      ...Object.keys(component.route || {}),
      ...(component.reroute_unmatched === false ? [] : ["_unmatched"]),
    ];
  if (component.type === "exclusive_route")
    return [
      ...(Array.isArray(component.routes)
        ? component.routes
            .filter((route: any) => typeof route?.name === "string")
            .map((route: any) => route.name)
        : []),
      "_unmatched",
    ];
  if (component.type === "datadog_agent" && component.multiple_outputs === true)
    return ["logs", "metrics", "traces", "llmobs"].filter(
      (port) => component[`disable_${port}`] !== true,
    );
  if (component.type === "opentelemetry") return ["logs", "metrics", "traces"];
  if (component.type === "remap" && component.reroute_dropped === true)
    return ["output", "dropped"];
  return ["output"];
}
type EventType = "logs" | "metrics" | "traces";
export const exactOutputTypes = new Set([
  "memory",
  "demo_logs",
  "internal_metrics",
  "file",
  "http_server",
  "syslog",
  "opentelemetry",
  "datadog_agent",
  "remap",
  "route",
  "exclusive_route",
  "filter",
  "sample",
  "reduce",
  "log_to_metric",
]);
const allEvents: EventType[] = ["logs", "metrics", "traces"];
// Event types from Vector 0.58's component reference, for the components
// whose input or output is a single kind. Anything not listed is treated as
// accepting (or emitting) every type, so this never blocks a valid pipeline.
const LOGS_ONLY_INPUT = new Set([
  "loki",
  "elasticsearch",
  "reduce",
  "log_to_metric",
  "dedupe",
  "aws_s3",
  "aws_cloudwatch_logs",
  "splunk_hec_logs",
  "datadog_logs",
  "gcp_cloud_storage",
]);
const METRICS_ONLY_INPUT = new Set([
  "prometheus_exporter",
  "prometheus_remote_write",
  "statsd",
  "datadog_metrics",
  "influxdb_metrics",
  "aws_cloudwatch_metrics",
  "gcp_stackdriver_metrics",
  "splunk_hec_metrics",
  "aggregate",
  "incremental_to_absolute",
  "metric_to_log",
  "tag_cardinality_limit",
]);
const LOG_SOURCES = new Set([
  "demo_logs",
  "file",
  "syslog",
  "http_server",
  "journald",
  "docker_logs",
  "kubernetes_logs",
  "internal_logs",
  "stdin",
]);
const METRIC_SOURCES = new Set([
  "internal_metrics",
  "host_metrics",
  "prometheus_scrape",
  "prometheus_remote_write",
  "statsd",
  "apache_metrics",
  "nginx_metrics",
  "mongodb_metrics",
  "postgresql_metrics",
  "aws_ecs_metrics",
  "eventstoredb_metrics",
  "static_metrics",
  "log_to_metric",
]);
function acceptedEvents(type: string): EventType[] {
  if (["sample"].includes(type)) return ["logs", "traces"];
  if (type === "datadog_traces") return ["traces"];
  if (LOGS_ONLY_INPUT.has(type)) return ["logs"];
  if (METRICS_ONLY_INPUT.has(type)) return ["metrics"];
  return allEvents;
}
const eventWords = (types: readonly EventType[]) =>
  types.length > 1
    ? `${types.slice(0, -1).join(", ")} and ${types.at(-1)}`
    : types[0];

/**
 * Why a component can't read `input`, such as "Accepts metrics; parse
 * sends logs." Null when it can, or when the types aren't known.
 */
export function inputMismatch(
  config: Config,
  input: string,
  item: Pick<Component, "kind" | "type">,
): string | null {
  if (!input || item.kind === "sources") return null;
  const sends = inferEvents(config, input);
  const accepts = acceptedEvents(item.type);
  if (sends.some((type) => accepts.includes(type))) return null;
  return `Accepts ${eventWords(accepts)}; ${input} sends ${eventWords(sends)}.`;
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
  if (!c)
    return memoryComponents(config).some(
      (entry) => entry.id === id && entry.kind === "sources",
    )
      ? ["logs"]
      : allEvents;
  if (
    (c.type === "opentelemetry" ||
      (c.type === "datadog_agent" && c.multiple_outputs === true)) &&
    allEvents.includes(port as EventType)
  )
    return [port as EventType];
  if (LOG_SOURCES.has(c.type) && !config.transforms?.[id]) return ["logs"];
  if (METRIC_SOURCES.has(c.type)) return ["metrics"];
  if (
    [
      "remap",
      "filter",
      "route",
      "exclusive_route",
      "sample",
      "reduce",
    ].includes(c.type) &&
    Array.isArray(c.inputs) &&
    c.inputs.length > 0
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
type PipelineComponent = {
  id: string;
  kind: Kind;
  component: Config;
  enrichmentTable?: string;
  implicitSource?: boolean;
};
/** Memory enrichment tables can register a sink and an independently named export source. */
export function memoryComponents(config: Config): PipelineComponent[] {
  return Object.entries(config.enrichment_tables || {}).flatMap(
    ([id, value]: [string, any]) => {
      if (value?.type !== "memory") return [];
      const entries: PipelineComponent[] = [];
      if (Array.isArray(value.inputs))
        entries.push({
          id,
          kind: "sinks",
          component: value,
          enrichmentTable: id,
        });
      const source = value.source_config?.source_key;
      if (typeof source === "string" && source) {
        const { inputs: _inputs, ...component } = value;
        entries.push({
          id: source,
          kind: "sources",
          component,
          enrichmentTable: id,
          implicitSource: true,
        });
      }
      return entries;
    },
  );
}
function pipelineComponents(config: Config): PipelineComponent[] {
  return (["sources", "transforms", "sinks"] as Kind[])
    .flatMap((kind) =>
      Object.entries(config[kind] || {}).map(([id, component]) => ({
        id,
        kind,
        component: component as Config,
      })),
    )
    .concat(memoryComponents(config));
}
/** Tuple encoding keeps hyphenated endpoint names and repeated inputs distinct. */
export function connectionEdgeId(
  reference: string,
  target: string,
  index: number,
): string {
  return `conn:${encodeURIComponent(JSON.stringify([reference, target, index]))}`;
}
export function toGraph(config: Config, existing?: Graph): Graph {
  const previousNodes = new Map<string, any>(
    (existing?.nodes || []).map((node: any) => [node.id, node]),
  );
  const previousEdges = new Map<string, any>(
    (existing?.edges || []).map((edge: any) => [edge.id, edge]),
  );
  const drafts: { id: string; old: any; position: any; data: Config }[] = [];
  const edges: any[] = [];
  const counts = { sources: 0, transforms: 0, sinks: 0 };
  for (const {
    id,
    kind,
    component,
    enrichmentTable,
    implicitSource,
  } of pipelineComponents(config)) {
    if (!component || typeof component !== "object" || Array.isArray(component))
      continue;
    const col = ["sources", "transforms", "sinks"].indexOf(kind),
      i = counts[kind]++;
    const old = previousNodes.get(id);
    drafts.push({
      id,
      old,
      position: old?.position || { x: col * 290 + 60, y: i * 170 + 100 },
      data: {
        kind,
        component,
        label: id,
        ...(enrichmentTable ? { enrichmentTable, implicitSource } : {}),
      },
    });
    for (const [j, input] of (Array.isArray(component.inputs)
      ? component.inputs
      : []
    ).entries()) {
      if (typeof input !== "string" || isInputPattern(input)) continue;
      const dot = input.indexOf("."),
        edgeId = connectionEdgeId(input, id, j),
        source = dot < 0 ? input : input.slice(0, dot),
        sourceHandle = dot < 0 ? "output" : input.slice(dot + 1);
      const oldEdge = previousEdges.get(edgeId);
      edges.push(
        oldEdge &&
          oldEdge.source === source &&
          oldEdge.sourceHandle === sourceHandle &&
          oldEdge.target === id
          ? oldEdge
          : {
              id: edgeId,
              source,
              sourceHandle,
              target: id,
              targetHandle: "input",
              type: "smoothstep",
              animated: false,
            },
      );
    }
  }
  const sending = new Set(edges.map((edge) => edge.source)),
    receiving = new Set(edges.map((edge) => edge.target));
  // Unchanged steps keep their node object, so the canvas re-renders only
  // what an edit touched.
  const nodes = drafts.map(({ id, old, position, data }) => {
    const disconnected =
      data.kind === "sources" ? !sending.has(id) : !receiving.has(id);
    const same =
      old?.type === "component" &&
      old.position === position &&
      old.data?.disconnected === disconnected &&
      Object.keys(data).length + 1 === Object.keys(old.data).length &&
      Object.entries(data).every(([key, value]) => old.data[key] === value);
    return same
      ? old
      : { id, type: "component", position, data: { ...data, disconnected } };
  });
  return { nodes, edges };
}
export function validateGraph(config: Config): string[] {
  const errors: string[] = [];
  const all = new Map<string, { kind: Kind; c: Config }>();
  for (const { id, kind, component: c } of pipelineComponents(config)) {
    if (all.has(id)) errors.push(`Duplicate component ID: ${id}`);
    if (!id || new TextEncoder().encode(id).length > 128 || id.includes("."))
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
      if (isInputPattern(input)) continue;
      const [source, ...outputs] = input.split(".");
      const item = all.get(source);
      if (!item) errors.push(`${id}: missing input ${input}`);
      else if (item.kind === "sinks")
        errors.push(`${id}: a sink cannot be an input`);
      else if (
        outputs.length &&
        exactOutputTypes.has(item.c.type) &&
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
export function isInputPattern(reference: string): boolean {
  return /[*?\[]/.test(reference) || /\$(?:\{|[A-Za-z_])/.test(reference);
}
export function connect(
  config: Config,
  source: string,
  target: string,
  handle = "output",
): Config {
  const copy = structuredClone(config);
  const entries = pipelineComponents(copy),
    src = entries.find((entry) => entry.id === source),
    dst = entries.find((entry) => entry.id === target);
  if (
    !src ||
    !dst ||
    src.kind === "sinks" ||
    dst.kind === "sources" ||
    source === target
  )
    throw Error("Connect a source or transform to a transform or sink.");
  const ref = handle === "output" ? source : `${source}.${handle}`;
  dst.component.inputs = [
    ...new Set([
      ...(Array.isArray(dst.component.inputs) ? dst.component.inputs : []),
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

export function pipelineOutputs(config: Config) {
  return pipelineComponents(config)
    .filter((entry) => entry.kind !== "sinks")
    .flatMap(({ id, kind, component }) => {
      if (!component || typeof component !== "object") return [];
      return outputPorts(component).map((port) => ({
        id,
        kind,
        port,
        reference: port === "output" ? id : `${id}.${port}`,
        label: `${id}${port === "output" ? "" : ` / ${port}`}`,
      }));
    });
}

/** Keep the guided view in event-flow order, independent of object insertion order. */
export function orderedStepIds(config: Config, kind: Kind): string[] {
  const ordered: string[] = [],
    seen = new Set<string>();
  function visit(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    const component = config[kind]?.[id];
    if (!component) return;
    for (const input of Array.isArray(component.inputs) ? component.inputs : [])
      if (typeof input === "string" && config[kind]?.[input.split(".")[0]])
        visit(input.split(".")[0]);
    ordered.push(id);
  }
  for (const id of Object.keys(config[kind] || {})) visit(id);
  return ordered;
}

/** Suggest only an unambiguous end of the existing flow. Branches require a choice. */
export function suggestedInput(config: Config): string {
  const outputs = pipelineOutputs(config);
  const transformInputs = new Set<string>(
    Object.values(config.transforms || {}).flatMap((value: any) =>
      Array.isArray(value?.inputs) ? value.inputs : [],
    ),
  );
  const terminal = outputs.filter((o) => !transformInputs.has(o.reference));
  return terminal.length === 1 ? terminal[0].reference : "";
}

/**
 * What a new step is called: its role in the flow rather than the bare type,
 * so reviews don't read "remap remap". Never reuses a taken ID.
 */
const ROLE_IDS: Record<string, string> = {
  "sources:file": "app_logs",
  "sources:demo_logs": "demo",
  "sources:syslog": "syslog_in",
  "sources:http_server": "http_in",
  "sources:opentelemetry": "otel_in",
  "sources:internal_metrics": "vector_metrics",
  "transforms:remap": "parse",
  "transforms:filter": "keep",
  "transforms:route": "by_condition",
  "transforms:exclusive_route": "by_condition",
  "sinks:aws_s3": "archive",
  "sinks:console": "console_out",
  "sinks:blackhole": "discard",
  "sinks:loki": "loki_out",
  "sinks:elasticsearch": "search_out",
  "sinks:http": "http_out",
  "sinks:file": "file_out",
  "sinks:prometheus_exporter": "metrics_exporter",
};
export function defaultComponentId(
  kind: Kind,
  type: string,
  used: ReadonlySet<string>,
) {
  const base = ROLE_IDS[`${kind}:${type}`] || type;
  let id = base,
    suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  return id;
}

/** Adds a step and safely inserts a transform into a chosen existing connection. */
export function addConnectedComponent(
  config: Config,
  item: Component,
  input = "",
  downstreamIds?: string[],
  options: { autoConnectSource?: boolean } = {},
) {
  let next = structuredClone(config);
  const used = new Set(pipelineComponents(next).map((entry) => entry.id));
  const id = defaultComponentId(item.kind, item.type, used);
  next[item.kind] ??= {};
  next[item.kind][id] = {
    type: item.type,
    ...structuredClone(item.defaults),
    ...(item.kind === "sources"
      ? {}
      : {
          inputs: Array.isArray(item.defaults.inputs)
            ? structuredClone(item.defaults.inputs)
            : [],
        }),
  };
  if (item.kind === "sources" && options.autoConnectSource !== false) {
    const outputs = outputPorts(next.sources[id]);
    const port = outputs.includes("output")
      ? "output"
      : outputs.includes("logs")
        ? "logs"
        : outputs[0];
    const roots = (["transforms", "sinks"] as Kind[]).flatMap((kind) =>
      Object.entries(config[kind] || {})
        .filter(
          ([, c]: any) =>
            Array.isArray(c?.inputs) &&
            c.inputs.every(
              (ref: unknown) =>
                typeof ref === "string" &&
                !!config.sources?.[ref.split(".")[0]],
            ),
        )
        .map(([name]) => ({ kind, name })),
    );
    const transforms = roots.filter((r) => r.kind === "transforms");
    const candidates = transforms.length
      ? transforms
      : roots.filter((r) => r.kind === "sinks");
    const targets = candidates.length === 1 ? candidates : [];
    for (const target of targets) next = connect(next, id, target.name, port);
  } else if (input) {
    const [source, ...parts] = input.split(".");
    next = connect(next, source, id, parts.join(".") || "output");
    if (item.kind === "transforms") {
      const consumers = downstreamSteps(config, input);
      const selectedConsumers = new Set(
        downstreamIds ?? (consumers.length === 1 ? [consumers[0].id] : []),
      );
      const replacement = outputPorts(next.transforms[id]).map((port) =>
        port === "output" ? id : `${id}.${port}`,
      );
      for (const kind of ["transforms", "sinks", "enrichment_tables"])
        for (const [name, c] of Object.entries(next[kind] || {}) as [
          string,
          Config,
        ][])
          if (
            name !== id &&
            selectedConsumers.has(name) &&
            Array.isArray(c?.inputs)
          )
            c.inputs = [
              ...new Set(
                c.inputs.flatMap((ref: string) =>
                  ref === input ? replacement : [ref],
                ),
              ),
            ];
      const failure = validateGraph(next).find((e) =>
        /Cycle|incompatible event types/.test(e),
      );
      if (failure) throw Error(failure);
    }
  }
  return { config: next, id };
}

/** Apply the same known event-type constraints as a direct graph connection. */
export function acceptsComponentInput(
  config: Config,
  input: string,
  item: Component,
) {
  return (
    !input ||
    (item.kind !== "sources" &&
      inferEvents(config, input).some((type) =>
        acceptedEvents(item.type).includes(type),
      ))
  );
}

export function downstreamSteps(config: Config, reference: string) {
  return (["transforms", "sinks", "enrichment_tables"] as const).flatMap(
    (kind) =>
      Object.entries(config[kind] || {})
        .filter(
          ([, component]: any) =>
            Array.isArray(component?.inputs) &&
            component.inputs.includes(reference),
        )
        .map(([id, component]) => ({
          id,
          kind,
          component: component as Config,
        })),
  );
}

export function removePipelineStep(config: Config, id: string): Config {
  const next = structuredClone(config);
  const memory = memoryComponents(next).find((entry) => entry.id === id);
  if (memory) {
    const table = next.enrichment_tables[memory.enrichmentTable!];
    const removed = [
      memory.enrichmentTable,
      table?.source_config?.source_key,
    ].filter(Boolean);
    delete next.enrichment_tables[memory.enrichmentTable!];
    for (const section of ["transforms", "sinks", "enrichment_tables"])
      for (const component of Object.values(next[section] || {}) as Config[])
        if (Array.isArray(component?.inputs))
          component.inputs = component.inputs.filter(
            (ref: unknown) =>
              typeof ref !== "string" ||
              isInputPattern(ref) ||
              !removed.some(
                (name) => ref === name || ref.startsWith(name + "."),
              ),
          );
    return next;
  }
  const kind = (["sources", "transforms", "sinks"] as Kind[]).find(
    (k) => next[k]?.[id],
  );
  if (!kind) return next;
  const removed = next[kind][id];
  const bridge =
    kind === "transforms" &&
    outputPorts(removed).length === 1 &&
    outputPorts(removed)[0] === "output"
      ? Array.isArray(removed.inputs)
        ? removed.inputs
        : []
      : [];
  delete next[kind][id];
  for (const section of ["transforms", "sinks", "enrichment_tables"])
    for (const c of Object.values(next[section] || {}) as Config[])
      if (Array.isArray(c?.inputs))
        c.inputs = [
          ...new Set(
            c.inputs.flatMap((ref: string) =>
              ref === id
                ? bridge
                : typeof ref === "string" && ref.startsWith(`${id}.`)
                  ? []
                  : [ref],
            ),
          ),
        ];
  return next;
}

// Required-option findings by component content: while one step is edited the
// others are not re-walked against the schema. Bounded; content-keyed, so a
// caller that mutates a component in place still gets fresh findings.
const requiredIssueCache = new Map<string, string[]>();
function requiredIssues(kind: Kind, component: Config, schema: Schema) {
  const key = `${kind}\n${JSON.stringify(component)}`;
  let issues = requiredIssueCache.get(key);
  if (!issues) {
    if (requiredIssueCache.size > 4000) requiredIssueCache.clear();
    requiredIssueCache.set(
      key,
      (issues = requiredSchemaIssues(schema, vectorSchema, component)),
    );
  }
  return issues;
}
export function pipelineIssues(
  config: Config,
): { id?: string; message: string }[] {
  const issues = validateGraph(config).map((message) => ({
    id: message.includes(":") ? message.split(":")[0] : undefined,
    message,
  }));
  if (!config.provider && !Object.keys(config.sources || {}).length)
    issues.push({
      id: undefined,
      message: "Add a source to choose where events come from.",
    });
  if (!config.provider && !Object.keys(config.sinks || {}).length)
    issues.push({
      id: undefined,
      message: "Add a destination to choose where events go.",
    });
  for (const kind of ["sources", "transforms", "sinks"] as Kind[])
    for (const [id, component] of Object.entries(config[kind] || {}) as [
      string,
      Config,
    ][]) {
      const definition = catalog.find(
        (c) => c.kind === kind && c.type === component?.type,
      );
      const schema = definition ? componentSchema(definition) : undefined;
      if (schema)
        for (const message of requiredIssues(kind, component, schema))
          issues.push({ id, message: `${id}: ${message}` });
      // Curated display shortcuts are not authoritative requirements. Native
      // alternatives and omitted defaults follow the pinned component schema.
      else
        for (const field of definition?.fields || []) {
          const value = getPath(component, field.key);
          if (
            field.required &&
            (value == null ||
              value === "" ||
              (Array.isArray(value) &&
                !value.some((v) => typeof v === "string" && v.trim())))
          )
            issues.push({
              id,
              message: `${id}: enter ${field.label.toLowerCase()}.`,
            });
          if (
            field.type === "number" &&
            value != null &&
            (!Number.isFinite(value) || value <= 0)
          )
            issues.push({
              id,
              message: `${id}: ${field.label.toLowerCase()} must be greater than zero.`,
            });
        }
      if (
        kind === "sinks" &&
        ["http", "loki", "elasticsearch"].includes(component?.type)
      ) {
        const keys =
          component.auth?.strategy === "basic"
            ? ["user", "password"]
            : component.auth?.strategy === "bearer"
              ? ["token"]
              : [];
        for (const key of keys) {
          const reference = component.auth?.[key];
          if (!isSecretReference(reference))
            issues.push({
              id,
              message: `${id}: enter a valid ${key === "user" ? "username" : key} secret reference in Authentication.`,
            });
        }
      }
    }
  return issues;
}
