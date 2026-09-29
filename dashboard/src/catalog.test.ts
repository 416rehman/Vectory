import { describe, it, expect } from "vitest";
import {
  connect,
  starter,
  toGraph,
  validateGraph,
  outputPorts,
  catalog,
  addConnectedComponent,
  acceptsComponentInput,
  removePipelineStep,
  suggestedInput,
  orderedStepIds,
  pipelineIssues,
  sameConfiguration,
  componentSchema,
  vectorSchema,
  defaultComponentId,
  displayLabel,
  REMAP_STARTER,
} from "./catalog";
import { componentTitle } from "./pipelineNodeModel";
import {
  resolveSchema,
  setSchemaProperty,
  requiredSchemaIssues,
} from "./pipelineSchema";
describe("canonical graph round trip and connection rules", () => {
  it("adds a source on blank canvas without wiring or replacing existing inputs", () => {
    const config = {
      sources: { original: { type: "demo_logs" } },
      sinks: { out: { type: "console", inputs: ["original"] } },
    };
    const item = catalog.find(
      (item) => item.kind === "sources" && item.type === "demo_logs",
    )!;
    const result = addConnectedComponent(config, item, "", [], {
      autoConnectSource: false,
    });
    expect(result.config.sinks.out.inputs).toEqual(["original"]);
    expect(toGraph(result.config).edges).toHaveLength(1);
  });
  it("adds a branch from an exact named output without rerouting its existing consumers", () => {
    const config = {
      sources: { otel: { type: "opentelemetry" } },
      sinks: { out: { type: "console", inputs: ["otel.logs"] } },
    };
    const item = catalog.find(
      (item) => item.kind === "transforms" && item.type === "sample",
    )!;
    const result = addConnectedComponent(config, item, "otel.logs", [], {
      autoConnectSource: false,
    });
    expect(result.config.transforms[result.id].inputs).toEqual(["otel.logs"]);
    expect(result.config.sinks.out.inputs).toEqual(["otel.logs"]);
    expect(acceptsComponentInput(config, "otel.logs", item)).toBe(true);
    expect(acceptsComponentInput(config, "otel.metrics", item)).toBe(false);
    expect(
      acceptsComponentInput(
        config,
        "otel.logs",
        catalog.find((item) => item.kind === "sources")!,
      ),
    ).toBe(false);
  });
  it("rejects known incompatible event streams through transforms", () => {
    const c = {
      sources: { otel: { type: "opentelemetry" } },
      transforms: {
        map: { type: "remap", inputs: ["otel.metrics"], source: ".foo = 1" },
        sample: { type: "sample", inputs: [], rate: 10 },
      },
    };
    expect(() => connect(c, "map", "sample")).toThrow(
      "incompatible event types",
    );
    expect(() => connect(c, "otel", "sample", "logs")).not.toThrow();
    expect(() => toGraph({ sources: { broken: null } })).not.toThrow();
    expect(validateGraph({ sources: { broken: null } })).toContain(
      "broken: component type is required",
    );
  });
  it("preserves OpenTelemetry named outputs and remap dropped stream", () => {
    const c = {
      sources: { otel: { type: "opentelemetry" } },
      sinks: { out: { type: "console", inputs: ["otel.logs"] } },
    };
    expect(validateGraph(c)).toEqual([]);
    expect(toGraph(c).edges[0].sourceHandle).toBe("logs");
    c.sinks.out.inputs = ["otel"];
    expect(validateGraph(c).join(" ")).toContain("named component output");
    expect(outputPorts({ type: "remap", reroute_dropped: true })).toEqual([
      "output",
      "dropped",
    ]);
  });
  it("preserves opaque component properties and layout independently of runtime config", () => {
    const config = structuredClone(starter);
    config.sources.demo.unknown_future_option = { semantic: true };
    const before = JSON.stringify(config);
    const graph = toGraph(config);
    graph.nodes[0].position = { x: 987, y: 654 };
    expect(toGraph(config, graph).nodes[0].position).toEqual({
      x: 987,
      y: 654,
    });
    expect(JSON.stringify(config)).toBe(before);
  });
  it("renders named route edges with correct port and rejects unnamed route reference", () => {
    const config = {
      sources: { a: { type: "demo_logs" } },
      transforms: {
        branch: {
          type: "route",
          inputs: ["a"],
          route: { errors: '.level == "error"' },
        },
      },
      sinks: { out: { type: "console", inputs: ["branch.errors"] } },
    };
    expect(validateGraph(config)).toEqual([]);
    expect(toGraph(config).edges.find((e) => e.target === "out")).toMatchObject(
      { source: "branch", sourceHandle: "errors" },
    );
    config.sinks.out.inputs = ["branch"];
    expect(validateGraph(config).join(" ")).toContain("named route output");
  });
  it("rejects cycles, sink-as-source connections, missing inputs and duplicate IDs", () => {
    const c = structuredClone(starter);
    c.transforms.more = {
      type: "filter",
      inputs: ["enrich"],
      condition: "true",
    };
    expect(() => connect(c, "more", "enrich")).toThrow("Cycle");
    expect(() => connect(c, "output", "enrich")).toThrow();
    c.sinks.enrich = { type: "console", inputs: ["absent"] };
    expect(validateGraph(c).join(" ")).toContain("Duplicate component ID");
    expect(validateGraph(c).join(" ")).toContain("missing input");
  });
  it("keeps same edge unique", () => {
    expect(connect(starter, "demo", "enrich").transforms.enrich.inputs).toEqual(
      ["demo"],
    );
  });
  it("matches pinned conditional route and Datadog named outputs", () => {
    expect(
      outputPorts({
        type: "route",
        route: { yes: "true" },
        reroute_unmatched: false,
      }),
    ).toEqual(["yes"]);
    expect(
      outputPorts({
        type: "exclusive_route",
        routes: [{ name: "critical", condition: "true" }],
      }),
    ).toEqual(["critical", "_unmatched"]);
    expect(
      outputPorts({
        type: "datadog_agent",
        multiple_outputs: true,
        disable_metrics: true,
      }),
    ).toEqual(["logs", "traces", "llmobs"]);
    expect(outputPorts({ type: "datadog_agent" })).toEqual(["output"]);
  });
  it("defers opaque component named outputs to Vector while rejecting invalid known ports", () => {
    const config = {
      sources: { custom: { type: "custom_build_source" } },
      sinks: { out: { type: "console", inputs: ["custom.named_output"] } },
    };
    expect(validateGraph(config)).toEqual([]);
    config.sources.custom.type = "file";
    expect(validateGraph(config)).toContain(
      "out: unknown output custom.named_output",
    );
  });
  it("preserves native input patterns without inventing graph nodes or rejecting unresolved matches", () => {
    const config = {
      sources: { app_a: { type: "demo_logs" }, app_b: { type: "demo_logs" } },
      sinks: { out: { type: "console", inputs: ["app_*"] } },
    };
    expect(validateGraph(config)).toEqual([]);
    expect(toGraph(config).nodes).toHaveLength(3);
    expect(toGraph(config).edges).toEqual([]);
    expect(config.sinks.out.inputs).toEqual(["app_*"]);
    config.sinks.out.inputs = ["${UPSTREAM}"];
    expect(validateGraph(config)).toEqual([]);
    expect(toGraph(config).edges).toEqual([]);
  });
  it("accepts native component IDs with spaces but rejects ambiguous dotted IDs", () => {
    expect(
      validateGraph({
        sources: { "input one": { type: "demo_logs" } },
        sinks: { out: { type: "console", inputs: ["input one"] } },
      }),
    ).toEqual([]);
    expect(
      validateGraph({ sources: { "input.one": { type: "demo_logs" } } }),
    ).toContain("Invalid component ID: input.one");
  });
});

describe("guided pipeline editing", () => {
  it("matches the published version despite server object-key normalization", () => {
    expect(
      sameConfiguration(
        { sources: { demo: { type: "demo_logs", interval: 1 } } },
        { sources: { demo: { interval: 1, type: "demo_logs" } } },
      ),
    ).toBe(true);
    expect(
      sameConfiguration(
        { sinks: { out: { inputs: ["a", "b"] } } },
        { sinks: { out: { inputs: ["b", "a"] } } },
      ),
    ).toBe(false);
  });
  const item = (type: string) =>
    catalog.find((component) => component.type === type)!;
  it("builds source to destination without drawing an edge", () => {
    const source = addConnectedComponent({}, item("demo_logs"));
    const destination = addConnectedComponent(
      source.config,
      item("console"),
      suggestedInput(source.config),
    );
    expect(source.id).toBe("demo");
    expect(destination.id).toBe("console_out");
    expect(destination.config.sinks.console_out.inputs).toEqual([source.id]);
    expect(pipelineIssues(destination.config)).toEqual([]);
  });
  it("inserts a transformation, orders it before its consumer, and bridges removal", () => {
    const initial = structuredClone(starter);
    initial.transforms.enrich.future_field = { keep: true };
    const inserted = addConnectedComponent(initial, item("filter"), "demo");
    expect(inserted.config.transforms.keep.inputs).toEqual(["demo"]);
    expect(inserted.config.transforms.enrich.inputs).toEqual(["keep"]);
    expect(orderedStepIds(inserted.config, "transforms")).toEqual([
      "keep",
      "enrich",
    ]);
    expect(inserted.config.transforms.enrich.future_field).toEqual({
      keep: true,
    });
    expect(initial.transforms.enrich.inputs).toEqual(["demo"]);
    expect(removePipelineStep(inserted.config, "keep")).toEqual(initial);
  });
  it("inserts into only the selected named branch and asks when outputs are ambiguous", () => {
    const config = {
      sources: { events: { type: "demo_logs" } },
      transforms: {
        branch: {
          type: "route",
          inputs: ["events"],
          route: { errors: '.level == "error"', other: '.level != "error"' },
        },
      },
      sinks: {
        errors: { type: "console", inputs: ["branch.errors"] },
        other: { type: "console", inputs: ["branch.other"] },
      },
    };
    expect(suggestedInput(config)).toBe("");
    const inserted = addConnectedComponent(
      config,
      item("remap"),
      "branch.errors",
    );
    expect(inserted.config.transforms.parse.inputs).toEqual(["branch.errors"]);
    expect(inserted.config.sinks.errors.inputs).toEqual(["parse"]);
    expect(inserted.config.sinks.other.inputs).toEqual(["branch.other"]);
    expect(validateGraph(inserted.config)).toEqual([]);
    const removedBranch = removePipelineStep(config, "branch");
    expect(removedBranch.sinks.errors.inputs).toEqual([]);
    expect(removedBranch.sinks.other.inputs).toEqual([]);
  });
  it("generates unique IDs and joins a new source to the existing unambiguous flow", () => {
    const added = addConnectedComponent(starter, item("demo_logs"));
    const again = addConnectedComponent(added.config, item("demo_logs"));
    expect(added.id).toBe("demo_2");
    expect(again.id).toBe("demo_3");
    expect(again.config.transforms.enrich.inputs).toEqual([
      "demo",
      "demo_2",
      "demo_3",
    ]);
    expect(validateGraph(again.config)).toEqual([]);
  });
  it("expands a newly inserted route into valid named connections", () => {
    const added = addConnectedComponent(starter, item("route"), "enrich");
    expect(added.config.sinks.output.inputs).toEqual([
      "by_condition.errors",
      "by_condition.other",
      "by_condition._unmatched",
    ]);
    expect(validateGraph(added.config)).toEqual([]);
  });
  it("keeps shared downstream paths intact until the user chooses which one to insert into", () => {
    const config = structuredClone(starter);
    config.sinks.other = { type: "console", inputs: ["enrich"] };
    const unselected = addConnectedComponent(config, item("filter"), "enrich");
    expect(unselected.config.sinks.output.inputs).toEqual(["enrich"]);
    expect(unselected.config.sinks.other.inputs).toEqual(["enrich"]);
    const selected = addConnectedComponent(config, item("filter"), "enrich", [
      "other",
    ]);
    expect(selected.config.sinks.output.inputs).toEqual(["enrich"]);
    expect(selected.config.sinks.other.inputs).toEqual(["keep"]);
    expect(validateGraph(selected.config)).toEqual([]);
  });
  it("does not silently fan an additional source into multiple independent roots", () => {
    const config = {
      sources: { source: { type: "demo_logs" } },
      sinks: {
        first: { type: "console", inputs: ["source"] },
        second: { type: "console", inputs: ["source"] },
      },
    };
    const added = addConnectedComponent(config, item("demo_logs"));
    expect(added.config.sinks.first.inputs).toEqual(["source"]);
    expect(added.config.sinks.second.inputs).toEqual(["source"]);
    expect(Object.keys(added.config.sources)).toHaveLength(2);
  });
  it("rejects incompatible insertion without changing the original", () => {
    const config = {
      sources: { otel: { type: "opentelemetry" } },
      sinks: { out: { type: "console", inputs: ["otel.metrics"] } },
    };
    const before = structuredClone(config);
    expect(() =>
      addConnectedComponent(config, item("sample"), "otel.metrics"),
    ).toThrow("incompatible event types");
    expect(config).toEqual(before);
  });
  it("explains required settings and accepts only named local secret references", () => {
    const config = addConnectedComponent(
      starter,
      item("http"),
      "enrich",
    ).config;
    delete config.sinks.http_out.uri;
    expect(pipelineIssues(config)).toContainEqual({
      id: "http_out",
      message: "http_out: Enter uri.",
    });
    config.sinks.http_out.uri = "https://logs.example.test";
    config.sinks.http_out.auth = {
      strategy: "bearer",
      token: "plaintext-not-a-reference",
    };
    expect(
      pipelineIssues(config).some((issue) =>
        issue.message.includes("secret reference"),
      ),
    ).toBe(true);
    config.sinks.http_out.auth.token = "vectory-secret:INGEST_TOKEN";
    expect(pipelineIssues(config)).toEqual([]);
    for (const reference of [
      "SECRET[host.token]",
      "${INGEST_TOKEN}",
      "$INGEST_TOKEN",
    ]) {
      config.sinks.http_out.auth.token = reference;
      expect(pipelineIssues(config)).toEqual([]);
      expect(config.sinks.http_out.auth.token).toBe(reference);
    }
    config.sinks.http_out.auth.token = "vectory-secret:wrong name";
    expect(
      pipelineIssues(config).some((issue) =>
        issue.message.includes("secret reference"),
      ),
    ).toBe(true);
  });
});

describe("pinned schema-backed component catalog", () => {
  it("reports a missing disk-buffer size and clears the same node after a valid repair", () => {
    const config = structuredClone(starter);
    config.sinks = {
      discard_copy: {
        type: "blackhole",
        inputs: ["enrich"],
        buffer: { type: "disk" },
      },
    };
    const before = structuredClone(config);
    expect(pipelineIssues(config)).toEqual([
      { id: "discard_copy", message: "discard_copy: Enter buffer.max_size." },
    ]);
    expect(config).toEqual(before);
    config.sinks.discard_copy.buffer.max_size = 268435488;
    expect(pipelineIssues(config)).toEqual([]);
  });

  it("locates the missing disk size within a chained buffer and preserves native memory defaults", () => {
    const config = structuredClone(starter);
    config.sinks = {
      discard_copy: {
        type: "blackhole",
        inputs: ["enrich"],
        buffer: [{ type: "memory", when_full: "overflow" }, { type: "disk" }],
      },
    };
    expect(pipelineIssues(config)).toEqual([
      {
        id: "discard_copy",
        message: "discard_copy: Enter buffer[1].max_size.",
      },
    ]);
    config.sinks.discard_copy.buffer[1].max_size = 268435488;
    expect(pipelineIssues(config)).toEqual([]);
    // Vector 0.58 supplies the ordinary memory event limit when it is omitted.
    config.sinks.discard_copy.buffer = { type: "memory" };
    expect(pipelineIssues(config)).toEqual([]);
    delete config.sinks.discard_copy.buffer;
    expect(pipelineIssues(config)).toEqual([]);
  });

  it("accepts native remap file alternatives without requiring an inline source", () => {
    for (const program of [
      { file: "normalize.vrl" },
      { files: ["normalize.vrl", "enrich.vrl"] },
    ]) {
      const config = structuredClone(starter);
      config.transforms.enrich = {
        type: "remap",
        inputs: ["demo"],
        ...program,
      };
      expect(pipelineIssues(config)).toEqual([]);
    }
  });

  it("requires fields for the selected Syslog transport rather than the curated TCP form", () => {
    const config = {
      sources: {
        input: { type: "syslog", mode: "unix", path: "/run/vector.sock" },
      },
      sinks: { out: { type: "blackhole", inputs: ["input"] } },
    };
    expect(pipelineIssues(config)).toEqual([]);
    const missingPath = structuredClone(config) as any;
    delete missingPath.sources.input.path;
    expect(pipelineIssues(missingPath)).toContainEqual({
      id: "input",
      message: "input: Enter path.",
    });
    expect(
      pipelineIssues(missingPath).some(({ message }) =>
        message.includes("address"),
      ),
    ).toBe(false);
    const tcp = structuredClone(config) as any;
    tcp.sources.input = { type: "syslog", mode: "tcp" };
    expect(pipelineIssues(tcp)).toContainEqual({
      id: "input",
      message: "input: Enter address.",
    });
  });

  it("preserves optional OpenTelemetry listener defaults but requires native addresses", () => {
    const config = {
      sources: { otel: { type: "opentelemetry" } },
      sinks: { out: { type: "blackhole", inputs: ["otel.logs"] } },
    };
    expect(pipelineIssues(config)).toEqual([
      { id: "otel", message: "otel: Enter grpc." },
      { id: "otel", message: "otel: Enter http." },
    ]);
    expect(
      pipelineIssues({
        ...config,
        sources: { otel: { type: "opentelemetry", grpc: {}, http: {} } },
      }),
    ).toEqual([
      { id: "otel", message: "otel: Enter grpc.address." },
      { id: "otel", message: "otel: Enter http.address." },
    ]);
    expect(
      pipelineIssues({
        ...config,
        sources: {
          otel: {
            type: "opentelemetry",
            grpc: { address: "127.0.0.1:4317" },
            http: { address: "127.0.0.1:4318" },
          },
        },
      }),
    ).toEqual([]);
    const demo = structuredClone(starter);
    demo.sources.demo.interval = 0;
    expect(
      pipelineIssues(demo).some(({ message }) =>
        message.includes("greater than zero"),
      ),
    ).toBe(false);
  });

  it("checks nested schema requirements for curated encodings too", () => {
    const config = structuredClone(starter);
    config.sinks.output.encoding = { codec: "avro" };
    expect(pipelineIssues(config)).toContainEqual({
      id: "output",
      message: "output: Enter encoding.avro.",
    });
  });
  it("includes all generated production types and keeps kind/type identities unique", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(125);
    expect(
      new Set(catalog.map((item) => `${item.kind}/${item.type}`)).size,
    ).toBe(catalog.length);
    for (const item of catalog) {
      expect(item.schema_ref).toBeTruthy();
      const schema = resolveSchema(componentSchema(item)!, vectorSchema, {});
      expect(schema.properties?.type?.const).toBe(item.type);
    }
  });
  it("exposes Kafka's required fields without inventing broker endpoints or topics", () => {
    const kafka = catalog.find(
      (item) => item.kind === "sources" && item.type === "kafka",
    )!;
    const schema = resolveSchema(componentSchema(kafka)!, vectorSchema, {});
    expect(schema.required).toEqual(
      expect.arrayContaining(["bootstrap_servers", "group_id", "topics"]),
    );
    expect(kafka.defaults).toEqual({});
    expect(
      requiredSchemaIssues(componentSchema(kafka)!, vectorSchema, {
        type: "kafka",
      }),
    ).toEqual(
      expect.arrayContaining([
        "Enter bootstrap_servers.",
        "Enter group_id.",
        "Enter topics.",
      ]),
    );
  });
  it("uses nested encoder selection before showing variant-specific required fields", () => {
    const s3 = catalog.find(
      (item) => item.kind === "sinks" && item.type === "aws_s3",
    )!;
    const schema = resolveSchema(componentSchema(s3)!, vectorSchema, {}),
      encoding = schema.properties.encoding;
    const initial = resolveSchema(encoding, vectorSchema, {});
    expect(initial.required).toContain("codec");
    expect(initial.required).not.toContain("avro");
    expect(initial.properties.codec.enum).toContain("json");
    const next = setSchemaProperty(
      { codec: "avro", avro: { schema: "old" }, opaque_future_setting: true },
      encoding,
      vectorSchema,
      "codec",
      "json",
    );
    expect(next).toEqual({ codec: "json", opaque_future_setting: true });
    expect(
      requiredSchemaIssues(encoding, vectorSchema, { codec: "json" }),
    ).toEqual([]);
  });
  it("keeps custom imported fields and explicit inputs when adding a component definition", () => {
    const item = {
      type: "custom_extension",
      label: "Custom",
      kind: "sinks" as const,
      description: "Custom build",
      fields: [],
      defaults: { inputs: ["demo"], opaque: { nested: [1, 2, 3] } },
    };
    const added = addConnectedComponent(starter, item);
    expect(added.config.sinks.custom_extension).toEqual({
      type: "custom_extension",
      inputs: ["demo"],
      opaque: { nested: [1, 2, 3] },
    });
  });
  it("preserves a chained sink buffer array instead of selecting the object alternative", () => {
    const sink = catalog.find(
      (item) => item.kind === "sinks" && item.type === "aws_s3",
    )!;
    const rootSchema = resolveSchema(componentSchema(sink)!, vectorSchema, {});
    const value = [
      { type: "memory", max_events: 500 },
      { type: "disk", max_size: 268435488 },
    ];
    const buffer = resolveSchema(
      rootSchema.properties.buffer,
      vectorSchema,
      value,
    );
    expect(buffer.type).toBe("array");
    expect(value).toEqual([
      { type: "memory", max_events: 500 },
      { type: "disk", max_size: 268435488 },
    ]);
  });
  it("shows conditionally required Unix supplement fields", () => {
    const source = catalog.find(
      (item) => item.kind === "sources" && item.type === "dnstap",
    )!;
    const schema = componentSchema(source)!;
    expect(
      requiredSchemaIssues(schema, vectorSchema, {
        type: "dnstap",
        mode: "tcp",
      }),
    ).toContain("Enter address.");
    expect(
      requiredSchemaIssues(schema, vectorSchema, {
        type: "dnstap",
        mode: "unix",
      }),
    ).toContain("Enter socket_path.");
    expect(
      requiredSchemaIssues(schema, vectorSchema, {
        type: "dnstap",
        mode: "tcp",
        address: "127.0.0.1:9000",
      }),
    ).toEqual([]);
  });
  it("allows provider-owned topology and leaves its validation to Vector", () => {
    expect(
      pipelineIssues({
        provider: { type: "http", url: "http://127.0.0.1:9000/config" },
      }),
    ).toEqual([]);
  });
});

describe("one name per component", () => {
  it("is the same on the node card, picker, inspector and review", () => {
    for (const [kind, type, label] of [
      ["transforms", "remap", "Remap"],
      ["transforms", "route", "Route"],
      ["sinks", "aws_s3", "Amazon S3"],
      ["sinks", "console", "Console"],
      ["sources", "demo_logs", "Demo logs"],
      ["sinks", "blackhole", "Discard events"],
      ["sources", "file", "Log files"],
      ["sinks", "file", "File output"],
    ] as const) {
      const entry = catalog.find((c) => c.kind === kind && c.type === type);
      expect(entry?.label).toBe(label);
      expect(componentTitle(type, kind)).toBe(label);
      expect(displayLabel(type, kind)).toBe(label);
    }
  });
  it("names new steps by role, never reusing an ID", () => {
    expect(defaultComponentId("transforms", "remap", new Set())).toBe("parse");
    expect(
      defaultComponentId("transforms", "remap", new Set(["parse", "parse_2"])),
    ).toBe("parse_3");
    expect(defaultComponentId("sinks", "aws_s3", new Set())).toBe("archive");
    expect(defaultComponentId("transforms", "dedupe", new Set())).toBe(
      "dedupe",
    );
  });
  it("starts a remap with comments only", () => {
    expect(
      REMAP_STARTER.split("\n").filter(
        (line) => line.trim() && !line.startsWith("#"),
      ),
    ).toEqual([]);
  });
});

describe("component descriptions", () => {
  it("never show a gap or repeat the name", () => {
    for (const item of catalog) {
      expect(item.description).not.toMatch(/missing a description/i);
      expect(item.description.trim().length).toBeGreaterThan(item.label.length);
    }
    expect(
      catalog.find((item) => item.kind === "sinks" && item.type === "mqtt")
        ?.description,
    ).toBe("Send events to Mqtt.");
  });
});
