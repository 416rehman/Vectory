import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { copySteps, pasteSteps, stepsText } from "./canvasClipboard";
import { validateGraph } from "./catalog";
import { layoutBlock, placeBlock, type BlockStep } from "./pipelineEditing";
import {
  pipelineNodeHeight,
  PIPELINE_NODE_COLUMN_GAP,
  PIPELINE_NODE_WIDTH,
} from "./pipelineNodeModel";

const config = {
  sources: { nginx: { type: "file", include: ["/var/log/nginx/access.log"] } },
  transforms: {
    parse: {
      type: "remap",
      inputs: ["nginx"],
      source: '. = parse_nginx_log!(.message, "combined")',
    },
    by_status: {
      type: "route",
      inputs: ["parse"],
      route: { errors: ".status >= 500" },
    },
  },
  sinks: {
    loki_out: { type: "loki", inputs: ["by_status.errors"], endpoint: "x" },
  },
};

describe("copy and paste steps", () => {
  it("copies a selection as Vector YAML with each step's inputs as they are", () => {
    const copied = copySteps(config, ["parse", "by_status"]);
    expect(copied).toEqual({ transforms: config.transforms });
    expect(YAML.parse(stepsText(copied))).toEqual(copied);
  });

  it("pastes into the same pipeline reading from the same upstream steps", () => {
    const text = stepsText(copySteps(config, ["parse", "by_status"]));
    const pasted = pasteSteps(config, text);
    expect([...pasted.ids]).toEqual([
      ["parse", "parse_copy"],
      ["by_status", "by_status_copy"],
    ]);
    expect(pasted.config.transforms.parse_copy.inputs).toEqual(["nginx"]);
    expect(pasted.config.transforms.by_status_copy.inputs).toEqual([
      "parse_copy",
    ]);
    expect(pasted.config.transforms.parse).toEqual(config.transforms.parse);
    expect(pasted.config.sinks).toEqual(config.sinks);
  });

  it("gives every paste fresh IDs and rewires inputs between pasted steps", () => {
    const text = stepsText(copySteps(config, ["by_status", "loki_out"]));
    const pasted = pasteSteps(config, text);
    expect(pasted.config.sinks.loki_out_copy.inputs).toEqual([
      "by_status_copy.errors",
    ]);
    // The route still reads the step it read before.
    expect(pasted.config.transforms.by_status_copy.inputs).toEqual(["parse"]);
    const again = pasteSteps(pasted.config, text);
    expect(again.ids.get("by_status")).toBe("by_status_copy_2");
    expect(
      validateGraph(again.config).filter((error) =>
        /Cycle|missing/.test(error),
      ),
    ).toEqual([]);
  });

  it("drops inputs the pipeline doesn't have and refuses text without steps", () => {
    const pasted = pasteSteps(
      config,
      '[transforms.enrich]\ntype = "remap"\ninputs = ["parse", "elsewhere"]\nsource = ".a = 1"\n',
    );
    expect(pasted.config.transforms.enrich.inputs).toEqual(["parse"]);
    expect(pasted.kinds.get("enrich")).toBe("transforms");
    expect(() => pasteSteps(config, "hello: world")).toThrow("no Vector steps");
    expect(
      pasteSteps({}, stepsText(copySteps(config, ["parse"]))).config,
    ).toMatchObject({ transforms: { parse: { inputs: [] } } });
  });
});

const step = (
  id: string,
  kind: BlockStep["kind"],
  inputs: string[] | undefined,
  position?: { x: number; y: number },
): BlockStep => ({
  id,
  kind,
  component: { type: kind === "sinks" ? "console" : "remap", inputs },
  position,
});
const card = (id: string, x: number, y: number) => ({
  id,
  position: { x, y },
  data: { kind: "transforms" as const, component: { type: "remap" } },
});

describe("placing a pasted block", () => {
  it("lays steps out in columns by flow, stacked within a column", () => {
    const layout = layoutBlock([
      step("a", "transforms", undefined),
      step("b", "transforms", ["a"]),
      step("c", "transforms", ["a"]),
      step("out", "sinks", ["b", "c"]),
    ]);
    expect(layout.get("a")).toEqual({ x: 0, y: 0 });
    expect(layout.get("b")).toEqual({ x: PIPELINE_NODE_COLUMN_GAP, y: 0 });
    expect(layout.get("c")!.x).toBe(PIPELINE_NODE_COLUMN_GAP);
    expect(layout.get("c")!.y).toBeGreaterThan(
      pipelineNodeHeight({ kind: "transforms", component: { type: "remap" } }),
    );
    expect(layout.get("out")!.x).toBe(2 * PIPELINE_NODE_COLUMN_GAP);
  });

  it("keeps the block's arrangement and moves it below what is in the way", () => {
    const existing = [card("a", 100, 100), card("b", 500, 100)];
    const block = [
      step("a_copy", "transforms", [], { x: 100, y: 100 }),
      step("b_copy", "transforms", [], { x: 500, y: 100 }),
    ];
    const placed = placeBlock(existing, block, { x: 140, y: 140 });
    const first = placed.get("a_copy")!,
      second = placed.get("b_copy")!;
    expect(second.x - first.x).toBe(400);
    expect(second.y).toBe(first.y);
    const height = pipelineNodeHeight(existing[0].data);
    expect(first.y).toBeGreaterThanOrEqual(100 + height);
    for (const at of [first, second])
      for (const other of existing)
        expect(
          at.x + PIPELINE_NODE_WIDTH <= other.position.x ||
            other.position.x + PIPELINE_NODE_WIDTH <= at.x ||
            at.y >= other.position.y + height ||
            other.position.y >= at.y + height,
        ).toBe(true);
  });

  it("puts a block from elsewhere at the anchor when nothing is there", () => {
    const placed = placeBlock(
      [card("x", 2000, 2000)],
      [step("a", "transforms", undefined), step("b", "transforms", ["a"])],
      { x: 300, y: 200 },
    );
    expect(placed.get("a")).toEqual({ x: 300, y: 200 });
    expect(placed.get("b")).toEqual({
      x: 300 + PIPELINE_NODE_COLUMN_GAP,
      y: 200,
    });
  });
});
