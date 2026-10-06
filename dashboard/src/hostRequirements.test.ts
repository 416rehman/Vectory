import { describe, expect, it } from "vitest";
import catalog from "./generated/vector-catalog.json";
import {
  allowancesFile,
  describeNeeds,
  fullModeRequirements,
  hostApprovals,
  loopbackListener,
  monitoringExporter,
  vectorApiExposure,
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

  it("uses Windows absolute paths, wildcards, trailing separators and UNC shares only on Windows", () => {
    const config = {
      data_dir: "C:\\VectorData\\logs\\",
      sources: {
        logs: {
          type: "file",
          include: [
            "C:/ProgramData/Vectory/events/*.log",
            "\\\\fileserver\\shared\\app\\*.log",
            "/var/log/unix/*.log",
            "C:relative\\*.log",
            "\\root-relative\\*.log",
          ],
        },
      },
    };
    expect(hostApprovals(config, "windows").fileRoots).toEqual([
      "C:\\ProgramData\\Vectory\\events",
      "C:\\VectorData\\logs",
      "\\\\fileserver\\shared\\app",
    ]);
    expect(hostApprovals(config, "linux").fileRoots).toEqual(["/var/log/unix"]);
    expect(
      hostApprovals(
        {
          sources: {
            logs: { type: "file", data_dir: "\\\\srv\\share\\logs\\" },
          },
        },
        "windows",
      ).fileRoots,
    ).toEqual(["\\\\srv\\share\\logs"]);
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
  it("asks for Full Vector mode for any api block, even when the API is disabled", () => {
    const base = {
      sources: { demo: { type: "demo_logs", format: "json" } },
      sinks: { out: { type: "blackhole", inputs: ["demo"] } },
    };
    // The server and the agent refuse the block the same way: the address and
    // enabled switch make no difference to the Full Vector requirement.
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
      ).toEqual(["Global setting: api"]);
    expect(
      describeNeeds({ ...base, api: { enabled: false } }, catalog),
    ).toEqual({
      kind: "full",
      label: "Needs Full Vector",
      detail:
        "Uses Global setting: api. Runs only on devices in Full Vector mode.",
    });
    // Without the block nothing is asked, and the other settings still are.
    expect(fullModeRequirements(base, catalog)).toEqual([]);
    expect(
      fullModeRequirements({ ...base, api: {}, schema: {} }, catalog),
    ).toEqual(["Global setting: api", "Global setting: schema"]);
  });
  it("warns only for an enabled API and describes who can reach it", () => {
    for (const api of [undefined, null, {}, { enabled: false }])
      expect(vectorApiExposure({ api })).toBeNull();
    const defaultAddress = vectorApiExposure({ api: { enabled: true } });
    expect(defaultAddress).toContain("127.0.0.1:8686");
    expect(defaultAddress).toContain("Only clients on each device");
    expect(defaultAddress).toContain("stream live events");
    expect(
      vectorApiExposure({ api: { enabled: true, address: "[::1]:8686" } }),
    ).toContain("loopback listener");
    for (const address of ["0.0.0.0:8686", "[::]:8686"])
      expect(vectorApiExposure({ api: { enabled: true, address } })).toContain(
        "listens on every interface",
      );
    for (const address of ["192.0.2.10:8686", "localhost:8686"])
      expect(vectorApiExposure({ api: { enabled: true, address } })).toContain(
        "not a verified loopback address",
      );
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

// A restricted device refuses two AWS credential shapes whatever the host
// allows: a credentials file (it can make Vector run a program) and the AWS
// strategy without explicit keys (it signs with the host's own identity).
describe("AWS credentials a restricted device refuses outright", () => {
  const credentialsFile = "Native capability: credentials_file";
  const hostIdentity =
    "AWS credentials from the host (without both keys, or with assume_role, imds or profile)";
  // Elasticsearch flattens the credential into auth; the shared HTTP
  // authentication of the others nests it one level down, in auth.auth.
  const sinks: Record<
    string,
    {
      sink: (auth: Record<string, unknown>) => Record<string, unknown>;
      nested: boolean;
    }
  > = {
    elasticsearch: {
      nested: false,
      sink: (auth) => ({
        type: "elasticsearch",
        inputs: ["in"],
        endpoints: ["https://search.example.net"],
        aws: { region: "us-east-1" },
        auth,
      }),
    },
    http: {
      nested: true,
      sink: (auth) => ({
        type: "http",
        inputs: ["in"],
        uri: "https://ingest.example.net/events",
        encoding: { codec: "json" },
        auth,
      }),
    },
    loki: {
      nested: true,
      sink: (auth) => ({
        type: "loki",
        inputs: ["in"],
        endpoint: "https://loki.example.net",
        labels: { job: "vector" },
        encoding: { codec: "json" },
        auth,
      }),
    },
    prometheus_exporter: {
      nested: true,
      sink: (auth) => ({
        type: "prometheus_exporter",
        inputs: ["in"],
        address: "0.0.0.0:9598",
        auth,
      }),
    },
  };
  const pipeline = (sink: Record<string, unknown>) => ({
    sources: { in: { type: "demo_logs", format: "json" } },
    sinks: { out: sink },
  });
  /** The `auth` block with the credential where this sink reads it. */
  const auth = (
    typ: string,
    credential: Record<string, unknown>,
    strategy = "aws",
  ) =>
    sinks[typ].nested
      ? { strategy, service: "es", auth: credential }
      : { strategy, ...credential };
  const needs = (typ: string, credential: Record<string, unknown>) =>
    fullModeRequirements(
      pipeline(sinks[typ].sink(auth(typ, credential))),
      catalog,
    );
  const keys = {
    access_key_id: "AKIAIOSFODNN7EXAMPLE",
    secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const role = "arn:aws:iam::123456789012:role/vector";

  it("names the host's identity for each shape that borrows it, in each sink", () => {
    const ambient: Record<string, Record<string, unknown>> = {
      "no keys": {},
      "only a region": { region: "us-east-1" },
      "only the access key ID": { access_key_id: keys.access_key_id },
      "only the secret access key": {
        secret_access_key: keys.secret_access_key,
      },
      "empty keys": { access_key_id: "", secret_access_key: "" },
      "an empty secret access key": { ...keys, secret_access_key: "" },
      "blank keys": { ...keys, secret_access_key: " \t\n\u{a0}\u{85}\u{3000}" },
      "keys that are not strings": {
        access_key_id: 1,
        secret_access_key: true,
      },
      "null keys": { access_key_id: null, secret_access_key: null },
      "only a role to assume": { assume_role: role },
      "a role beside the keys": { ...keys, assume_role: role },
      "only the metadata client": { imds: { max_attempts: 2 } },
      "the metadata client beside keys": {
        ...keys,
        imds: { max_attempts: 2 },
      },
      "only a profile": { profile: "default" },
      "a profile beside the keys": { ...keys, profile: "vector" },
      "a role spelled in capitals": { ...keys, ASSUME_ROLE: role },
      "an empty profile": { ...keys, profile: "" },
      "an empty metadata client": { ...keys, imds: {} },
      "only a session token": { session_token: "token" },
      "keys under a spelling Vector refuses": {
        Access_Key_Id: "AKIA",
        Secret_Access_Key: "x",
      },
    };
    for (const typ of Object.keys(sinks))
      for (const [name, credential] of Object.entries(ambient))
        expect(needs(typ, credential), `${typ}, ${name}`).toEqual([
          hostIdentity,
        ]);
  });

  it("accepts both explicit keys, whatever else is set that borrows nothing", () => {
    for (const typ of Object.keys(sinks))
      for (const credential of [
        keys,
        { ...keys, session_token: "AQoDYXdz" },
        { ...keys, region: "eu-west-1" },
        { ...keys, assume_role: null },
        { ...keys, imds: false, profile: null },
        // A device secret is a plain string to the server, as to the agent.
        {
          access_key_id: "vectory-secret:AWS_KEY_ID",
          secret_access_key: "vectory-secret:AWS_SECRET_KEY",
        },
        // Space that String.trim removes and the agent's check doesn't.
        { ...keys, secret_access_key: "\u{feff}" },
      ])
        expect(needs(typ, credential), typ).toEqual([]);
  });

  it("reads the strategy the way the agent does", () => {
    for (const typ of Object.keys(sinks)) {
      const check = (strategy: string, credential: Record<string, unknown>) =>
        fullModeRequirements(
          pipeline(sinks[typ].sink(auth(typ, credential, strategy))),
          catalog,
        );
      // In any case: the agent compares the strategy ignoring case.
      for (const strategy of ["AWS", "Aws", "aWs"]) {
        expect(check(strategy, {}), `${typ} ${strategy}`).toEqual([
          hostIdentity,
        ]);
        expect(check(strategy, keys), `${typ} ${strategy}`).toEqual([]);
      }
      // Any other strategy is not AWS, with or without keys.
      for (const strategy of ["basic", "bearer", "custom", "", "aws "])
        expect(check(strategy, {}), `${typ} ${strategy}`).toEqual([]);
    }
  });

  it("judges the keys where the sink reads them", () => {
    // Elasticsearch reads the keys in auth: keys in auth.auth are decoys.
    expect(
      fullModeRequirements(
        pipeline(
          sinks.elasticsearch.sink({ strategy: "aws", auth: { ...keys } }),
        ),
        catalog,
      ),
    ).toEqual([hostIdentity]);
    for (const typ of ["http", "loki", "prometheus_exporter"]) {
      // The others read them in auth.auth: keys in auth are decoys.
      expect(
        fullModeRequirements(
          pipeline(
            sinks[typ].sink({ strategy: "aws", service: "es", ...keys }),
          ),
          catalog,
        ),
        typ,
      ).toEqual([hostIdentity]);
      // A missing block, and one that isn't an object, read as empty.
      for (const block of [undefined, null, "aws", [keys], 7])
        expect(
          fullModeRequirements(
            pipeline(
              sinks[typ].sink({ strategy: "aws", service: "es", auth: block }),
            ),
            catalog,
          ),
          `${typ} ${JSON.stringify(block)}`,
        ).toEqual([hostIdentity]);
    }
    // An auth that isn't a block names no strategy.
    for (const value of ["aws", ["aws"], null, 1])
      for (const typ of Object.keys(sinks))
        expect(
          fullModeRequirements(
            pipeline(sinks[typ].sink(value as never)),
            catalog,
          ),
          `${typ} ${JSON.stringify(value)}`,
        ).toEqual([]);
    // `auth` and `strategy` are read as written, as Vector reads them.
    for (const typ of Object.keys(sinks)) {
      const { auth: block, ...rest } = sinks[typ].sink(auth(typ, {}));
      expect(
        fullModeRequirements(pipeline({ ...rest, Auth: block }), catalog),
        `${typ}, Auth`,
      ).toEqual([]);
      const { strategy, ...others } = block as Record<string, unknown>;
      expect(
        fullModeRequirements(
          pipeline({ ...rest, auth: { ...others, STRATEGY: strategy } }),
          catalog,
        ),
        `${typ}, STRATEGY`,
      ).toEqual([]);
    }
    // Only the four sinks that take the credential are judged by it.
    expect(
      fullModeRequirements(
        pipeline({
          type: "blackhole",
          inputs: ["in"],
          auth: { strategy: "aws" },
        }),
        catalog,
      ),
    ).toEqual([]);
    expect(
      fullModeRequirements(
        pipeline({
          type: "console",
          inputs: ["in"],
          target: "stderr",
          encoding: { codec: "json" },
          auth: { strategy: "aws" },
        }),
        catalog,
      ),
    ).toEqual([]);
  });

  it("names a credentials file wherever it stands below auth, beside keys or not", () => {
    for (const typ of Object.keys(sinks)) {
      const file = { credentials_file: "/srv/aws/credentials" };
      for (const [name, credential] of Object.entries({
        "beside both keys": { ...keys, ...file },
        "an empty value": { ...keys, credentials_file: "" },
        "a null value": { ...keys, credentials_file: null },
        "not a path": { ...keys, credentials_file: 7 },
        "spelled in capitals": { ...keys, CREDENTIALS_FILE: "/srv/aws" },
        "mixed case": { ...keys, Credentials_File: "/srv/aws" },
        deeper: { ...keys, a: { b: { c: file } } },
        "in a list": { ...keys, a: [{ b: file }] },
        "in a list in a list": { ...keys, a: [[file]] },
      }))
        expect(needs(typ, credential), `${typ}, ${name}`).toEqual([
          credentialsFile,
        ]);
      // Both reasons, the file first.
      expect(needs(typ, { ...file, profile: "vector" })).toEqual([
        credentialsFile,
        hostIdentity,
      ]);
    }
    // Whatever the strategy, and whatever the sink: below auth, it is a file.
    for (const strategy of ["basic", "aws", ""])
      expect(
        fullModeRequirements(
          pipeline({
            type: "blackhole",
            inputs: ["in"],
            auth: { strategy, credentials_file: "/srv/aws" },
          }),
          catalog,
        ),
        strategy,
      ).toEqual([credentialsFile]);
    // An auth that is a list holds what is below it.
    expect(
      fullModeRequirements(
        pipeline({
          type: "blackhole",
          inputs: ["in"],
          auth: [{ credentials_file: "/srv/aws" }],
        }),
        catalog,
      ),
    ).toEqual([credentialsFile]);
    // The key and the block, in any case, at the root of the sink.
    expect(
      fullModeRequirements(
        pipeline({
          type: "blackhole",
          inputs: ["in"],
          Auth: { Credentials_File: "/srv/aws" },
        }),
        catalog,
      ),
    ).toEqual([credentialsFile]);
    // Sources and transforms are components too.
    expect(
      fullModeRequirements(
        {
          sources: {
            in: {
              type: "demo_logs",
              format: "json",
              auth: { credentials_file: "/x" },
            },
          },
          sinks: { out: { type: "blackhole", inputs: ["in"] } },
        },
        catalog,
      ),
    ).toEqual([credentialsFile]);
  });

  it("leaves a key of that name alone where it isn't below auth", () => {
    for (const component of [
      {
        type: "loki",
        endpoint: "https://loki.example.net",
        labels: { credentials_file: "app" },
        encoding: { codec: "json" },
      },
      { type: "blackhole", tags: { credentials_file: "app" } },
      { type: "blackhole", encoding: { credentials_file: "app" } },
      // Only keys at or below an auth block count. One above it is a path like
      // any other, which a host's file roots allow or refuse.
      { type: "blackhole", credentials_file: "/srv/aws/credentials" },
      { type: "blackhole", credentials_file: { auth: {} } },
    ])
      expect(
        fullModeRequirements(
          pipeline({ inputs: ["in"], ...component }),
          catalog,
        ),
        JSON.stringify(component),
      ).toEqual([]);
    // In a program, a field of that name is data.
    expect(
      fullModeRequirements(
        {
          sources: { in: { type: "demo_logs", format: "json" } },
          transforms: {
            r: {
              type: "remap",
              inputs: ["in"],
              source: '.credentials_file = "x"',
            },
          },
          sinks: { out: { type: "blackhole", inputs: ["r"] } },
        },
        catalog,
      ),
    ).toEqual([]);
    // Unit tests are data as well.
    expect(
      fullModeRequirements(
        {
          sources: { in: { type: "demo_logs", format: "json" } },
          sinks: { out: { type: "blackhole", inputs: ["in"] } },
          tests: [
            {
              name: "t",
              inputs: [{ insert_at: "out", auth: { credentials_file: "/x" } }],
            },
          ],
        },
        catalog,
      ),
    ).toEqual([]);
  });

  it("says so in one line for a template card or a pipeline row", () => {
    expect(
      describeNeeds(
        pipeline(
          sinks.http.sink(
            auth("http", { credentials_file: "/srv/aws", profile: "v" }),
          ),
        ),
        catalog,
      ),
    ).toEqual({
      kind: "full",
      label: "Needs Full Vector",
      detail: `Uses ${credentialsFile}, ${hostIdentity}. Runs only on devices in Full Vector mode.`,
    });
  });
});
