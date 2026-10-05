import { describe, expect, it } from "vitest";
import {
  parseSource,
  diagnoseConfiguration,
  diagnoseConfigurationSource,
  assertValidPipelineSource,
  detectConfigurationFormat,
  diagnosticCounts,
  sourceErrorMessage,
  sourceLineForPath,
  isEmptyPipeline,
  MAX_CONFIGURATION_BYTES,
  ConfigurationSourceError,
  readConfigurationFiles,
} from "./configurationSource";
import { stringifyConfiguration } from "./configurationFormats";

const pipeline = {
  sources: { incoming: { type: "demo_logs", format: "json" } },
  transforms: {
    keep: { type: "filter", inputs: ["incoming"], condition: ".status >= 400" },
  },
  sinks: {
    output: { type: "console", inputs: ["keep"], encoding: { codec: "json" } },
  },
};

describe("lossless configuration source parsing", () => {
  it("locates a credential field in YAML and JSON without guessing repeated TOML keys", () => {
    const steps = ["sinks", "out", "request", "headers", "Authorization"];
    expect(
      sourceLineForPath(
        "sinks:\n  out:\n    request:\n      headers:\n        Authorization: Bearer synthetic-value\n",
        "yaml",
        steps,
      ),
    ).toBe(5);
    expect(
      sourceLineForPath(
        '{\n  "sinks": {"out": {"Authorization": "synthetic-value"}}\n}',
        "json",
        ["sinks", "out", "Authorization"],
      ),
    ).toBe(2);
    expect(
      sourceLineForPath(
        '[sinks.out]\napi_key = "synthetic-value"\n[sinks.other]\napi_key = "another-value"',
        "toml",
        ["sinks", "out", "api_key"],
      ),
    ).toBeNull();
  });
  it.each(["yaml", "json", "toml"])(
    "parses and validates a complete %s pipeline",
    (format) => {
      const source = stringifyConfiguration(pipeline, format);
      expect(parseSource(source, format)).toEqual(pipeline);
      const result = diagnoseConfigurationSource(source, format);
      expect(result.config).toEqual(pipeline);
      expect(result.diagnostics).toEqual([]);
      expect(result.locallyValid).toBe(true);
      expect(result.runtimeValidationRequired).toBe(true);
      expect(assertValidPipelineSource(source, format)).toEqual(pipeline);
    },
  );
  it.each(["json", "yaml", "toml"])(
    "preserves unknown fields and own prototype-looking keys in %s",
    (format) => {
      const config = JSON.parse(
        '{"sources":{},"custom":{"__proto__":{"keep":true},"constructor":"value","nested":[false,0,"001"]}}',
      );
      expect(
        parseSource(stringifyConfiguration(config, format), format),
      ).toEqual(config);
      expect(
        Object.hasOwn(
          parseSource(stringifyConfiguration(config, format), format).custom,
          "__proto__",
        ),
      ).toBe(true);
      expect(({} as Record<string, unknown>).keep).toBeUndefined();
    },
  );
  it.each(["[]", "null", "3", '"text"'])(
    "rejects a nonobject JSON root: %s",
    (source) => {
      expect(() => parseSource(source, "json")).toThrow(
        "configuration must be an object",
      );
    },
  );
  it.each([
    { sources: [] },
    { sources: null },
    { transforms: "bad" },
    { sinks: 3 },
    { enrichment_tables: [] },
    { sources: { broken: null } },
    { sinks: { broken: [] } },
  ])(
    "rejects malformed component sections before graph traversal: %j",
    (config) => {
      expect(() => parseSource(JSON.stringify(config), "json")).toThrow(
        /must be an object/,
      );
    },
  );
  it.each([
    ['{"sources":{},"sources":{}}', "json"],
    ['{"a":1,"\\u0061":2}', "json"],
    ["sources: {}\nsources: {}", "yaml"],
    ["[sources]\n[sources]", "toml"],
  ])(
    "rejects duplicate keys rather than silently dropping earlier values",
    (source, format) => {
      expect(() => parseSource(source, format)).toThrow();
    },
  );
  it("accepts ordinary YAML aliases but rejects cycles and expansion bombs", () => {
    expect(parseSource("x: &x {a: 1}\ny: *x", "yaml")).toEqual({
      x: { a: 1 },
      y: { a: 1 },
    });
    expect(() => parseSource("x: &x {recursive: *x}", "yaml")).toThrow(
      /recursive|alias/i,
    );
    expect(() =>
      parseSource(
        "a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
        "yaml",
      ),
    ).toThrow(/alias|expan/i);
  });
  it("resolves YAML merge aliases into component fields before validation", () => {
    const source = `sources:
  base: &base
    type: demo_logs
    format: json
  copy:
    <<: *base
sinks:
  out:
    type: console
    inputs: [copy]
    encoding: { codec: json }
`;
    const config = parseSource(source, "yaml");
    expect(config.sources.copy).toEqual(config.sources.base);
    expect(Object.hasOwn(config.sources.copy, "<<")).toBe(false);
    expect(assertValidPipelineSource(source, "yaml")).toEqual(config);
  });
  it("honors explicit YAML merge overrides and first-map precedence", () => {
    const source = `sources:
  first: &first { type: demo_logs, format: json, interval: 1 }
  second: &second { type: demo_logs, format: shuffle, interval: 2 }
  merged:
    <<: [*first, *second]
    interval: 3
`;
    expect(parseSource(source, "yaml").sources.merged).toEqual({
      type: "demo_logs",
      format: "json",
      interval: 3,
    });
  });
  it.each([
    "sources: {broken: {<<: *missing}}",
    "defaults: &defaults [demo_logs]\nsources: {broken: {<<: *defaults}}",
    "sources: {broken: &broken {<<: *broken}}",
  ])("rejects malformed or cyclic YAML merge aliases: %s", (source) => {
    expect(() => parseSource(source, "yaml")).toThrow(ConfigurationSourceError);
  });
  it("keeps duplicate explicit keys invalid even when a merge is present", () => {
    const source = `sources:
  base: &base { type: demo_logs, format: json }
  copy: { <<: *base, format: json, format: shuffle }
`;
    expect(() => parseSource(source, "yaml")).toThrow(/unique/i);
  });
  it("keeps a quoted YAML << key as ordinary data", () => {
    expect(parseSource('future: { "<<": kept }', "yaml")).toEqual({
      future: { "<<": "kept" },
    });
  });
  it.each([
    "x: !!set {a: null}",
    "x: !!binary SGVsbG8=",
    "x: !!timestamp 2026-09-26",
    "x: !custom value",
    "? [a,b]\n: value",
    "1: value",
  ])("rejects YAML-only values and nonstring map keys", (source) => {
    expect(() => parseSource(source, "yaml")).toThrow();
  });
  it("rejects TOML dates without silently converting them to strings", () => {
    expect(() => parseSource("x = 2026-09-26", "toml")).toThrow(
      /Quote the value/,
    );
    expect(parseSource('x = "2026-09-26"', "toml")).toEqual({
      x: "2026-09-26",
    });
  });
  it.each([
    ['{"x":9007199254740993}', "json"],
    ["x: 9007199254740993", "yaml"],
    ["x = 9007199254740993", "toml"],
    ['{"x":1e100}', "json"],
    ["x: .nan", "yaml"],
    ["x = inf", "toml"],
  ])("rejects unsafe/nonfinite numbers", (source, format) => {
    expect(() => parseSource(source, format)).toThrow(/exactly|integer|number/);
  });
  it.each(["json", "yaml", "toml"])(
    "preserves safe integers, decimals and numeric-looking text in %s",
    (format) => {
      const value = {
        max: Number.MAX_SAFE_INTEGER,
        min: Number.MIN_SAFE_INTEGER,
        decimal: 0.125,
        text: "9223372036854775807",
      };
      expect(
        parseSource(stringifyConfiguration(value, format), format),
      ).toEqual(value);
    },
  );
  it("never silently loses null when converting to TOML", () => {
    const config = { ...pipeline, future: { nullable: null } };
    for (const format of ["json", "yaml"])
      expect(
        parseSource(stringifyConfiguration(config, format), format),
      ).toEqual(config);
    expect(() => stringifyConfiguration(config, "toml")).toThrow(
      "future.nullable",
    );
  });
  it("bounds UTF8 bytes, including multibyte source text", () => {
    const source = JSON.stringify({
      note: "\u{1f600}".repeat(MAX_CONFIGURATION_BYTES / 4),
    });
    expect(source.length).toBeLessThan(MAX_CONFIGURATION_BYTES);
    expect(() => parseSource(source, "json")).toThrow("1 MiB");
  });
  it("rejects excessive nesting with a useful bounded error", () => {
    const source = '{"x":'.repeat(110) + "1" + "}".repeat(110);
    expect(() => parseSource(source, "json")).toThrow(/nested|depth/i);
  });
});

describe("local source diagnostics and import gate", () => {
  it("keeps a compact single JSON file even when YAML would exceed the merged-file limit", async () => {
    const config = {
      sources: { incoming: { type: "demo_logs", format: "json" } },
      transforms: {
        keep: {
          type: "remap",
          inputs: ["incoming"],
          source: ". = .\n" + "#\n".repeat(150_000),
        },
      },
      sinks: { output: { type: "blackhole", inputs: ["keep"] } },
    };
    const text = JSON.stringify(config);
    expect(new TextEncoder().encode(text).length).toBeLessThan(
      MAX_CONFIGURATION_BYTES,
    );
    expect(
      new TextEncoder().encode(stringifyConfiguration(config, "yaml")).length,
    ).toBeGreaterThan(MAX_CONFIGURATION_BYTES);

    const file = new File([text], "compact.json", {
      type: "application/json",
    });
    const single = await readConfigurationFiles([file]);
    expect(single.text).toBe(text);
    expect(single.format).toBe("json");
    expect(single.config.transforms.keep.source).toBe(
      config.transforms.keep.source,
    );
    await expect(
      readConfigurationFiles([
        file,
        new File(["api: {enabled: false}\n"], "api.yaml"),
      ]),
    ).rejects.toThrow("The combined configuration exceeds the 1 MiB limit.");
  });

  it("explains when compact source bytes fit but the publish artifact cannot", async () => {
    const text = JSON.stringify({
      sources: {
        incoming: { type: "file", include: Array(100_000).fill("/a") },
      },
      sinks: { output: { type: "blackhole", inputs: ["incoming"] } },
    });
    expect(new TextEncoder().encode(text).length).toBeLessThan(
      MAX_CONFIGURATION_BYTES,
    );
    await expect(
      readConfigurationFiles([new File([text], "compact.json")]),
    ).rejects.toThrow("The rendered pipeline exceeds the 1 MiB publish limit.");
  });

  it("shows a required node field once while retaining its node identity", () => {
    const config = {
      sources: { incoming: { type: "demo_logs", format: "json" } },
      sinks: {
        output: {
          type: "blackhole",
          inputs: ["incoming"],
          buffer: { type: "disk" },
        },
      },
    };
    const issues = diagnoseConfiguration(config).diagnostics.filter(
      (item) => item.severity === "error" && item.message.includes("max_size"),
    );
    expect(issues).toEqual([
      expect.objectContaining({
        componentId: "output",
        message: "output: Enter buffer.max_size.",
      }),
    ]);
  });
  it("attributes an enrichment-table field error to the shared graph table", () => {
    const config = {
      sources: { incoming: { type: "demo_logs", format: "json" } },
      enrichment_tables: {
        lookup: {
          type: "memory",
          inputs: ["incoming"],
          source_config: { source_key: "cache_events", export_interval: "bad" },
        },
      },
      sinks: { output: { type: "blackhole", inputs: ["cache_events"] } },
    };
    expect(
      diagnoseConfiguration(config).diagnostics.some(
        (item) =>
          item.severity === "error" &&
          item.enrichmentTableId === "lookup" &&
          item.message.includes("export_interval"),
      ),
    ).toBe(true);
  });
  it.each([
    ['{\n "sources": {},\n "x": ]\n}', "json"],
    ["sources: {}\nbroken: [\n", "yaml"],
    ["[sources]\nbroken = ]", "toml"],
  ])(
    "gives a bounded nonzero syntax range for multiline %s",
    (source, format) => {
      const result = diagnoseConfigurationSource(source, format);
      expect(result.config).toBeUndefined();
      expect(result.locallyValid).toBe(false);
      expect(result.diagnostics[0].severity).toBe("error");
      expect(result.diagnostics[0].from).toBeGreaterThan(0);
      expect(result.diagnostics[0].to).toBeLessThanOrEqual(source.length);
    },
  );
  it("keeps parsed config available for lint but rejects a disconnected import", () => {
    const config = structuredClone(pipeline);
    config.sinks.output.inputs = ["missing"];
    const result = diagnoseConfigurationSource(JSON.stringify(config), "json");
    expect(result.config).toEqual(config);
    expect(
      result.diagnostics.some((d) => /missing input missing/.test(d.message)),
    ).toBe(true);
    expect(() =>
      assertValidPipelineSource(JSON.stringify(config), "json"),
    ).toThrow(ConfigurationSourceError);
  });
  it("rejects literal cycles and definite documented scalar types/limits", () => {
    const config = {
      ...pipeline,
      transforms: {
        a: { type: "sample", inputs: ["b"], rate: -1 },
        b: { type: "sample", inputs: ["a"], rate: "not a number" },
      },
      sinks: { out: { type: "blackhole", inputs: ["b"] } },
    };
    const result = diagnoseConfigurationSource(JSON.stringify(config), "json");
    expect(result.diagnostics.some((d) => /Cycle/.test(d.message))).toBe(true);
    expect(
      result.diagnostics.some((d) =>
        /rate.*(?:greater than|at least)/.test(d.message),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some((d) => /rate.*expected/.test(d.message)),
    ).toBe(true);
  });
  it("allows opaque extensions and custom types while requiring native validation", () => {
    const config = {
      sources: { in: { type: "custom_build_source", future: { value: null } } },
      sinks: {
        out: { type: "blackhole", inputs: ["in"], unknown_extension: true },
      },
      future_global: { enabled: true },
    };
    const result = diagnoseConfigurationSource(JSON.stringify(config), "json");
    expect(result.locallyValid).toBe(true);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && /Vector build/.test(d.message),
      ),
    ).toBe(true);
    expect(assertValidPipelineSource(JSON.stringify(config), "json")).toEqual(
      config,
    );
  });
  it("defers native env/glob references instead of claiming local runtime validity", () => {
    const config = {
      sources: {
        incoming: {
          type: "demo_logs",
          format: "json",
          interval: "${INTERVAL}",
        },
      },
      sinks: {
        out: { type: "blackhole", inputs: ["incoming*", "${MORE_INPUTS}"] },
      },
    };
    const result = diagnoseConfigurationSource(JSON.stringify(config), "json");
    expect(result.locallyValid).toBe(true);
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.code === "deferred" &&
          /resolves/.test(d.message),
      ),
    ).toBe(true);
    expect(assertValidPipelineSource(JSON.stringify(config), "json")).toEqual(
      config,
    );
  });
  it("recognizes supported extensions only, ignoring case", () => {
    expect(detectConfigurationFormat("VECTOR.YML")).toBe("yaml");
    expect(detectConfigurationFormat("a.YaMl")).toBe("yaml");
    expect(detectConfigurationFormat("config.JSON")).toBe("json");
    expect(detectConfigurationFormat("config.TOML")).toBe("toml");
    for (const file of [
      "config",
      "config.txt",
      "config.json.exe",
      "config.yaml?x",
    ])
      expect(() => detectConfigurationFormat(file)).toThrow();
  });
  it("rejects malformed known globals and provider bypasses while retaining opaque globals", () => {
    for (const config of [
      { provider: "bad" },
      { provider: {} },
      { provider: { type: "bogus" } },
      { provider: true },
      { ...pipeline, api: { enabled: "yes" } },
      { ...pipeline, secret: "bad" },
    ]) {
      const result = diagnoseConfigurationSource(
        JSON.stringify(config),
        "json",
      );
      expect(result.locallyValid).toBe(false);
      expect(() =>
        assertValidPipelineSource(JSON.stringify(config), "json"),
      ).toThrow();
    }
    expect(
      diagnoseConfigurationSource(
        JSON.stringify({
          ...pipeline,
          api: { enabled: true, future: true },
          future: { value: null },
        }),
        "json",
      ).locallyValid,
    ).toBe(true);
  });
  it("protects global-only/opaque documents from silent empty-pipeline replacement", () => {
    expect(isEmptyPipeline({})).toBe(true);
    expect(isEmptyPipeline({ sources: {}, transforms: {}, sinks: {} })).toBe(
      true,
    );
    for (const config of [
      { sources: null },
      { data_dir: "/var/lib/vector" },
      { api: { enabled: true } },
      { provider: {} },
      { enrichment_tables: {} },
      { unknown: null },
      pipeline,
    ])
      expect(isEmptyPipeline(config)).toBe(false);
  });
});

describe("sourceErrorMessage", () => {
  const failureOf = (text: string, format: string) => {
    try {
      parseSource(text, format);
    } catch (error) {
      return error;
    }
    throw new Error("The text was expected to fail.");
  };

  it("names the line and column of the first problem", () => {
    const yaml = "sources:\n  demo:\n    type: demo_logs\n   format: json\n";
    expect(sourceErrorMessage(yaml, failureOf(yaml, "yaml"))).toMatch(
      /^Line 4:\d+: \S/,
    );
    const json = '{\n  "sources": {\n    "demo": }\n}';
    expect(sourceErrorMessage(json, failureOf(json, "json"))).toMatch(
      /^Line 3:\d+: \S/,
    );
  });

  it("counts a source's errors and warnings, singular for one", () => {
    const error = { severity: "error" as const },
      warning = { severity: "warning" as const };
    expect(diagnosticCounts([error])).toBe("1 error · 0 warnings");
    expect(diagnosticCounts([error, error, warning])).toBe(
      "2 errors · 1 warning",
    );
    expect(diagnosticCounts([warning, warning])).toBe("0 errors · 2 warnings");
  });

  it("never returns an empty message", () => {
    expect(sourceErrorMessage("a: 1", new Error("Choose a file."))).toBe(
      "Choose a file.",
    );
    expect(sourceErrorMessage("", new Error(""))).toBe(
      "This configuration could not be read.",
    );
    expect(sourceErrorMessage("", "unknown")).toBe(
      "This configuration could not be read.",
    );
  });
});
