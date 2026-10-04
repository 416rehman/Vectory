import { describe, expect, it } from "vitest";
import { guessConfigurationFormat } from "./configurationSource";
import { readStartImport, readStartText } from "./PipelineStartChoice";

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

  it("rejects malformed UTF-8 in a new-pipeline file without replacing bytes", async () => {
    const valid = new TextEncoder().encode(
      "sources:\n  demo:\n    type: demo_logs\n# ",
    );
    const file = new File(
      [new Uint8Array([...valid, 0xff, 0x0a])],
      "demo.yaml",
      { type: "text/yaml" },
    );
    const imported = await readStartImport(file);
    expect(imported.config).toBeUndefined();
    expect(imported.error).toBe(
      "The file is not valid UTF-8. Save it as UTF-8 and try again.",
    );
  });

  it("reports a credential-bearing import before pipeline creation", async () => {
    const imported = await readStartText(
      "Pasted YAML",
      "sources:\n  demo:\n    type: demo_logs\n    format: json\nsinks:\n  out:\n    type: http\n    inputs: [demo]\n    uri: https://example.test/ingest\n    request:\n      headers:\n        Authorization: Bearer hidden\n    encoding:\n      codec: json\n",
      "yaml",
    );
    expect(imported.config).toBeUndefined();
    expect(imported.error).toMatch(
      /^sinks\.out\.request\.headers\.Authorization/,
    );
    expect(imported.error).not.toContain("hidden");
  });

  it("explains unsupported device references in URLs before import", async () => {
    const imported = await readStartText(
      "Pasted YAML",
      "sources:\n  demo:\n    type: demo_logs\n    format: json\nsinks:\n  out:\n    type: http\n    inputs: [demo]\n    uri: https://example.test/ingest?api_key=vectory-secret:INGEST\n    encoding:\n      codec: json\n",
      "yaml",
    );
    expect(imported.config).toBeUndefined();
    expect(imported.error).toMatch(
      /out\.uri: Only credential fields can hold a device secret/,
    );
    expect(imported.error).toContain(
      "does not support device secrets in headers or URLs",
    );
    expect(imported.error).not.toContain("looks like a plaintext credential");
  });
});
