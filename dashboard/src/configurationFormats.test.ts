import { expect, it } from "vitest";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { stringifyConfiguration } from "./configurationFormats";

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
      "api",
      "sources",
      "transforms",
      "sinks",
      "future",
    ]);
    expect(result).toEqual(config);
    expect(Object.keys(result.transforms)).toEqual(["second", "first"]);
    expect(JSON.stringify(config)).toBe(before);
  },
);

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
  expect(text.indexOf("data_dir =")).toBeLessThan(text.indexOf("[api]"));
  expect(text.indexOf("timezone =")).toBeLessThan(text.indexOf("[api]"));
  expect(
    Object.keys(parseToml(text)).filter(
      (key) => !["data_dir", "timezone"].includes(key),
    ),
  ).toEqual(["api", "sources", "transforms", "sinks"]);
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
      "api",
      "sources",
      "sinks",
      "__proto__",
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
