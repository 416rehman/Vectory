import type { Config } from "./api";

/**
 * Ready-made pipelines for common jobs. Each one passes the pinned Vector's
 * own validation (tests/templates.mjs) and lists what a device still needs.
 * Example addresses are placeholders to replace, never contacted by Vectory.
 */
export type PipelineTemplate = {
  id: string;
  title: string;
  /** Source → steps → destination, in a few words. */
  summary: string;
  /** What the user or each device must provide before this runs for real. */
  needs: string[];
  config: Config;
};

export const pipelineTemplates: readonly PipelineTemplate[] = [
  {
    id: "synthetic-demo",
    title: "Synthetic demo",
    summary: "Generated logs → add fields → console, with monitoring",
    needs: ["Nothing. It runs anywhere and sends no data off the device."],
    // With Vectory's monitoring pair (see withMonitoring): delivery health
    // is measured from the first deploy, and restricted mode runs this
    // loopback exporter without a host allowance.
    config: {
      sources: {
        demo: { type: "demo_logs", format: "json", interval: 1 },
        vectory_internal_metrics: { type: "internal_metrics" },
      },
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
        vectory_metrics_exporter: {
          type: "prometheus_exporter",
          inputs: ["vectory_internal_metrics"],
          address: "127.0.0.1:9598",
        },
      },
    },
  },
  {
    id: "syslog-loki",
    title: "Syslog to Loki",
    summary: "Syslog over TCP → Grafana Loki",
    needs: [
      "Hosts that forward syslog to TCP port 1514 on the device.",
      "A Loki push endpoint in place of http://loki.example.internal:3100.",
    ],
    config: {
      sources: {
        syslog: { type: "syslog", mode: "tcp", address: "0.0.0.0:1514" },
      },
      sinks: {
        loki: {
          type: "loki",
          inputs: ["syslog"],
          endpoint: "http://loki.example.internal:3100",
          encoding: { codec: "json" },
          labels: { job: "syslog", host: "{{ host }}" },
        },
      },
    },
  },
  {
    id: "files-s3",
    title: "Files to Amazon S3",
    summary: "Log files → S3 with a disk buffer",
    needs: [
      "Log files at /var/log/app/*.log (or your own paths).",
      "An S3 bucket and region in place of example-log-archive and us-east-1.",
      "AWS credentials on each device, such as an instance role.",
    ],
    config: {
      sources: {
        app_logs: { type: "file", include: ["/var/log/app/*.log"] },
      },
      sinks: {
        archive: {
          type: "aws_s3",
          inputs: ["app_logs"],
          bucket: "example-log-archive",
          region: "us-east-1",
          key_prefix: "logs/%Y/%m/%d/",
          compression: "gzip",
          encoding: { codec: "json" },
          buffer: { type: "disk", max_size: 268435488, when_full: "block" },
        },
      },
    },
  },
  {
    id: "otlp-gateway",
    title: "OpenTelemetry gateway",
    summary: "OTLP logs in → OTLP out to your collector",
    needs: [
      "Applications that send OTLP to ports 4317 (gRPC) or 4318 (HTTP).",
      "An OTLP/HTTP logs endpoint in place of http://collector.example.internal:4318/v1/logs.",
    ],
    config: {
      sources: {
        otlp: {
          type: "opentelemetry",
          grpc: { address: "0.0.0.0:4317" },
          http: { address: "0.0.0.0:4318" },
        },
      },
      sinks: {
        collector: {
          type: "opentelemetry",
          inputs: ["otlp.logs"],
          protocol: {
            type: "http",
            uri: "http://collector.example.internal:4318/v1/logs",
            encoding: { codec: "json" },
          },
        },
      },
    },
  },
  {
    id: "nginx-elasticsearch",
    title: "Nginx to Elasticsearch",
    summary: "Nginx access logs → parse → Elasticsearch",
    needs: [
      "Nginx access logs at /var/log/nginx/access.log in the combined format.",
      "An Elasticsearch endpoint in place of http://elasticsearch.example.internal:9200.",
    ],
    config: {
      sources: {
        nginx: { type: "file", include: ["/var/log/nginx/access.log"] },
      },
      transforms: {
        parse: {
          type: "remap",
          inputs: ["nginx"],
          source:
            '# Unparsed lines keep their original message and gain an error field.\nparsed, err = parse_nginx_log(.message, "combined")\nif err == null {\n  . = merge(., parsed)\n} else {\n  .parse_error = err\n}',
        },
      },
      sinks: {
        search: {
          type: "elasticsearch",
          inputs: ["parse"],
          endpoints: ["http://elasticsearch.example.internal:9200"],
          bulk: { index: "nginx-%Y.%m.%d" },
        },
      },
    },
  },
  {
    id: "host-metrics-prometheus",
    title: "Host metrics for Prometheus",
    summary: "CPU, memory, disk and network → Prometheus scrape endpoint",
    needs: ["A Prometheus server that can reach port 9599 on each device."],
    config: {
      sources: {
        host: {
          type: "host_metrics",
          collectors: [
            "cpu",
            "memory",
            "disk",
            "filesystem",
            "load",
            "network",
          ],
          scrape_interval_secs: 15,
        },
      },
      sinks: {
        prometheus: {
          type: "prometheus_exporter",
          inputs: ["host"],
          address: "0.0.0.0:9599",
        },
      },
    },
  },
  {
    id: "volume-control",
    title: "Volume control",
    summary: "Keep 1 in 20 debug lines, cap the rest, forward over HTTP",
    needs: [
      "Log files at /var/log/app/*.log with a JSON level field.",
      "An HTTP endpoint in place of http://logs.example.internal:8080/ingest.",
    ],
    config: {
      sources: {
        app_logs: { type: "file", include: ["/var/log/app/*.log"] },
      },
      transforms: {
        parse: {
          type: "remap",
          inputs: ["app_logs"],
          source:
            'parsed, err = parse_json(.message)\nif err == null && is_object(parsed) {\n  . = merge(., object!(parsed))\n}\n.level = downcase(string(.level) ?? "info")',
        },
        by_level: {
          type: "route",
          inputs: ["parse"],
          route: { debug: '.level == "debug"' },
        },
        sample_debug: {
          type: "sample",
          inputs: ["by_level.debug"],
          rate: 20,
        },
        cap: {
          type: "throttle",
          inputs: ["by_level._unmatched"],
          threshold: 5000,
          window_secs: 1,
        },
      },
      sinks: {
        forward: {
          type: "http",
          inputs: ["sample_debug", "cap"],
          uri: "http://logs.example.internal:8080/ingest",
          encoding: { codec: "json" },
        },
      },
    },
  },
  {
    id: "pii-redaction",
    title: "PII redaction",
    summary: "Mask emails, card and social security numbers before shipping",
    needs: [
      "Log files at /var/log/app/*.log (or your own paths).",
      "An HTTP endpoint in place of http://logs.example.internal:8080/ingest.",
    ],
    config: {
      sources: {
        app_logs: { type: "file", include: ["/var/log/app/*.log"] },
      },
      transforms: {
        redact_pii: {
          type: "remap",
          inputs: ["app_logs"],
          source:
            "# Masks common identifiers in the message. Review for your data.\n.message = redact(string(.message) ?? \"\", filters: [\n  \"us_social_security_number\",\n  r'[\\w.+-]+@[\\w-]+\\.[\\w.-]+',\n  r'\\b(?:\\d[ -]?){13,16}\\b'\n])",
        },
      },
      sinks: {
        forward: {
          type: "http",
          inputs: ["redact_pii"],
          uri: "http://logs.example.internal:8080/ingest",
          encoding: { codec: "json" },
        },
      },
    },
  },
];

export function pipelineTemplate(id: string) {
  return pipelineTemplates.find((template) => template.id === id) ?? null;
}

/** The Vectory monitoring pair: Vector's own metrics on a local endpoint. */
export const MONITORING_SOURCE = "vectory_internal_metrics";
export const MONITORING_SINK = "vectory_metrics_exporter";
export const MONITORING_ADDRESS = "127.0.0.1:9598";

/**
 * Add Vector's internal metrics exported for local scraping. Existing steps
 * are never replaced: a taken ID gets a numbered suffix. Null when this
 * pipeline already exports its internal metrics.
 */
export function withMonitoring(config: Config): Config | null {
  const taken = new Set(
    ["sources", "transforms", "sinks", "enrichment_tables"].flatMap((section) =>
      Object.keys((config?.[section] as Config) || {}),
    ),
  );
  const internal = Object.entries((config?.sources as Config) || {}).find(
    ([, source]) => (source as Config)?.type === "internal_metrics",
  );
  const exported =
    internal &&
    Object.values((config?.sinks as Config) || {}).some(
      (sink) =>
        (sink as Config)?.type === "prometheus_exporter" &&
        Array.isArray((sink as Config).inputs) &&
        (sink as Config).inputs.includes(internal[0]),
    );
  if (exported) return null;
  const free = (base: string) => {
    let id = base,
      number = 2;
    while (taken.has(id)) id = `${base}_${number++}`;
    taken.add(id);
    return id;
  };
  const source = internal ? internal[0] : free(MONITORING_SOURCE);
  const sink = free(MONITORING_SINK);
  const addresses = new Set(
    Object.values((config?.sinks as Config) || {}).map(
      (item) => (item as Config)?.address,
    ),
  );
  let port = 9598;
  while (addresses.has(`127.0.0.1:${port}`)) port++;
  return {
    ...config,
    sources: {
      ...(config?.sources || {}),
      ...(internal ? {} : { [source]: { type: "internal_metrics" } }),
    },
    sinks: {
      ...(config?.sinks || {}),
      [sink]: {
        type: "prometheus_exporter",
        inputs: [source],
        address: `127.0.0.1:${port}`,
      },
    },
  };
}
