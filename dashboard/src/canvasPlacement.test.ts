import { describe, expect, it } from "vitest";
import { besidePosition, freePosition, primaryOutput } from "./pipelineEditing";
import { catalog, inputMismatch } from "./catalog";
import {
  pipelineNodeHeight,
  PIPELINE_NODE_COLUMN_GAP,
} from "./pipelineNodeModel";

const node = (
  id: string,
  x: number,
  y: number,
  component: Record<string, unknown> = { type: "remap" },
  kind: "sources" | "transforms" | "sinks" = "transforms",
) => ({ id, position: { x, y }, data: { kind, component } });

describe("placing new steps", () => {
  it("never stacks a new card on an existing one", () => {
    const nodes = [node("parse", 400, 100), node("route", 400, 340)];
    const spot = freePosition(nodes, { x: 420, y: 120 });
    expect(spot.x).toBe(420);
    for (const other of nodes)
      expect(
        spot.y >= other.position.y + pipelineNodeHeight(other.data) ||
          spot.y + pipelineNodeHeight({}) <= other.position.y,
      ).toBe(true);
    expect(freePosition(nodes, { x: 1200, y: 100 })).toEqual({
      x: 1200,
      y: 100,
    });
  });

  it("goes beside the selection, fed by its main output", () => {
    const parse = node("parse", 100, 100);
    const route = node(
      "by_status",
      500,
      100,
      { type: "route", route: { errors: "true", ok: "true" } },
      "transforms",
    );
    const sink = node("out", 900, 100, { type: "console" }, "sinks");
    expect(primaryOutput(parse)).toBe("parse");
    expect(primaryOutput(route)).toBe("by_status.errors");
    expect(primaryOutput(sink)).toBe("");
    expect(besidePosition([parse, route, sink], parse)).toEqual({
      x: 100 + PIPELINE_NODE_COLUMN_GAP,
      y: 100 + pipelineNodeHeight(route.data) + 40,
    });
  });
});

describe("typed picker", () => {
  const item = (type: string) =>
    catalog.find((entry) => entry.type === type && entry.kind !== "sources")!;
  const config = {
    sources: {
      nginx: { type: "file", include: ["/var/log/nginx/access.log"] },
      host: { type: "host_metrics" },
    },
    transforms: {
      parse: { type: "remap", inputs: ["nginx"], source: "." },
    },
  };
  it("explains why a step can't read an output", () => {
    expect(inputMismatch(config, "parse", item("statsd"))).toBe(
      "Accepts metrics; parse sends logs.",
    );
    expect(inputMismatch(config, "nginx", item("aggregate"))).toBe(
      "Accepts metrics; nginx sends logs.",
    );
    expect(inputMismatch(config, "host", item("loki"))).toBe(
      "Accepts logs; host sends metrics.",
    );
    expect(inputMismatch(config, "parse", item("loki"))).toBeNull();
    expect(inputMismatch(config, "parse", item("http"))).toBeNull();
    expect(inputMismatch(config, "", item("statsd"))).toBeNull();
  });
});
