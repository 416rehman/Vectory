import { describe, expect, it } from "vitest";
import type { Config } from "./api";
import { toGraph } from "./catalog";
import {
  arrangeGraph,
  canvasCards,
  canvasConnections,
  connectionRoutes,
} from "./canvasLayout";
import { plainPoints, routedPoints } from "./connectionRoute";

/** The demo fleet's pipelines: parse, route errors, sample the rest. */
const demo = (): Config => ({
  sources: {
    app_logs: { type: "demo_logs", format: "syslog", interval: 0.2 },
    vector_metrics: { type: "internal_metrics", scrape_interval_secs: 5 },
  },
  transforms: {
    parse: { type: "remap", inputs: ["app_logs"], source: ". = {}" },
    by_severity: {
      type: "route",
      inputs: ["parse"],
      route: { errors: '.severity == "err"' },
    },
    sample_rest: {
      type: "sample",
      inputs: ["by_severity._unmatched"],
      rate: 10,
    },
  },
  sinks: {
    errors_out: { type: "blackhole", inputs: ["by_severity.errors"] },
    archive: { type: "blackhole", inputs: ["sample_rest"] },
    metrics_exporter: {
      type: "prometheus_exporter",
      inputs: ["vector_metrics"],
      address: "127.0.0.1:9598",
    },
  },
});

/** A route with four outputs, each ending in its own destination. */
const fourOutputs = (): Config => ({
  sources: { seed: { type: "demo_logs" } },
  transforms: {
    split: {
      type: "route",
      inputs: ["seed"],
      route: { a: "true", b: "true", c: "true", d: "true" },
    },
    enrich: { type: "remap", inputs: ["split.b"], source: ".x = 1" },
  },
  sinks: {
    out_a: { type: "blackhole", inputs: ["split.a"] },
    out_b: { type: "blackhole", inputs: ["enrich"] },
    out_c: { type: "blackhole", inputs: ["split.c"] },
    out_d: { type: "blackhole", inputs: ["split.d"] },
    out_rest: { type: "blackhole", inputs: ["split._unmatched"] },
  },
});

type Arranged = ReturnType<typeof arrangeGraph>;
const cardsOf = canvasCards;
const at = (graph: Arranged, id: string) =>
  graph.nodes.find((node) => node.id === id)!.position;

/** The cards each connection draws over, however the canvas routes it. */
function crossedBy(graph: Arranged) {
  const cards = canvasCards(graph),
    links = canvasConnections(graph),
    routes = connectionRoutes(graph, "curved");
  const crossings: string[] = [];
  for (const link of links) {
    const lanes = routes.get(link.id);
    const line = lanes
      ? routedPoints("curved", link.from, link.to, lanes)
      : plainPoints("curved", link.from, link.to);
    for (const card of cards) {
      if (card.id === link.source || card.id === link.target) continue;
      // A little air: the line is 5 px thick at most and carries a label.
      const margin = 10;
      if (
        line.some(
          (point) =>
            point.x > card.x - margin &&
            point.x < card.x + card.width + margin &&
            point.y > card.y - margin &&
            point.y < card.y + card.height + margin,
        )
      )
        crossings.push(`${link.source} → ${link.target} behind ${card.id}`);
    }
  }
  return crossings;
}

describe("automatic layout", () => {
  it("keeps a connection from running behind a card in the demo pipelines", () => {
    for (const format of ["syslog", "apache_common"]) {
      const config = demo();
      config.sources.app_logs.format = format;
      const arranged = arrangeGraph(toGraph(config));
      expect(crossedBy(arranged)).toEqual([]);
    }
  });

  it("stacks the destinations in the order of the outputs that feed them", () => {
    const arranged = arrangeGraph(toGraph(demo()));
    // `errors` is the route's first output, `_unmatched` its last.
    expect(at(arranged, "errors_out").y).toBeLessThan(
      at(arranged, "archive").y,
    );
    expect(at(arranged, "errors_out").x).toBe(at(arranged, "archive").x);
  });

  it("orders four outputs top to bottom without a connection behind a card", () => {
    const arranged = arrangeGraph(toGraph(fourOutputs()));
    const order = ["out_a", "out_b", "out_c", "out_d", "out_rest"].map(
      (id) => at(arranged, id).y,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(crossedBy(arranged)).toEqual([]);
  });

  it("keeps cards apart and aligned, never mutates its input and is stable", () => {
    for (const config of [demo(), fourOutputs()]) {
      const graph = toGraph(config),
        before = structuredClone(graph),
        arranged = arrangeGraph(graph);
      expect(graph).toEqual(before);
      expect(arrangeGraph(graph)).toEqual(arranged);
      const cards = cardsOf(arranged);
      for (const card of cards)
        for (const other of cards) {
          if (card.id === other.id) continue;
          if (card.x === other.x && card.y < other.y)
            expect(other.y - (card.y + card.height)).toBeGreaterThanOrEqual(66);
          if (card.x < other.x)
            expect(other.x - (card.x + card.width)).toBeGreaterThanOrEqual(100);
        }
      expect(Math.min(...cards.map((card) => card.y))).toBe(70);
    }
  });

  it("draws a chain level", () => {
    const arranged = arrangeGraph(
      toGraph({
        sources: { a: { type: "demo_logs" } },
        transforms: { b: { type: "remap", inputs: ["a"], source: ". = {}" } },
        sinks: { c: { type: "blackhole", inputs: ["b"] } },
      }),
    );
    expect(new Set(arranged.nodes.map((node) => node.position.y)).size).toBe(1);
  });

  it("leaves unconnected cards and an empty graph alone", () => {
    expect(arrangeGraph({ nodes: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
    });
    const arranged = arrangeGraph(
      toGraph({
        sources: { a: { type: "demo_logs" }, b: { type: "demo_logs" } },
        transforms: {},
        sinks: { c: { type: "blackhole", inputs: [] } },
      }),
    );
    for (const node of arranged.nodes)
      expect(Number.isFinite(node.position.y)).toBe(true);
  });
});
