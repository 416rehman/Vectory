import { describe, expect, it } from "vitest";
import {
  connect,
  toGraph,
  pipelineOutputs,
  validateGraph,
  removePipelineStep,
} from "./catalog";

const pipeline = () => ({
  sources: { seed: { type: "demo_logs", format: "json" } },
  enrichment_tables: {
    lookup: {
      type: "memory",
      inputs: ["seed"],
      source_config: {
        source_key: "cache_events",
        export_interval: 1,
        export_expired_items: false,
      },
    },
  },
  sinks: { out: { type: "blackhole", inputs: ["cache_events"] } },
});
describe("native memory enrichment table topology", () => {
  it("draws both implicit roles without adding synthetic config components", () => {
    const config = pipeline(),
      before = structuredClone(config),
      graph = toGraph(config);
    expect(validateGraph(config)).toEqual([]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "seed",
      "out",
      "lookup",
      "cache_events",
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["cache_events", "out"],
      ["seed", "lookup"],
    ]);
    expect(pipelineOutputs(config).map((output) => output.reference)).toEqual([
      "seed",
      "cache_events",
    ]);
    expect(config).toEqual(before);
  });
  it("gates expired outputs, supports dragging to table inputs, and rejects collisions", () => {
    const config = pipeline();
    config.sinks.out.inputs = ["cache_events.expired"];
    expect(validateGraph(config)).toContain(
      "out: unknown output cache_events.expired",
    );
    config.enrichment_tables.lookup.source_config.export_expired_items = true;
    expect(validateGraph(config)).toEqual([]);
    expect(pipelineOutputs(config).map((output) => output.reference)).toContain(
      "cache_events.expired",
    );
    config.enrichment_tables.lookup.inputs = [];
    expect(
      connect(config, "seed", "lookup").enrichment_tables.lookup.inputs,
    ).toEqual(["seed"]);
    expect(() => connect(config, "lookup", "out")).toThrow();
    config.enrichment_tables.lookup.source_config.source_key = "seed";
    expect(validateGraph(config)).toContain("Duplicate component ID: seed");
  });
  it("removes the table and export references together without mutating the draft", () => {
    const config = pipeline(),
      next = removePipelineStep(config, "cache_events");
    expect(next.enrichment_tables).toEqual({});
    expect(next.sinks.out.inputs).toEqual([]);
    expect(config.enrichment_tables.lookup).toBeTruthy();
    expect(
      removePipelineStep(config, "seed").enrichment_tables.lookup.inputs,
    ).toEqual([]);
  });
});
