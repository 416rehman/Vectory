import { describe, expect, it } from "vitest";
import { downstreamFlowPath } from "./pipelineFlowPath";
import { patternEdges, patternInputs } from "./inputPatterns";

describe("downstream flow paths", () => {
  it("follows every downstream branch without tracing backwards through a merge", () => {
    const nodes = [
      "a",
      "b",
      "merge",
      "route",
      "out",
      "archive",
      "unrelated",
    ].map((id) => ({ id }));
    const edges = [
      { id: "a-merge", source: "a", target: "merge" },
      { id: "b-merge", source: "b", target: "merge" },
      { id: "merge-route", source: "merge", target: "route" },
      {
        id: "route-accepted",
        source: "route",
        sourceHandle: "accepted",
        target: "out",
      },
      {
        id: "route-rejected",
        source: "route",
        sourceHandle: "rejected",
        target: "archive",
      },
      { id: "b-unrelated", source: "b", target: "unrelated" },
    ];
    const before = structuredClone({ nodes, edges });
    const path = downstreamFlowPath("a", nodes, edges);
    expect([...path.nodes]).toEqual(["a", "merge", "route", "out", "archive"]);
    expect([...path.edges]).toEqual([
      "a-merge",
      "merge-route",
      "route-accepted",
      "route-rejected",
    ]);
    expect({ nodes, edges }).toEqual(before);
  });

  it("terminates for cycles and includes parallel connections without inventing missing endpoints", () => {
    const nodes = ["source", "one", "two", "out"].map((id) => ({ id }));
    const edges = [
      { id: "first", source: "source", target: "one" },
      { id: "next", source: "one", target: "two" },
      { id: "cycle", source: "two", target: "one" },
      { id: "parallel-a", source: "two", target: "out" },
      { id: "parallel-b", source: "two", target: "out" },
      { id: "missing", source: "source", target: "missing" },
      { id: "unknown", source: "${INPUT}", target: "out" },
    ];
    const path = downstreamFlowPath("source", nodes, edges);
    expect([...path.nodes]).toEqual(["source", "one", "two", "out"]);
    expect([...path.edges]).toEqual([
      "first",
      "next",
      "cycle",
      "parallel-a",
      "parallel-b",
    ]);
    expect(downstreamFlowPath("missing", nodes, edges).nodes.size).toBe(0);
    expect([...downstreamFlowPath("out", nodes, edges).nodes]).toEqual(["out"]);
  });

  it("traces wildcard matches beyond the rendering cap and keeps other sources separate", () => {
    const sources = Object.fromEntries(
      Array.from({ length: 30 }, (_, at) => [
        `logs_${at}`,
        { type: "demo_logs" },
      ]),
    );
    const config = {
      sources,
      transforms: { merged: { type: "sample", inputs: ["logs_*"], rate: 10 } },
      sinks: { out: { type: "blackhole", inputs: ["merged"] } },
    };
    const patterns = patternInputs(config);
    expect(
      patternEdges(patterns).some((edge) => edge.source === "logs_29"),
    ).toBe(false);
    const nodes = [...Object.keys(sources), "merged", "out"].map((id) => ({
      id,
    }));
    const path = downstreamFlowPath(
      "logs_29",
      nodes,
      [{ id: "to-out", source: "merged", target: "out" }],
      patterns,
    );
    expect([...path.nodes]).toEqual(["logs_29", "merged", "out"]);
    expect([...path.edges]).toEqual(["to-out"]);
  });

  it("does not join independent memory table exports or unresolved input variables", () => {
    const nodes = ["source", "table", "export", "out", "dynamic"].map((id) => ({
      id,
    }));
    const edges = [
      { id: "to-table", source: "source", target: "table" },
      { id: "from-export", source: "export", target: "out" },
    ];
    const path = downstreamFlowPath("source", nodes, edges, [
      { target: "dynamic", pattern: "unknown_*", matches: [] },
    ]);
    expect([...path.nodes]).toEqual(["source", "table"]);
    expect([...path.edges]).toEqual(["to-table"]);
  });
});
