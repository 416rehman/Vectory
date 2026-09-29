import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { copySteps, pasteSteps, stepsText } from "./canvasClipboard";
import { validateGraph } from "./catalog";

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
  it("copies a selection as standalone Vector YAML", () => {
    const copied = copySteps(config, ["parse", "by_status"]);
    expect(copied).toEqual({
      transforms: {
        parse: { ...config.transforms.parse, inputs: [] },
        by_status: config.transforms.by_status,
      },
    });
    expect(YAML.parse(stepsText(copied))).toEqual(copied);
  });

  it("pastes with fresh IDs and rewires inputs between pasted steps", () => {
    const text = stepsText(copySteps(config, ["by_status", "loki_out"]));
    const pasted = pasteSteps(config, text);
    expect([...pasted.ids]).toEqual([
      ["by_status", "by_status_copy"],
      ["loki_out", "loki_out_copy"],
    ]);
    expect(pasted.config.sinks.loki_out_copy.inputs).toEqual([
      "by_status_copy.errors",
    ]);
    expect(pasted.config.transforms.by_status_copy.inputs).toEqual([]);
    expect(pasted.config.transforms.parse).toEqual(config.transforms.parse);
    const again = pasteSteps(pasted.config, text);
    expect(again.ids.get("by_status")).toBe("by_status_copy_2");
    expect(
      validateGraph(again.config).filter((error) =>
        /Cycle|missing/.test(error),
      ),
    ).toEqual([]);
  });

  it("accepts steps from any Vector config and refuses text without steps", () => {
    const pasted = pasteSteps(
      config,
      '[transforms.enrich]\ntype = "remap"\ninputs = ["parse", "elsewhere"]\nsource = ".a = 1"\n',
    );
    expect(pasted.config.transforms.enrich.inputs).toEqual(["parse"]);
    expect(pasted.kinds.get("enrich")).toBe("transforms");
    expect(() => pasteSteps(config, "hello: world")).toThrow("no Vector steps");
  });
});
