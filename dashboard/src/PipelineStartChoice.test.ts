import { describe, expect, it } from "vitest";
import { guessConfigurationFormat } from "./configurationSource";
import { readStartText } from "./PipelineStartChoice";

describe("pasted Vector configurations", () => {
  it("recognizes the format from the text", () => {
    expect(guessConfigurationFormat('{"sources":{}}')).toBe("json");
    expect(
      guessConfigurationFormat('[sources.app]\ntype = "file"\ninclude = []'),
    ).toBe("toml");
    expect(guessConfigurationFormat("sources:\n  app:\n    type: file")).toBe(
      "yaml",
    );
  });

  it("reads a valid pipeline and says where a broken one fails", async () => {
    const good = await readStartText(
      "Pasted YAML",
      "sources:\n  demo:\n    type: demo_logs\n    format: json\nsinks:\n  out:\n    type: console\n    inputs: [demo]\n    encoding:\n      codec: json\n",
      "yaml",
    );
    expect(good.error).toBeUndefined();
    expect(good.summary).toMatch(/^2 steps/);
    const bad = await readStartText(
      "Pasted YAML",
      "sources:\n  demo:\n    type: demo_logs\n   format: json\n",
      "yaml",
    );
    expect(bad.error).toMatch(/^Line 4:\d+: /);
  });
});
