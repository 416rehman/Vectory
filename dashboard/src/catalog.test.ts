import { describe, it, expect } from "vitest";
import {
  connect,
  starter,
  toGraph,
  validateGraph,
  outputPorts,
} from "./catalog";
describe("canonical graph round trip and connection rules", () => {
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
});
