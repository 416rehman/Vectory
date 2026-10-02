import { describe, expect, it } from "vitest";
import catalog from "./generated/vector-catalog.json";
import {
  allowancesFile,
  describeNeeds,
  fullModeRequirements,
  hostApprovals,
  localApiReason,
  loopbackListener,
  monitoringExporter,
} from "./hostRequirements";
import { pipelineTemplate } from "./pipelineTemplates";

describe("the monitoring exporter restricted mode runs as is", () => {
  const monitored = {
    sources: {
      demo: { type: "demo_logs", format: "json" },
      vectory_internal_metrics: { type: "internal_metrics" },
    },
    sinks: {
      out: {
        type: "console",
        inputs: ["demo"],
        encoding: { codec: "json" },
        target: "stderr",
      },
      vectory_metrics_exporter: {
        type: "prometheus_exporter",
        inputs: ["vectory_internal_metrics"],
        address: "127.0.0.1:9598",
      },
    },
  };
  const exporter = monitored.sinks.vectory_metrics_exporter;
  const withExporter = (patch: object, id = "vectory_metrics_exporter") => ({
    ...monitored,
    sinks: { ...monitored.sinks, [id]: { ...exporter, ...patch } },
  });
  it("needs no listener allowance, like the agent decides", () => {
    expect(monitoringExporter(monitored)).toBe("vectory_metrics_exporter");
    expect(hostApprovals(monitored)).toEqual({
      destinations: [],
      listeners: [],
      fileRoots: [],
    });
    expect(describeNeeds(monitored, catalog).kind).toBe("none");
    expect(
      hostApprovals(withExporter({ address: "[::1]:9598" })).listeners,
    ).toEqual([]);
  });
  it("still asks for anything else that listens", () => {
    for (const [patch, listener] of [
      [{ address: "0.0.0.0:9598" }, "0.0.0.0:9598"],
      [{ address: "localhost:9598" }, "localhost:9598"],
      [{ address: "10.0.0.5:9598" }, "10.0.0.5:9598"],
      [{ inputs: ["vectory_internal_metrics", "demo"] }, "127.0.0.1:9598"],
      [{ inputs: ["demo"] }, "127.0.0.1:9598"],
    ] as const)
      expect(hostApprovals(withExporter(patch)).listeners).toEqual([listener]);
    // Only one exporter is exempt; a second one needs its allowance.
    expect(
      hostApprovals(withExporter({ address: "127.0.0.1:9599" }, "zz_second"))
        .listeners,
    ).toEqual(["127.0.0.1:9599"]);
  });
  it("reads loopback literals the way the agent does", () => {
    for (const address of ["127.0.0.1:9598", "127.1.2.3:1", "[::1]:65535"])
      expect(loopbackListener(address)).toBe(true);
    for (const address of [
      "localhost:9598",
      "127.0.0.1",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "0.0.0.0:9598",
      "[::]:9598",
      "::1:9598",
      "127.0.0.01:9598",
      "1270.0.0.1:9598",
    ])
      expect(loopbackListener(address)).toBe(false);
  });
  it("is exactly what the synthetic example ships", () => {
    const example = pipelineTemplate("synthetic-demo")!.config;
    expect(monitoringExporter(example)).not.toBeNull();
    expect(hostApprovals(example).listeners).toEqual([]);
  });
});

describe("restricted-host approvals", () => {
  it("finds destinations, listeners and file roots the way the agent checks them", () => {
    const approvals = hostApprovals({
      data_dir: "/var/lib/vector",
      sources: {
        nginx: { type: "file", include: ["/var/log/nginx/*.log"] },
        syslog: { type: "syslog", address: "0.0.0.0:1514", mode: "tcp" },
      },
      sinks: {
        loki: {
          type: "loki",
          endpoint: "https://logs.example.net",
          inputs: [],
        },
        es: {
          type: "elasticsearch",
          endpoints: ["http://10.0.0.5:9200"],
          inputs: [],
        },
      },
    });
    expect(approvals).toEqual({
      destinations: ["10.0.0.5:9200", "logs.example.net:443"],
      listeners: ["0.0.0.0:1514"],
      fileRoots: ["/var/lib/vector", "/var/log/nginx"],
    });
    expect(JSON.parse(allowancesFile(approvals))).toEqual({
      allowed_file_roots: ["/var/lib/vector", "/var/log/nginx"],
      allowed_network_hosts: ["10.0.0.5:9200", "logs.example.net:443"],
      allowed_listen_addresses: ["0.0.0.0:1514"],
    });
  });
  it("does not take an HTTP route's path for a file root", () => {
    expect(
      hostApprovals({
        sources: {
          in: { type: "http_server", address: "0.0.0.0:8080", path: "/ingest" },
        },
        sinks: {
          loki: {
            type: "loki",
            endpoint: "https://logs.example.net",
            path: "/loki/api/v1/push",
            inputs: [],
          },
        },
      }),
    ).toEqual({
      destinations: ["logs.example.net:443"],
      listeners: ["0.0.0.0:8080"],
      fileRoots: [],
    });
  });
  it("needs nothing for a self-contained pipeline", () => {
    expect(
      hostApprovals({
        sources: { demo: { type: "demo_logs", format: "json" } },
        sinks: { out: { type: "blackhole", inputs: ["demo"] } },
      }),
    ).toEqual({ destinations: [], listeners: [], fileRoots: [] });
  });
});

describe("what a pipeline asks of its devices", () => {
  it("names Full Vector when a restricted device would refuse the pipeline outright", () => {
    const config = {
      sources: { host: { type: "host_metrics" } },
      sinks: {
        out: {
          type: "prometheus_exporter",
          inputs: ["host"],
          address: "127.0.0.1:9599",
        },
      },
    };
    expect(fullModeRequirements(config, catalog)).toEqual([
      "source: host_metrics",
    ]);
    expect(describeNeeds(config, catalog)).toMatchObject({
      kind: "full",
      label: "Needs Full Vector",
    });
  });
  it("asks for Full Vector mode for any api block, whatever it says, and gives the reason once", () => {
    const base = {
      sources: { demo: { type: "demo_logs", format: "json" } },
      sinks: { out: { type: "blackhole", inputs: ["demo"] } },
    };
    // The server and the agent refuse the block the same way: Vector's API has
    // no authentication, so the address and the switch make no difference.
    for (const api of [
      { enabled: true, address: "127.0.0.1:8686" },
      { enabled: true, address: "[::1]:8686" },
      { enabled: true, address: "0.0.0.0:8686" },
      { enabled: true, address: "localhost:8686" },
      { enabled: true },
      { enabled: false },
      {},
      null,
    ])
      expect(
        fullModeRequirements({ ...base, api }, catalog),
        JSON.stringify(api),
      ).toEqual([
        "Global setting: api (Vector's local API has no authentication; any local user could read live events)",
      ]);
    expect(localApiReason).toBe(
      "Vector's local API has no authentication; any local user could read live events",
    );
    expect(
      describeNeeds({ ...base, api: { enabled: false } }, catalog),
    ).toEqual({
      kind: "full",
      label: "Needs Full Vector",
      detail: `Uses Global setting: api (${localApiReason}). Runs only on devices in Full Vector mode.`,
    });
    // Without the block nothing is asked, and the other settings still are.
    expect(fullModeRequirements(base, catalog)).toEqual([]);
    expect(
      fullModeRequirements({ ...base, api: {}, schema: {} }, catalog),
    ).toEqual([
      `Global setting: api (${localApiReason})`,
      "Global setting: schema",
    ]);
  });
  it("names what a restricted host has to approve, briefly", () => {
    expect(
      describeNeeds(
        {
          sources: {
            nginx: { type: "file", include: ["/var/log/nginx/*.log"] },
          },
          sinks: {
            loki: {
              type: "loki",
              endpoint: "https://logs.example.net",
              inputs: ["nginx"],
            },
          },
        },
        catalog,
      ),
    ).toMatchObject({
      kind: "approval",
      label: "Host approval: /var/log/nginx, logs.example.net:443",
    });
  });
  it("treats a function's name inside data as data, not a call", () => {
    const pipeline = (source: string) => ({
      sources: { demo: { type: "demo_logs", format: "json" } },
      transforms: { r: { type: "remap", inputs: ["demo"], source } },
      sinks: { out: { type: "blackhole", inputs: ["r"] } },
    });
    for (const source of [
      '.kind = "http_request_log"',
      '.name = "http_requests_total"',
      ".parse_proto = 1\n.get_env_var = 2",
    ])
      expect(fullModeRequirements(pipeline(source), catalog)).toEqual([]);
    // A step called http_requests, a metric of that name, a tag named file.
    expect(
      fullModeRequirements(
        {
          sources: { demo: { type: "demo_logs", format: "json" } },
          transforms: {
            http_requests: {
              type: "log_to_metric",
              inputs: ["demo"],
              metrics: [
                {
                  type: "counter",
                  field: "message",
                  name: "http_requests_total",
                  tags: { file: "app" },
                },
              ],
            },
          },
          sinks: { out: { type: "blackhole", inputs: ["http_requests"] } },
        },
        catalog,
      ),
    ).toEqual([]);
  });

  it("names every call a restricted device would refuse", () => {
    const pipeline = (source: string) => ({
      sources: { demo: { type: "demo_logs", format: "json" } },
      transforms: { r: { type: "remap", inputs: ["demo"], source } },
      sinks: { out: { type: "blackhole", inputs: ["r"] } },
    });
    for (const source of [
      'http_request!("https://example.test")',
      'http_request! ("https://example.test")',
      '.a, err = http_request("https://example.test")',
      'get_env_var!("HOME")',
      "dns_lookup!(.host)",
      'validate_json_schema!(.message, "/schema.json")',
      'parse_proto!(.message, "/d.desc", "a.B")',
      'encode_proto!(.message, "/d.desc", "a.B")',
      'get_enrichment_table_record!("t", {})',
      'find_enrichment_table_records!("t", {})',
    ])
      expect(fullModeRequirements(pipeline(source), catalog), source).toEqual([
        "VRL access to device resources",
      ]);
    expect(
      fullModeRequirements(
        {
          ...pipeline(".x = 1"),
          transforms: {
            r: { type: "remap", inputs: ["demo"], file: "/etc/program.vrl" },
          },
        },
        catalog,
      ),
    ).toEqual(["Native capability: file"]);
  });

  it("accepts unit tests, whose events are data and whose VRL is held to the same list", () => {
    const base = {
      sources: { demo: { type: "demo_logs", format: "json" } },
      transforms: { r: { type: "remap", inputs: ["demo"], source: ".x = 1" } },
      sinks: { out: { type: "blackhole", inputs: ["r"] } },
    };
    const tests = (source: string) => [
      {
        name: "sets x",
        inputs: [
          {
            insert_at: "r",
            type: "log",
            log_fields: { message: "GET /etc/passwd $HOME {{ x }}" },
          },
        ],
        outputs: [{ extract_from: "r", conditions: [{ type: "vrl", source }] }],
      },
    ];
    expect(
      fullModeRequirements({ ...base, tests: tests(".x == 1") }, catalog),
    ).toEqual([]);
    expect(
      fullModeRequirements(
        { ...base, tests: tests('get_env_var!("HOME") == "/root"') },
        catalog,
      ),
    ).toEqual(["VRL access to device resources"]);
  });

  it("says nothing for a self-contained pipeline", () => {
    expect(
      describeNeeds(
        {
          sources: { demo: { type: "demo_logs", format: "json" } },
          sinks: { out: { type: "blackhole", inputs: ["demo"] } },
        },
        catalog,
      ),
    ).toEqual({ kind: "none", label: null, detail: null });
  });
});
