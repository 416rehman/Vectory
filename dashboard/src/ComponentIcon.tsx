import {
  Activity,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Braces,
  CircleOff,
  Clock3,
  Database,
  FileText,
  Filter,
  Gauge,
  GitBranch,
  Globe,
  Layers,
  ListFilter,
  Radio,
  ScanLine,
  Server,
  Shuffle,
  Terminal,
  Waves,
  type LucideIcon,
} from "lucide-react";
import type { Kind } from "./catalog";

// Bundled upstream artwork. All source URLs and hashes are in assets/component-icons/provenance.json.
const aws_s3 = new URL("./assets/component-icons/aws_s3.svg", import.meta.url)
  .href;
const aws_cloudwatch = new URL(
  "./assets/component-icons/aws_cloudwatch.svg",
  import.meta.url,
).href;
const aws_kinesis_firehose = new URL(
  "./assets/component-icons/aws_kinesis_firehose.svg",
  import.meta.url,
).href;
const aws_kinesis_streams = new URL(
  "./assets/component-icons/aws_kinesis_streams.svg",
  import.meta.url,
).href;
const clickhouse = new URL(
  "./assets/component-icons/clickhouse.svg",
  import.meta.url,
).href;
const datadog = new URL("./assets/component-icons/datadog.svg", import.meta.url)
  .href;
const docker = new URL("./assets/component-icons/docker.svg", import.meta.url)
  .href;
const elasticsearch = new URL(
  "./assets/component-icons/elasticsearch.svg",
  import.meta.url,
).href;
const gcp_big_query = new URL(
  "./assets/component-icons/gcp_big_query.svg",
  import.meta.url,
).href;
const gcp_cloud_storage = new URL(
  "./assets/component-icons/gcp_cloud_storage.svg",
  import.meta.url,
).href;
const gcp_pubsub = new URL(
  "./assets/component-icons/gcp_pubsub.svg",
  import.meta.url,
).href;
const gcp_stackdriver = new URL(
  "./assets/component-icons/gcp_stackdriver.svg",
  import.meta.url,
).href;
const honeycomb = new URL(
  "./assets/component-icons/honeycomb.svg",
  import.meta.url,
).href;
const influxdb = new URL(
  "./assets/component-icons/influxdb.svg",
  import.meta.url,
).href;
const kafka = new URL("./assets/component-icons/kafka.svg", import.meta.url)
  .href;
const loki = new URL("./assets/component-icons/loki.svg", import.meta.url).href;
const new_relic = new URL(
  "./assets/component-icons/new_relic.svg",
  import.meta.url,
).href;
const pulsar = new URL("./assets/component-icons/pulsar.svg", import.meta.url)
  .href;
const splunk_hec = new URL(
  "./assets/component-icons/splunk_hec.svg",
  import.meta.url,
).href;
const vector = new URL("./assets/component-icons/vector.svg", import.meta.url)
  .href;
const opentelemetry = new URL(
  "./assets/component-icons/opentelemetry.svg",
  import.meta.url,
).href;
const prometheus = new URL(
  "./assets/component-icons/prometheus.svg",
  import.meta.url,
).href;
const kubernetes = new URL(
  "./assets/component-icons/kubernetes.svg",
  import.meta.url,
).href;
const nats = new URL("./assets/component-icons/nats.svg", import.meta.url).href;
const fluentd = new URL("./assets/component-icons/fluentd.svg", import.meta.url)
  .href;

function artwork(type: string): string | undefined {
  if (type === "aws_s3") return aws_s3;
  if (type.startsWith("aws_cloudwatch")) return aws_cloudwatch;
  if (type === "aws_kinesis_firehose") return aws_kinesis_firehose;
  if (type === "aws_kinesis_streams") return aws_kinesis_streams;
  if (type.startsWith("datadog")) return datadog;
  if (type === "docker_logs") return docker;
  if (type === "elasticsearch") return elasticsearch;
  if (type === "kafka") return kafka;
  if (type === "kubernetes_logs") return kubernetes;
  if (type.startsWith("prometheus")) return prometheus;
  if (type.startsWith("gcp_stackdriver")) return gcp_stackdriver;
  if (type === "gcp_cloud_storage") return gcp_cloud_storage;
  if (type === "gcp_pubsub") return gcp_pubsub;
  if (type === "gcp_big_query") return gcp_big_query;
  if (type.startsWith("influxdb")) return influxdb;
  if (type.startsWith("splunk_hec")) return splunk_hec;
  const direct: Record<string, string> = {
    clickhouse,
    honeycomb,
    loki,
    new_relic,
    pulsar,
    vector,
    opentelemetry,
    nats,
    fluent: fluentd,
  };
  return Object.hasOwn(direct, type) ? direct[type] : undefined;
}
function semantic(type: string, kind?: Kind): LucideIcon {
  if (["remap", "lua"].includes(type)) return Braces;
  if (type === "filter") return Filter;
  if (["route", "exclusive_route"].includes(type)) return GitBranch;
  if (type === "sample") return Shuffle;
  if (["reduce", "aggregate", "window", "memory"].includes(type)) return Layers;
  if (["throttle", "tag_cardinality_limit"].includes(type)) return Gauge;
  if (["delay"].includes(type)) return Clock3;
  if (type === "dedupe") return ListFilter;
  if (type.includes("_to_") || type === "incremental_to_absolute")
    return ArrowLeftRight;
  if (["console", "stdin", "exec", "file_descriptor"].includes(type))
    return Terminal;
  if (["file", "journald", "windows_event_log"].includes(type)) return FileText;
  if (type === "blackhole") return CircleOff;
  if (type === "demo_logs" || type === "internal_logs") return ScanLine;
  if (type.includes("metrics") || type === "statsd") return Activity;
  if (type.includes("http") || type.includes("websocket") || type === "webhdfs")
    return Globe;
  if (["socket", "syslog", "logstash", "dnstap"].includes(type)) return Radio;
  if (["amqp", "mqtt", "aws_sns", "aws_sqs"].includes(type)) return Waves;
  if (
    type.includes("postgres") ||
    type.includes("mongo") ||
    ["redis", "databend", "doris", "greptimedb"].includes(type)
  )
    return Database;
  if (
    type.startsWith("aws_") ||
    type.startsWith("azure_") ||
    type.startsWith("gcp_")
  )
    return Server;
  return kind === "sources"
    ? ArrowDownToLine
    : kind === "sinks"
      ? ArrowUpFromLine
      : Braces;
}
export function ComponentIcon({
  type,
  kind,
  size = 28,
}: {
  type: string;
  kind?: Kind;
  size?: number;
}) {
  const src = artwork(type),
    Icon = semantic(type, kind);
  return (
    <span
      className={`pipeline-component-icon ${src ? "pipeline-component-icon-brand" : "pipeline-component-icon-semantic"}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} width={size} height={size} alt="" draggable={false} />
      ) : (
        <Icon size={size} strokeWidth={1.65} />
      )}
    </span>
  );
}
export default ComponentIcon;
