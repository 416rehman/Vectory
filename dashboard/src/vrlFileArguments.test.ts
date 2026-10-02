import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "./generated/vector-catalog.json";
import { fullModeRequirements } from "./hostRequirements";
import {
  fileArgumentCalls,
  fileArgumentFunctions,
  maxCallBytes,
  maxFileArgumentCalls,
  maxScanFactor,
} from "./vrlFileArguments";

type Program = string | Program[] | { repeat: Program; times: number };
type Fixture = {
  functions: {
    function: string;
    argument: string;
    position: number;
    label: string;
  }[];
  bounds: { calls: number; call_bytes: number; scan_factor: number };
  cases: { name: string; program: Program; found: string[] }[];
};

// The programs every scanner of a VRL call that passes a file judges alike:
// the server's, the agent's and this one read the same file.
const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL(
      "vector-catalog/fixtures/vrl-file-arguments.json",
      new URL("../../", import.meta.url),
    ),
    "utf8",
  ),
);
// A program is a string, a list of programs joined together, or a program
// repeated.
const programOf = (program: Program): string =>
  typeof program === "string"
    ? program
    : Array.isArray(program)
      ? program.map(programOf).join("")
      : programOf(program.repeat).repeat(program.times);

describe("the scan for a VRL call that passes a file", () => {
  it("has the table and the bounds of the shared fixture", () => {
    expect(
      fileArgumentFunctions.map((target) => ({
        function: target.name,
        argument: target.argument,
        position: target.position,
        label: target.label,
      })),
    ).toEqual(fixture.functions);
    expect(fixture.bounds).toEqual({
      calls: maxFileArgumentCalls,
      call_bytes: maxCallBytes,
      scan_factor: maxScanFactor,
    });
  });

  it("judges every program of the shared fixture as the server and the agent do", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(60);
    for (const { name, program, found } of fixture.cases)
      expect(
        fileArgumentCalls(programOf(program)).map((target) => target.label),
        name,
      ).toEqual(found);
  });
});

describe("a pipeline that passes a file to a VRL function", () => {
  const pipeline = (source: string, tests: unknown[] = []) => ({
    sources: { demo: { type: "demo_logs", format: "json" } },
    transforms: { r: { type: "remap", inputs: ["demo"], source } },
    sinks: { out: { type: "blackhole", inputs: ["r"] } },
    ...(tests.length ? { tests } : {}),
  });
  const needs = (source: string, tests: unknown[] = []) =>
    fullModeRequirements(pipeline(source, tests), catalog);
  // Grok patterns without %{, which restricted mode refuses on its own, so the
  // call that passes a file is what is judged.
  const withFile = [
    '.x = parse_groks!(.message, ["[a-z]+"], alias_sources: ["/etc/a.json"])',
    '.x = parse_groks!(.message, ["[a-z]+"], {}, ["/etc/a.json"])',
    '.x = parse_etld!(.message, psl: "/etc/list.dat")',
    '.x = parse_etld!(.message, 1, "/etc/list.dat")',
    ".x = parse_etld!(.message, r'\\', psl: \"/etc/list.dat\")",
  ];
  const withoutFile = [
    '.x = parse_groks!(.message, ["[a-z]+"], aliases: {"A": "[a-z]+"})',
    ".x = parse_etld!(.message)",
    ".x = parse_etld!(.message, plus_parts: 1)",
    '.parse_etld = 1\n.note = "parse_groks and psl: are words"',
  ];

  it("needs a full-mode device, as a call to an external function does", () => {
    for (const source of withFile)
      expect(needs(source), source).toEqual(["VRL access to device resources"]);
  });

  it("needs one in a unit test's VRL too", () => {
    const test = (source: string) => [
      {
        name: "t",
        inputs: [{ insert_at: "r", type: "log", log_fields: { message: "x" } }],
        outputs: [{ extract_from: "r", conditions: [{ type: "vrl", source }] }],
      },
    ];
    expect(
      needs(".x = 1", test('parse_etld!(.d, psl: "/etc/list.dat") == "x"')),
    ).toEqual(["VRL access to device resources"]);
    expect(
      needs(".x = 1", test('parse_etld!(.d, plus_parts: 1).etld == "x"')),
    ).toEqual([]);
  });

  it("is as before without the file argument", () => {
    for (const source of withoutFile) expect(needs(source), source).toEqual([]);
  });
});
