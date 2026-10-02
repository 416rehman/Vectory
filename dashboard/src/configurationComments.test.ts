import { expect, it } from "vitest";
import YAML from "yaml";
import {
  hasSourceComments,
  stringifyConfiguration,
} from "./configurationFormats";

it("finds comments that applying code would drop, not # lines in VRL", () => {
  expect(hasSourceComments("# owner: web team\nsources: {}\n", "yaml")).toBe(
    true,
  );
  expect(hasSourceComments("sources: {} # inline\n", "yaml")).toBe(true);
  expect(
    hasSourceComments(
      "transforms:\n  parse:\n    type: remap\n    source: |\n      # kept\n      .a = 1\n",
      "yaml",
    ),
  ).toBe(false);
  expect(hasSourceComments('# owner\n[sources.a]\ntype = "file"', "toml")).toBe(
    true,
  );
  expect(
    hasSourceComments(
      "[transforms.parse]\nsource = '''\n# kept\n.a = 1'''\ncolor = \"#fff\"",
      "toml",
    ),
  ).toBe(false);
  expect(hasSourceComments('{"a": "#"}', "json")).toBe(false);
});

it("writes the pipeline before global options, root assignments first in TOML, and one blank line between TOML tables", () => {
  const text = stringifyConfiguration(
    {
      sources: { a: { type: "demo_logs", format: "json" } },
      sinks: { b: { type: "console", inputs: ["a"] } },
      data_dir: "/var/lib/vector",
    },
    "toml",
  );
  expect(text.startsWith('data_dir = "/var/lib/vector"')).toBe(true);
  expect(text).not.toMatch(/\n\n\n/);
  expect(
    Object.keys(
      YAML.parse(
        stringifyConfiguration({ sinks: {}, timezone: "UTC" }, "yaml"),
      ),
    ),
  ).toEqual(["sinks", "timezone"]);
});
