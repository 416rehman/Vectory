import { describe, expect, it } from "vitest";
import { guessConfigurationFormat } from "./configurationSource";
import {
  readStartFiles,
  readStartImport,
  readStartText,
} from "./PipelineStartChoice";

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
      "demo.yaml: the file is not valid UTF-8. Save it as UTF-8 and try again.",
    );
  });

  it("joins mixed-format Vector fragments before checking and naming a new pipeline", async () => {
    const imported = await readStartFiles([
      new File(
        ['[sinks.out]\ntype = "blackhole"\ninputs = ["sample"]\n'],
        "03-sink.toml",
      ),
      new File(
        ['{"sources":{"demo":{"type":"demo_logs","format":"json"}}}'],
        "01-source.json",
      ),
      new File(
        [
          "transforms:\n  sample:\n    type: sample\n    inputs: [demo]\n    rate: 10\n",
        ],
        "02-transform.yaml",
      ),
    ]);
    expect(imported.error).toBeUndefined();
    expect(imported.name).toBe("3 configuration files");
    expect(imported.suggestedName).toBeUndefined();
    expect(imported.summary).toMatch(/^3 steps/);
    expect(imported.config?.sinks.out.inputs).toEqual(["sample"]);
    expect(imported.config?.transforms.sample.rate).toBe(10);
  });

  it("refuses a conflicting fragment without silently replacing a component", async () => {
    const imported = await readStartFiles([
      new File(
        ["sources:\n  demo: {type: demo_logs, format: json}\n"],
        "a.yaml",
      ),
      new File(
        ["sources:\n  demo: {type: demo_logs, format: syslog}\n"],
        "b.yaml",
      ),
    ]);
    expect(imported.config).toBeUndefined();
    expect(imported.error).toMatch(
      /b\.yaml: sources\.demo is also defined in a\.yaml/,
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
      /^Line 12: sinks\.out\.request\.headers\.Authorization/,
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
