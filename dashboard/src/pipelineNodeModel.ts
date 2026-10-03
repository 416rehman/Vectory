import type { Config } from "./api";
import { catalog, displayLabel, outputPorts, type Kind } from "./catalog";

export const PIPELINE_NODE_WIDTH = 300;
// Heights include the outer border; primary handles align with the header divider.
export const PIPELINE_NODE_BODY_HEIGHT = 184;
export const PIPELINE_NODE_HEADER_HEIGHT = 80;
export const PIPELINE_NODE_PORT_HEIGHT = 28;
// Preserve the connection lane when the card grows wider.
export const PIPELINE_NODE_COLUMN_GAP = PIPELINE_NODE_WIDTH + 112;

export type ComponentSummary = {
  primary: string;
  secondary?: string;
  code?: boolean;
};
export type ComponentContext = {
  enrichmentTable?: string;
  implicitSource?: boolean;
};
const labels = new Map(
  catalog.map((entry) => [`${entry.kind}:${entry.type}`, entry.label]),
);
export function componentTitle(
  type: string,
  kind: Kind,
  context: ComponentContext = {},
): string {
  if (type === "memory" && context.enrichmentTable)
    return context.implicitSource ? "Memory table export" : "Memory table";
  return labels.get(`${kind}:${type}`) || displayLabel(type, kind);
}
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function object(value: unknown): Config {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .map((v) => v.trim().slice(0, 500))
    : [];
}
function listed(values: string[], limit = 2): string | undefined {
  return values.length
    ? values.slice(0, limit).join(", ") +
        (values.length > limit ? ` +${values.length - limit} more` : "")
    : undefined;
}
function join(...values: (string | undefined)[]): string | undefined {
  return values.filter(Boolean).join(" · ") || undefined;
}
/** Endpoints are useful topology context; embedded credentials and query values are not. */
export function endpointSummary(value: unknown): string | undefined {
  // Strip credentials before truncating. Truncating a long userinfo segment first
  // could hide its trailing @ and accidentally turn it into visible text.
  const input = typeof value === "string" ? value.trim() : undefined;
  if (!input) return;
  // Native references may stand for a complete URL; never try to resolve them.
  if (/^(?:vectory-secret:|SECRET\[|\$\{)/.test(input))
    return "Endpoint from local reference";
  const withoutQuery = input.split(/[?#]/, 1)[0];
  try {
    // URL canonicalization lowercases hostnames, which would change a displayed
    // case-sensitive native environment/template reference.
    if (/\$\{|\{\{|SECRET\[/.test(withoutQuery))
      throw new Error("Template endpoint");
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(withoutQuery))
      throw new Error("Plain endpoint");
    const url = new URL(withoutQuery);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`.slice(
      0,
      500,
    );
  } catch {
    return withoutQuery
      .replace(/^([a-z][a-z\d+.-]*:\/\/)?[^/@\s]+@/i, "$1")
      .slice(0, 500);
  }
}
function firstCode(value: unknown): string | undefined {
  const source = text(typeof value === "string" ? value : object(value).source);
  const line = source
    ?.split(/\r?\n/)
    .find((line) => line.trim() && !line.trim().startsWith("#"));
  return line?.trim();
}
/**
 * The format a step reads or writes, as the option that holds it: a source
 * decodes (`decoding.codec`), a sink encodes (`encoding.codec`). Vector 0.58
 * has no plain-string `encoding` on either, and ignores an `encoding` on a
 * source, so a card never reads one as a format.
 */
function codec(c: Config, kind: Kind): string | undefined {
  const reads = kind === "sources";
  const value = text(object(reads ? c.decoding : c.encoding).codec);
  return value
    ? `${value.replaceAll("_", " ").toUpperCase()} ${reads ? "decoding" : "encoding"}`
    : undefined;
}
function interval(value: unknown, suffix = "s"): string | undefined {
  const n = numeric(value);
  return n === undefined ? undefined : `${n} ${suffix}`;
}

/** Read only known configuration fields. No runtime health/throughput is invented. */
export function componentSummary(
  component: Config,
  kind: Kind,
  context: ComponentContext = {},
): ComponentSummary {
  const c = object(component),
    type = text(c.type) || "";
  const endpoint =
    endpointSummary(c.uri) ||
    endpointSummary(c.endpoint) ||
    listed(list(c.endpoints).map((v) => endpointSummary(v) || ""));
  const address = endpointSummary(c.address) || text(c.path);
  const mode = text(c.mode)?.toUpperCase();
  const region = text(c.region);
  const format = codec(c, kind);
  if (type === "memory" && context.enrichmentTable)
    return {
      primary: context.implicitSource
        ? `Read from ${context.enrichmentTable}`
        : `Write to ${context.enrichmentTable}`,
      secondary: join(
        interval(c.ttl) && `TTL ${interval(c.ttl)}`,
        object(c.source_config).export_expired_items === true
          ? "Expired-items output"
          : undefined,
      ),
    };
  switch (type) {
    // The pinned Vector 0.58.0 DemoLogsConfig declares interval's default as 1 s.
    case "demo_logs":
      return {
        primary: text(c.format)
          ? `${text(c.format)?.replaceAll("_", " ").toUpperCase()} log events`
          : "Choose a log format",
        secondary:
          c.interval === 0
            ? "Generate without delay"
            : `Generate every ${interval(c.interval === undefined ? 1 : c.interval) || "configured interval"}`,
      };
    case "file":
      return kind === "sources"
        ? {
            primary: listed(list(c.include)) || "Choose files to read",
            secondary: join(
              list(c.exclude).length
                ? `${list(c.exclude).length} exclusion${list(c.exclude).length === 1 ? "" : "s"}`
                : undefined,
              format,
            ),
          }
        : {
            primary: text(c.path) || "Choose an output path",
            secondary: format,
          };
    case "kafka":
      return {
        primary:
          kind === "sources"
            ? listed(list(c.topics)) || "Choose topics to consume"
            : text(c.topic) || "Choose a destination topic",
        secondary: join(
          text(c.group_id) && `Group ${text(c.group_id)}`,
          endpointSummary(c.bootstrap_servers),
        ),
      };
    case "aws_s3":
      return {
        primary: text(c.bucket)
          ? `s3://${text(c.bucket)}${text(c.key_prefix) ? `/${text(c.key_prefix)}` : ""}`
          : kind === "sources"
            ? endpointSummary(object(c.sqs).queue_url) ||
              "Configure S3 notifications"
            : "Choose a bucket",
        secondary: join(region, format),
      };
    case "aws_cloudwatch_logs":
      return {
        primary: text(c.group_name) || "Choose a log group",
        secondary: join(text(c.stream_name), region),
      };
    case "aws_cloudwatch_metrics":
      return {
        primary: text(c.namespace) || "Set a metric namespace",
        secondary: region,
      };
    case "aws_kinesis_firehose":
    case "aws_kinesis_streams":
      return {
        primary: text(c.stream_name) || address || "Configure a stream",
        secondary: join(region, format),
      };
    case "aws_sqs":
      return {
        primary: endpointSummary(c.queue_url) || "Choose a queue",
        secondary: region,
      };
    case "aws_sns":
      return {
        primary: text(c.topic_arn) || "Choose a notification topic",
        secondary: region,
      };
    case "gcp_cloud_storage":
      return {
        primary: text(c.bucket)
          ? `gs://${text(c.bucket)}`
          : "Choose a storage bucket",
        secondary: join(text(c.key_prefix), format),
      };
    case "gcp_pubsub":
      return {
        primary:
          text(c.subscription) ||
          text(c.topic) ||
          "Choose a topic or subscription",
        secondary: text(c.project),
      };
    case "azure_blob":
      return {
        primary: text(c.container_name) || "Choose a blob container",
        secondary: join(text(c.blob_prefix), format),
      };
    case "clickhouse":
      return {
        primary:
          join(text(c.database), text(c.table)) ||
          "Choose a database and table",
        secondary: endpoint,
      };
    case "elasticsearch":
      return {
        primary:
          text(object(c.bulk).index) ||
          text(object(c.data_stream).dataset) ||
          endpoint ||
          "Set an Elasticsearch endpoint",
        secondary:
          text(object(c.bulk).index) || text(object(c.data_stream).dataset)
            ? endpoint
            : text(c.mode),
      };
    case "loki":
      return {
        primary: endpoint || "Set a Loki endpoint",
        secondary: listed(
          Object.keys(object(c.labels)).map((key) => `${key} label`),
        ),
      };
    case "honeycomb":
      return {
        primary: text(c.dataset) || "Set a dataset",
        secondary: endpoint,
      };
    case "opentelemetry":
      return kind === "sources"
        ? {
            primary: text(object(c.grpc).address)
              ? `gRPC ${text(object(c.grpc).address)}`
              : "Configure the gRPC listener",
            secondary: text(object(c.http).address)
              ? `HTTP ${text(object(c.http).address)}`
              : undefined,
          }
        : { primary: endpoint || "Set an OTLP endpoint", secondary: format };
    case "datadog_agent":
      return {
        primary: address
          ? `Listen on ${address}`
          : "Configure the agent listener",
        secondary:
          c.multiple_outputs === true
            ? "Separate signal outputs"
            : "Combined signal output",
      };
    case "datadog_logs":
    case "datadog_metrics":
    case "datadog_traces":
    case "datadog_events":
      return {
        primary: endpoint || text(c.site) || "Datadog intake",
        secondary: join(text(c.service), text(c.env)),
      };
    case "http":
    case "http_client":
    case "http_server":
    case "websocket":
    case "websocket_server":
      return {
        primary:
          endpoint ||
          (address
            ? `Listen on ${address}`
            : kind === "sources"
              ? "Set a listener or endpoint"
              : "Set a destination URL"),
        secondary: join(text(c.method)?.toUpperCase(), format),
      };
    case "syslog":
    case "socket":
    case "fluent":
    case "statsd":
    case "dnstap":
    case "logstash":
      return {
        primary: address
          ? `${kind === "sources" ? "Listen on" : "Send to"} ${address}`
          : "Set an address or socket path",
        secondary: join(mode, format),
      };
    case "prometheus_scrape":
      return {
        primary:
          listed(list(c.endpoints).map((v) => endpointSummary(v) || "")) ||
          "Add a scrape endpoint",
        secondary:
          interval(c.scrape_interval_secs) &&
          `Scrape every ${interval(c.scrape_interval_secs)}`,
      };
    case "prometheus_exporter":
    case "prometheus_remote_write":
    case "prometheus_pushgateway":
      return {
        primary:
          endpoint ||
          (address ? `Listen on ${address}` : "Configure the metrics endpoint"),
        secondary: text(c.default_namespace),
      };
    case "docker_logs":
      return {
        primary: listed(list(c.include_containers)) || "Docker container logs",
        secondary: listed(list(c.include_labels)),
      };
    case "kubernetes_logs":
      return {
        primary: text(c.extra_label_selector) || "Kubernetes pod logs",
        secondary:
          text(c.extra_namespace_label_selector) || text(c.self_node_name),
      };
    case "host_metrics":
    case "internal_metrics":
      return {
        primary:
          listed(list(c.collectors)) ||
          (type === "host_metrics"
            ? "Collect host metrics"
            : "Vector internal metrics"),
        secondary:
          interval(c.scrape_interval_secs) &&
          `Collect every ${interval(c.scrape_interval_secs)}`,
      };
    case "internal_logs":
      return { primary: "Vector internal logs" };
    case "journald":
      return {
        primary: listed(list(c.include_units)) || "System journal entries",
        secondary: text(c.current_boot_only) || text(c.journal_directory),
      };
    case "windows_event_log":
      return {
        primary: listed(list(c.channels)) || "Windows event channels",
        secondary: text(c.query),
      };
    case "exec":
      return {
        primary: list(c.command)[0]
          ? `Run ${list(c.command)[0]}`
          : "Set a command",
        secondary: mode,
      };
    case "stdin":
      return { primary: "Read standard input", secondary: format };
    case "file_descriptor":
      return {
        primary:
          numeric(c.file_descriptor) !== undefined
            ? `Read descriptor ${c.file_descriptor}`
            : "Set a file descriptor",
        secondary: format,
      };
    case "console":
      return {
        primary:
          c.target === "stderr"
            ? "Write to standard error"
            : c.target === "stdout"
              ? "Write to standard output"
              : "Write to console",
        secondary: format,
      };
    case "blackhole":
      return { primary: "Discard incoming events" };
    case "remap":
      return {
        primary:
          text(c.file) ||
          listed(list(c.files)) ||
          firstCode(c.source) ||
          "Write a VRL program",
        secondary:
          text(c.file) || list(c.files).length
            ? "Load a VRL program from file"
            : undefined,
        code: !text(c.file) && !list(c.files).length && !!firstCode(c.source),
      };
    case "filter":
      return {
        primary: firstCode(c.condition) || "Set the condition to keep events",
        code: !!firstCode(c.condition),
      };
    case "route":
    case "exclusive_route": {
      const routes =
        type === "route"
          ? Object.entries(object(c.route))
          : Array.isArray(c.routes)
            ? c.routes.map((value) => {
                const route = object(value);
                return [
                  text(route.name) || "Unnamed route",
                  route.condition,
                ] as const;
              })
            : [];
      const condition = routes[0] && firstCode(routes[0][1]);
      return {
        primary: routes[0]
          ? `${routes[0][0]}: ${condition || "Set a condition"}`
          : "Add a route condition",
        secondary: join(
          routes.length > 1 ? `${routes.length} conditional routes` : undefined,
          type === "route" && c.reroute_unmatched === false
            ? "Unmatched output disabled"
            : "Includes unmatched output",
        ),
        code: !!condition,
      };
    }
    case "sample":
      return {
        primary:
          numeric(c.rate) !== undefined
            ? `Keep 1 in every ${c.rate} events`
            : numeric(c.ratio) !== undefined
              ? `Keep ${Number((c.ratio * 100).toPrecision(5))}% of events`
              : "Set a sampling rate",
        secondary: text(c.key_field) && `By ${text(c.key_field)}`,
      };
    case "reduce":
      return {
        primary: listed(list(c.group_by))
          ? `Group by ${listed(list(c.group_by))}`
          : "Combine related events",
        secondary:
          interval(c.expire_after_ms, "ms") &&
          `Expire after ${interval(c.expire_after_ms, "ms")}`,
      };
    case "aggregate":
      return {
        primary: "Aggregate metric values",
        secondary:
          interval(c.interval_ms, "ms") &&
          `Flush every ${interval(c.interval_ms, "ms")}`,
      };
    case "throttle":
      return {
        primary:
          numeric(c.threshold) !== undefined
            ? `Limit to ${c.threshold} events`
            : "Set an event limit",
        secondary: interval(c.window_secs) && `Per ${interval(c.window_secs)}`,
      };
    case "dedupe":
      return {
        primary: listed(list(object(c.fields).match))
          ? `Compare ${listed(list(object(c.fields).match))}`
          : "Remove duplicate events",
        secondary:
          listed(list(object(c.fields).ignore)) &&
          `Ignore ${listed(list(object(c.fields).ignore))}`,
      };
    case "log_to_metric":
      return {
        primary: Array.isArray(c.metrics)
          ? `${c.metrics.length} metric definition${c.metrics.length === 1 ? "" : "s"}`
          : "Define metrics from log fields",
      };
    case "metric_to_log":
      return { primary: "Represent each metric as a log event" };
    case "trace_to_log":
      return { primary: "Represent each span as a log event" };
    case "incremental_to_absolute":
      return { primary: "Accumulate incremental metric values" };
    case "tag_cardinality_limit":
      return {
        primary:
          numeric(c.value_limit) !== undefined
            ? `Allow ${c.value_limit} values per tag`
            : "Limit unique tag values",
        secondary: text(c.limit_exceeded_action),
      };
    case "delay":
      return {
        primary: interval(c.delay_secs)
          ? `Delay events by ${interval(c.delay_secs)}`
          : text(c.key_field)
            ? `Delay using ${text(c.key_field)}`
            : "Configure event delay",
      };
    case "lua":
      return {
        primary: text(c.version)
          ? `Lua ${text(c.version)} program`
          : "Run a Lua transform",
        secondary: text(c.source) ? "Inline script" : undefined,
      };
    case "window":
      return {
        primary: interval(c.window_duration_secs)
          ? `Collect a ${interval(c.window_duration_secs)} window`
          : "Configure the event window",
      };
  }
  // Useful common fields cover less common catalog and custom-build components
  // without reflecting unknown auth objects, headers, or credential properties.
  return {
    primary:
      endpoint ||
      address ||
      text(c.topic) ||
      text(c.subject) ||
      text(c.queue) ||
      text(c.table) ||
      text(c.database) ||
      listed(list(c.topics)) ||
      listed(list(c.channels)) ||
      "Open settings to configure",
    secondary: join(region, format),
  };
}

export function nodeOutputPorts(component: Config, kind: Kind): string[] {
  if (kind === "sinks") return [];
  const c = object(component);
  const ports = outputPorts(
    c.type === "route" ? { ...c, route: object(c.route) } : c,
  );
  return [
    ...new Set(
      ports.filter((port) => typeof port === "string" && port.length > 0),
    ),
  ];
}
export function pipelineNodeHeight(data: {
  kind?: Kind;
  component?: Config;
}): number {
  const ports = nodeOutputPorts(
    data.component || {},
    data.kind || "transforms",
  );
  const named =
    ports.length > 0 && !(ports.length === 1 && ports[0] === "output");
  return (
    PIPELINE_NODE_BODY_HEIGHT +
    (named ? ports.length * PIPELINE_NODE_PORT_HEIGHT + 9 : 0)
  );
}
