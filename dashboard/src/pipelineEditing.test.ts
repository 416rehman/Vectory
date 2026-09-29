import { describe, expect, it } from "vitest";
import {
  arrangeGraph,
  renameComponent,
  retargetReferences,
  componentName,
  reconnect,
  disconnect,
  canConnect,
  connectConnection,
} from "./pipelineEditing";
import { connectionEdgeId, starter, toGraph, validateGraph } from "./catalog";
import type { Config } from "./api";
import { pipelineNodeHeight, PIPELINE_NODE_WIDTH } from "./pipelineNodeModel";

describe("pipeline editing without changing runtime meaning", () => {
  it("rejects memory source collisions and retargets exact route test outputs", () => {
    const config: Config = {
      ...structuredClone(starter),
      enrichment_tables: {
        lookup: {
          type: "memory",
          inputs: ["demo"],
          source_config: { source_key: "cache_events" },
        },
      },
      tests: [
        {
          outputs: [{ extract_from: "routes.accept" }],
          no_outputs_from: ["routes.accept", "routes.other"],
        },
      ],
    };
    expect(() =>
      componentName(config, "demo", "cache_events", ["lookup"]),
    ).toThrow("already exists");
    expect(() =>
      componentName(config, "lookup", "cache_events", ["lookup"]),
    ).toThrow("already exists");
    const renamed = retargetReferences(
      config,
      "routes.accept",
      "routes.success",
    );
    expect(renamed.tests[0].outputs[0].extract_from).toBe("routes.success");
    expect(renamed.tests[0].no_outputs_from).toEqual([
      "routes.success",
      "routes.other",
    ]);
    expect(config.enrichment_tables.lookup.inputs).toEqual(["demo"]);
  });
  it("renames named connections and test targets while leaving expressions and unknown data intact", () => {
    const config: Config = {
      sources: { seed: { type: "demo_logs" } },
      transforms: {
        branch: {
          type: "route",
          inputs: ["seed"],
          route: { accepted: '.name == "branch"' },
          custom: { retain: true },
        },
      },
      sinks: {
        out: {
          type: "blackhole",
          inputs: ["branch.accepted", "branch*", "${OUTPUT}"],
        },
      },
      enrichment_tables: {
        cache: { type: "memory", inputs: ["branch.accepted"] },
      },
      tests: [
        {
          inputs: [
            {
              insert_at: "branch",
              type: "log",
              log_fields: { name: "branch" },
            },
          ],
          outputs: [{ extract_from: "branch.accepted" }],
          no_outputs_from: ["branch._unmatched"],
        },
      ],
    };
    const before = structuredClone(config),
      next = renameComponent(config, "branch", "request_routes");
    expect(next.transforms.request_routes).toEqual(config.transforms.branch);
    expect(next.sinks.out.inputs).toEqual([
      "request_routes.accepted",
      "branch*",
      "${OUTPUT}",
    ]);
    expect(next.enrichment_tables.cache.inputs).toEqual([
      "request_routes.accepted",
    ]);
    expect(next.tests[0].inputs[0]).toEqual({
      insert_at: "request_routes",
      type: "log",
      log_fields: { name: "branch" },
    });
    expect(next.tests[0].outputs[0].extract_from).toBe(
      "request_routes.accepted",
    );
    expect(next.tests[0].no_outputs_from).toEqual([
      "request_routes._unmatched",
    ]);
    expect(config).toEqual(before);
  });

  it("rejects ambiguous names and safely supports ordinary object-key names", () => {
    for (const name of ["", "  ", "output", "bad.port", "a".repeat(129)])
      expect(() => renameComponent(starter, "demo", name)).toThrow();
    const next = renameComponent(starter, "demo", "__proto__");
    expect(Object.hasOwn(next.sources, "__proto__")).toBe(true);
    expect(next.transforms.enrich.inputs).toEqual(["__proto__"]);
    expect(validateGraph(next)).toEqual([]);
  });

  it("aligns destinations, separates tall named-output nodes, and has deterministic positions", () => {
    const config: Config = structuredClone(starter);
    config.sinks.short = { type: "blackhole", inputs: ["demo"] };
    config.transforms.route = {
      type: "route",
      inputs: ["enrich"],
      route: { a: "true", b: "true", c: "true" },
    };
    config.transforms.parallel = {
      type: "remap",
      inputs: ["enrich"],
      source: ".retained = true",
    };
    config.sinks.output.inputs = ["route.a"];
    const graph = toGraph(config),
      before = structuredClone(graph),
      arranged = arrangeGraph(graph);
    expect(arrangeGraph(graph)).toEqual(arranged);
    expect(arranged.nodes.find((n) => n.id === "short")!.position.x).toBe(
      arranged.nodes.find((n) => n.id === "output")!.position.x,
    );
    expect(graph).toEqual(before);
    for (const node of arranged.nodes)
      for (const other of arranged.nodes)
        if (node.position.x < other.position.x)
          expect(
            other.position.x - (node.position.x + PIPELINE_NODE_WIDTH),
          ).toBeGreaterThanOrEqual(100);
        else if (
          node.position.x === other.position.x &&
          node.position.y < other.position.y
        )
          expect(
            other.position.y -
              (node.position.y + pipelineNodeHeight(node.data)),
          ).toBeGreaterThanOrEqual(66);
  });
});

describe("atomic connection editing", () => {
  const fixture = (): Config => ({
    sources: {
      seed: { type: "demo_logs" },
      other: { type: "demo_logs" },
      otel: { type: "opentelemetry" },
    },
    transforms: {
      routes: {
        type: "route",
        inputs: ["seed"],
        route: { accepted: "true", output: "false" },
      },
      enrich: { type: "remap", inputs: ["seed"], source: ".retained = true" },
    },
    sinks: {
      out: {
        type: "blackhole",
        inputs: ["other", "routes.accepted", "future*", "${DYNAMIC}"],
      },
      alternate: { type: "blackhole", inputs: ["other"] },
    },
    extension: { unchanged: [null, false, ""] },
  });
  const edge = (config: Config, reference: string, target: string) => {
    const dot = reference.indexOf(".");
    const found = toGraph(config).edges.find(
      (candidate) =>
        candidate.target === target &&
        candidate.source === (dot < 0 ? reference : reference.slice(0, dot)) &&
        candidate.sourceHandle ===
          (dot < 0 ? "output" : reference.slice(dot + 1)),
    );
    if (!found) throw Error("Test edge missing");
    return found;
  };

  it("keeps hyphenated endpoint tuples distinct when selecting, reconnecting, and deleting edges", () => {
    const config: Config = {
      sources: {
        "a-b": { type: "demo_logs" },
        a: { type: "demo_logs" },
        replacement: { type: "demo_logs" },
      },
      transforms: {},
      sinks: {
        c: { type: "blackhole", inputs: ["a-b"] },
        "b-c": { type: "blackhole", inputs: ["a", "future*"] },
      },
    };
    const before = structuredClone(config);
    const graph = toGraph(config);
    expect(new Set(graph.edges.map((item) => item.id)).size).toBe(2);
    const selectedId = edge(config, "a", "b-c").id;
    const selected = graph.edges.find((item) => item.id === selectedId)!;
    const reconnected = reconnect(config, selected, {
      source: "replacement",
      target: "b-c",
    });
    expect(reconnected.sinks.c.inputs).toEqual(["a-b"]);
    expect(reconnected.sinks["b-c"].inputs).toEqual(["replacement", "future*"]);
    const disconnected = disconnect(config, selected);
    expect(disconnected.sinks.c.inputs).toEqual(["a-b"]);
    expect(disconnected.sinks["b-c"].inputs).toEqual(["future*"]);
    const legacyGraph = {
      ...graph,
      edges: graph.edges.map((item) => ({ ...item, id: "a-b-c-0" })),
    };
    expect(toGraph(config, legacyGraph).edges).toEqual(graph.edges);
    expect(config).toEqual(before);
  });

  it("replaces a named output in place without reordering or changing other inputs", () => {
    const config = fixture(),
      before = structuredClone(config);
    const next = reconnect(config, edge(config, "routes.accepted", "out"), {
      source: "otel",
      sourceHandle: "logs",
      target: "out",
      targetHandle: "input",
    });
    expect(next.sinks.out.inputs).toEqual([
      "other",
      "otel.logs",
      "future*",
      "${DYNAMIC}",
    ]);
    expect(next.extension).toEqual(before.extension);
    expect(config).toEqual(before);
    expect(
      toGraph(next).edges.some(
        (item) =>
          item.source === "otel" &&
          item.sourceHandle === "logs" &&
          item.target === "out",
      ),
    ).toBe(true);
  });

  it("changes both endpoints as one operation and can leave the old target disconnected", () => {
    const config = fixture();
    const previous = edge(config, "seed", "enrich");
    const next = reconnect(config, previous, {
      source: "routes",
      sourceHandle: "accepted",
      target: "alternate",
    });
    expect(next.transforms.enrich.inputs).toEqual([]);
    expect(next.sinks.alternate.inputs).toEqual(["other", "routes.accepted"]);
    expect(config.transforms.enrich.inputs).toEqual(["seed"]);
    expect(
      canConnect(
        config,
        { source: "routes", sourceHandle: "accepted", target: "alternate" },
        previous,
      ),
    ).toBe(true);
  });

  it("addresses exactly one repeated imported edge and preserves other duplicates", () => {
    const config = fixture();
    config.sinks.out.inputs = ["seed", "seed", "other", "other", "seed*"];
    const selected = toGraph(config).edges.find(
      (item) => item.id === connectionEdgeId("seed", "out", 1),
    )!;
    const next = reconnect(config, selected, {
      source: "routes",
      sourceHandle: "accepted",
      target: "out",
    });
    expect(next.sinks.out.inputs).toEqual([
      "seed",
      "routes.accepted",
      "other",
      "other",
      "seed*",
    ]);
    expect(disconnect(config, selected).sinks.out.inputs).toEqual([
      "seed",
      "other",
      "other",
      "seed*",
    ]);
    expect(() => disconnect(config, { source: "seed", target: "out" })).toThrow(
      "exact connection",
    );
    expect(config.sinks.out.inputs).toEqual([
      "seed",
      "seed",
      "other",
      "other",
      "seed*",
    ]);
  });

  it("rejects duplicate replacement edges without dropping the original", () => {
    const config = fixture(),
      before = structuredClone(config),
      previous = edge(config, "routes.accepted", "out");
    expect(() =>
      reconnect(config, previous, { source: "other", target: "out" }),
    ).toThrow("already exists");
    expect(
      canConnect(config, { source: "other", target: "out" }, previous),
    ).toBe(false);
    expect(config).toEqual(before);
  });

  it("disconnects a multi-edge selection against one snapshot instead of stale shifted indices", () => {
    const config = fixture(),
      before = structuredClone(config);
    config.sinks.out.inputs = [
      "seed",
      "other",
      "seed",
      "routes.accepted",
      "future*",
    ];
    before.sinks.out.inputs = [...config.sinks.out.inputs];
    const selected = toGraph(config).edges.filter((item) =>
      [
        connectionEdgeId("seed", "out", 0),
        connectionEdgeId("seed", "out", 2),
        connectionEdgeId("other", "alternate", 0),
      ].includes(item.id),
    );
    const next = disconnect(config, selected);
    expect(next.sinks.out.inputs).toEqual([
      "other",
      "routes.accepted",
      "future*",
    ]);
    expect(next.sinks.alternate.inputs).toEqual([]);
    expect(disconnect(config, [...selected, selected[0]])).toEqual(next);
    expect(() =>
      disconnect(config, [...selected, { source: "missing", target: "out" }]),
    ).toThrow("no longer exists");
    expect(config).toEqual(before);
  });

  it("rejects missing endpoints, wrong kinds, stale edge IDs, and every unknown port", () => {
    const config = fixture(),
      before = structuredClone(config),
      previous = edge(config, "routes.accepted", "out");
    config.sources.custom = { type: "custom_source" };
    before.sources.custom = { type: "custom_source" };
    for (const replacement of [
      { source: "missing", target: "out" },
      { source: "seed", target: "missing" },
      { source: "out", target: "enrich" },
      { source: "seed", target: "other" },
      { source: "enrich", target: "enrich" },
      { source: "seed", sourceHandle: "missing", target: "out" },
      { source: "custom", sourceHandle: "undocumented", target: "out" },
      { source: "routes", sourceHandle: "gone", target: "out" },
      { source: "seed", target: "out", targetHandle: "other" },
    ]) {
      expect(() => reconnect(config, previous, replacement)).toThrow();
      expect(canConnect(config, replacement, previous)).toBe(false);
      expect(config).toEqual(before);
    }
    expect(() =>
      reconnect(
        config,
        { ...previous, id: "stale" },
        { source: "seed", target: "out" },
      ),
    ).toThrow("no longer exists");
  });

  it("validates cycles after removal so replacing an edge can reverse its direction", () => {
    const config: Config = {
      sources: { seed: { type: "demo_logs" } },
      transforms: {
        a: { type: "remap", inputs: ["seed"], source: ".a = true" },
        b: { type: "remap", inputs: ["a"], source: ".b = true" },
        c: { type: "remap", inputs: ["b"], source: ".c = true" },
      },
      sinks: {},
    };
    const previous = edge(config, "a", "b");
    expect(() =>
      reconnect(config, previous, { source: "c", target: "b" }),
    ).toThrow("Cycle");
    expect(config.transforms.b.inputs).toEqual(["a"]);
    const reversed = reconnect(config, previous, { source: "b", target: "a" });
    expect(reversed.transforms.a.inputs).toEqual(["seed", "b"]);
    expect(reversed.transforms.b.inputs).toEqual([]);
    expect(
      validateGraph(reversed).filter((message) => message.startsWith("Cycle")),
    ).toEqual([]);
  });

  it("rejects both immediate and downstream event-type incompatibilities", () => {
    const config = fixture();
    config.transforms.sample = { type: "sample", rate: 10, inputs: ["enrich"] };
    const previous = edge(config, "seed", "enrich"),
      before = structuredClone(config);
    expect(() =>
      reconnect(config, previous, {
        source: "otel",
        sourceHandle: "metrics",
        target: "sample",
      }),
    ).toThrow("incompatible event types");
    expect(() =>
      reconnect(config, previous, {
        source: "otel",
        sourceHandle: "metrics",
        target: "enrich",
      }),
    ).toThrow("incompatible event types");
    expect(config).toEqual(before);
  });

  it("treats disconnected pass-through outputs as unknown while retaining known conversion types", () => {
    const config: Config = {
      sources: { metrics: { type: "internal_metrics" } },
      transforms: {
        empty: { type: "remap", inputs: [], source: ".a = true" },
        convert: { type: "log_to_metric", inputs: [], metrics: [] },
        sample: { type: "sample", inputs: [], rate: 10 },
      },
      sinks: { out: { type: "blackhole", inputs: [] } },
    };
    expect(canConnect(config, { source: "empty", target: "sample" })).toBe(
      true,
    );
    expect(
      connectConnection(config, { source: "empty", target: "sample" })
        .transforms.sample.inputs,
    ).toEqual(["empty"]);
    expect(canConnect(config, { source: "convert", target: "sample" })).toBe(
      false,
    );
    config.transforms.empty.inputs = ["metrics"];
    expect(canConnect(config, { source: "empty", target: "sample" })).toBe(
      false,
    );
  });

  it("uses memory table input arrays and independently named memory export sources", () => {
    const config = fixture();
    config.enrichment_tables = {
      cache: {
        type: "memory",
        inputs: ["seed", "future*"],
        source_config: {
          source_key: "cache_events",
          export_expired_items: true,
        },
      },
    };
    const intoTable = reconnect(
      config,
      edge(config, "routes.accepted", "out"),
      { source: "other", target: "cache" },
    );
    expect(intoTable.enrichment_tables.cache.inputs).toEqual([
      "seed",
      "future*",
      "other",
    ]);
    const fromTable = reconnect(
      config,
      edge(config, "routes.accepted", "out"),
      { source: "cache_events", sourceHandle: "expired", target: "out" },
    );
    expect(fromTable.sinks.out.inputs).toEqual([
      "other",
      "cache_events.expired",
      "future*",
      "${DYNAMIC}",
    ]);
    expect(
      disconnect(config, edge(config, "seed", "cache")).enrichment_tables.cache
        .inputs,
    ).toEqual(["future*"]);
    expect(config.enrichment_tables.cache.inputs).toEqual(["seed", "future*"]);
  });

  it("disconnects broken literal inputs while preserving patterns and dynamic references", () => {
    const config = fixture();
    config.sinks.out.inputs = ["gone.port", "gone*", "${UPSTREAM}", "other"];
    expect(
      disconnect(config, edge(config, "gone.port", "out")).sinks.out.inputs,
    ).toEqual(["gone*", "${UPSTREAM}", "other"]);
    expect(() =>
      disconnect(config, { source: "gone*", target: "out" }),
    ).toThrow("no longer exists");
  });

  it("keeps a same-edge gesture unchanged and treats a route named output as a named port", () => {
    const config = fixture(),
      previous = edge(config, "routes.accepted", "out");
    expect(
      reconnect(config, previous, {
        source: "routes",
        sourceHandle: "accepted",
        target: "out",
      }),
    ).toBe(config);
    expect(
      reconnect(config, previous, {
        source: "routes",
        sourceHandle: "output",
        target: "out",
      }).sinks.out.inputs[1],
    ).toBe("routes.output");
    const next = connectConnection(config, {
      source: "otel",
      sourceHandle: "logs",
      target: "alternate",
    });
    expect(next.sinks.alternate.inputs).toEqual(["other", "otel.logs"]);
    expect(
      canConnect(config, {
        source: "otel",
        sourceHandle: "logs",
        target: "alternate",
      }),
    ).toBe(true);
    expect(canConnect(config, { source: "otel", target: "alternate" })).toBe(
      false,
    );
  });
});
