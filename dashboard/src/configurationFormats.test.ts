import { expect, it } from "vitest";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { stringifyConfiguration } from "./configurationFormats";

it("puts type and inputs first in every step without dropping settings", () => {
  const config = {
    sinks: {
      out: { encoding: { codec: "json" }, inputs: ["in"], type: "console" },
    },
    sources: { in: { format: "json", type: "demo_logs" } },
  };
  const text = stringifyConfiguration(config, "yaml");
  expect(text.indexOf("type: console")).toBeLessThan(text.indexOf("inputs:"));
  expect(text.indexOf("inputs:")).toBeLessThan(text.indexOf("encoding:"));
  expect(text.indexOf("sources:")).toBeLessThan(text.indexOf("sinks:"));
  expect(YAML.parse(text)).toEqual(config);
});

it("writes multi-line TOML programs as literal blocks that read back exactly", () => {
  const source = '# keep\n.message = "a \\\\ b"\ndel(.password)\n';
  const config = {
    transforms: { parse: { type: "remap", inputs: ["in"], source } },
  };
  const text = stringifyConfiguration(config, "toml");
  expect(text).toContain("source = '''\n# keep\n");
  expect(parseToml(text)).toEqual(config);
  for (const awkward of [
    "uses ''' quotes\n",
    "ends in a quote\n'",
    "tab\tand\r\n",
  ]) {
    const value = { transforms: { t: { type: "remap", source: awkward } } };
    const kept = stringifyConfiguration(value, "toml");
    expect(kept).not.toContain("'''\n");
    expect(parseToml(kept)).toEqual(value);
  }
});

function parse(text: string, format: string) {
  return format === "json"
    ? JSON.parse(text)
    : format === "toml"
      ? parseToml(text)
      : YAML.parse(text);
}

it.each(["json", "yaml", "toml"])(
  "orders %s sections by event flow while preserving values and the input",
  (format) => {
    const config = {
      future: { enabled: false },
      sinks: { out: { type: "blackhole", inputs: ["second", "first"] } },
      transforms: {
        second: { type: "sample", inputs: ["in"], rate: 10 },
        first: { type: "sample", inputs: ["in"], rate: 2 },
      },
      sources: { in: { type: "demo_logs", format: "json" } },
      api: { enabled: false, address: "127.0.0.1:8686" },
    };
    const before = JSON.stringify(config);
    const result = parse(stringifyConfiguration(config, format), format);
    expect(Object.keys(result)).toEqual([
      "sources",
      "transforms",
      "sinks",
      "future",
      "api",
    ]);
    expect(result).toEqual(config);
    expect(Object.keys(result.transforms)).toEqual(["second", "first"]);
    expect(JSON.stringify(config)).toBe(before);
  },
);

const withTests = () => ({
  tests: [
    {
      name: "keeps errors",
      inputs: [{ insert_at: "keep", type: "log", log_fields: { level: "a" } }],
      outputs: [
        {
          extract_from: "keep",
          conditions: [{ type: "vrl", source: '.level == "a"' }],
        },
      ],
    },
  ],
  data_dir: "/var/lib/vector",
  sinks: { out: { type: "blackhole", inputs: ["keep"] } },
  enrichment_tables: { lookup: { type: "file", file: { path: "/x.csv" } } },
  transforms: { keep: { type: "filter", inputs: ["in"], condition: "true" } },
  sources: { in: { type: "demo_logs", format: "json" } },
});

it.each(["json", "yaml", "toml"])(
  "writes sources, transforms and sinks first and the pipeline tests last in %s",
  (format) => {
    const config = withTests();
    const result = parse(stringifyConfiguration(config, format), format);
    const keys = Object.keys(result);
    // TOML puts root assignments before every table, whatever their order.
    expect(keys.filter((key) => key !== "data_dir")).toEqual([
      "sources",
      "transforms",
      "sinks",
      "enrichment_tables",
      "tests",
    ]);
    if (format !== "toml")
      expect(keys).toEqual([
        "sources",
        "transforms",
        "sinks",
        "data_dir",
        "enrichment_tables",
        "tests",
      ]);
    expect(result).toEqual(config);
  },
);

it("starts the YAML text at the sources and ends it with the tests", () => {
  const text = stringifyConfiguration(withTests(), "yaml");
  const headings = text.split("\n").filter((line) => /^\S/.test(line));
  expect(headings[0]).toBe("sources:");
  expect(headings.at(-1)).toBe("tests:");
  expect(text.startsWith("sources:")).toBe(true);
});

it.each(["json", "yaml", "toml"])(
  "does not invent absent %s sections",
  (format) => {
    const config = { sinks: {}, sources: {} };
    const result = parse(stringifyConfiguration(config, format), format);
    expect(Object.keys(result)).toEqual(["sources", "sinks"]);
    expect(result).toEqual(config);
  },
);

it("keeps TOML root assignments outside the ordered section tables", () => {
  const config = {
    sinks: { out: { type: "blackhole", inputs: ["in"] } },
    timezone: "UTC",
    sources: { in: { type: "demo_logs" } },
    data_dir: "/var/lib/vector",
    api: { enabled: false },
    transforms: {},
  };
  const text = stringifyConfiguration(config, "toml");
  expect(text.indexOf("data_dir =")).toBeLessThan(text.indexOf("[sources"));
  expect(text.indexOf("timezone =")).toBeLessThan(text.indexOf("[sources"));
  expect(
    Object.keys(parseToml(text)).filter(
      (key) => !["data_dir", "timezone"].includes(key),
    ),
  ).toEqual(["sources", "transforms", "sinks", "api"]);
  expect(parseToml(text)).toEqual(config);
});

it.each(["json", "yaml"])(
  "preserves explicit section values and unusual own keys in %s",
  (format) => {
    const config = JSON.parse(
      '{"__proto__":{"safe":true},"sinks":null,"api":false,"sources":{}}',
    );
    const result = parse(stringifyConfiguration(config, format), format);
    expect(Object.keys(result)).toEqual([
      "sources",
      "sinks",
      "__proto__",
      "api",
    ]);
    expect(result).toEqual(config);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
  },
);

it("refuses TOML conversion that would silently omit a null object field", () => {
  const config = {
    sources: { in: { type: "demo_logs", future: { nullable: null } } },
  };
  const before = structuredClone(config);
  expect(() => stringifyConfiguration(config, "toml")).toThrow(
    "sources.in.future.nullable",
  );
  expect(config).toEqual(before);
});
it("preserves supported TOML values, empty containers, native references and numeric-looking text", () => {
  const config = {
    sources: {
      sample: {
        type: "demo_logs",
        flag: false,
        zero: 0,
        ratio: 0.125,
        empty: "",
        list: [],
        object: {},
        mixed: [1, "2", false],
        ref: "${VECTOR_PATH}",
        date: "2026-09-26",
      },
    },
    transforms: {},
    "unknown.key": { "x/y": "9223372036854775807" },
  };
  expect(parseToml(stringifyConfiguration(config, "toml"))).toEqual(config);
});
it.each(["json", "yaml"])(
  "keeps explicit nulls, nested unknown values and array order in %s",
  (format) => {
    const config = {
      unknown: { value: null, list: [null, "", false, 0, { "a.b": null }] },
    };
    const text = stringifyConfiguration(config, format);
    expect(format === "json" ? JSON.parse(text) : YAML.parse(text)).toEqual(
      config,
    );
  },
);
