import { beforeEach, describe, expect, it } from "vitest";
import { parseLosslessJSON } from "./configurationNumbers";
import { diffEvents, displayValue, flattenEvent } from "./eventDiff";
import { eventPaths } from "./vrlLanguage";
import {
  DEFAULT_SAMPLE,
  activeSet,
  emptyStore,
  parseSamples,
  readSamples,
  uniqueSetName,
  writeSamples,
} from "./sampleStore";
import {
  assertionsFor,
  unitTestFromSample,
  vrlLiteral,
  vrlString,
  type SampleResult,
} from "./sampleTests";

describe("sample sets", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  });

  it("persist per account and pipeline with a safe default", () => {
    const store = readSamples("user", "pipeline");
    expect(store.sets[0].name).toBe("Sample events");
    store.sets.push({ id: "s2", name: uniqueSetName(store), text: "{}" });
    store.active.parse = "s2";
    expect(writeSamples("user", "pipeline", store)).toBe(true);
    expect(activeSet(readSamples("user", "pipeline"), "parse").id).toBe("s2");
    expect(readSamples("user", "other").sets).toHaveLength(1);
    expect(activeSet(emptyStore(), "missing").id).toBe("default");
  });

  it("parse JSON lines, pretty JSON and report bad lines", () => {
    const lines = parseSamples('{"a":1}\n\n{"b":2}\nnot json\n[1]');
    expect(lines.samples).toEqual([{ a: 1 }, { b: 2 }]);
    expect(lines.lines).toEqual([1, 3]);
    expect(lines.errors.map((error) => error.line)).toEqual([4, 5]);
    const pretty = parseSamples('[\n  {"a": 1},\n  {"b": 2}\n]');
    expect(pretty.samples).toHaveLength(2);
    expect(pretty.errors).toEqual([]);
    const capped = parseSamples(
      Array.from({ length: 22 }, () => "{}").join("\n"),
    );
    expect(capped.samples).toHaveLength(20);
    expect(capped.errors).toHaveLength(2);
  });
});

describe("event diff", () => {
  it("reports added, changed and removed leaves in VRL path syntax", () => {
    const changes = diffEvents(
      { message: "raw", host: "a", nested: { keep: 1, drop: 2 } },
      { message: "parsed", status: 503, nested: { keep: 1 }, "odd key": true },
    );
    expect(changes).toEqual([
      { path: ".message", kind: "changed", before: "raw", after: "parsed" },
      { path: '."odd key"', kind: "added", after: true },
      { path: ".status", kind: "added", after: 503 },
      { path: ".host", kind: "removed", before: "a" },
      { path: ".nested.drop", kind: "removed", before: 2 },
    ]);
    expect([...flattenEvent({ list: [1, 2], empty: {} }).keys()]).toEqual([
      ".list",
      ".empty",
    ]);
    expect(displayValue("2026-01-01T00:00:00Z", true)).toBe(
      "t'2026-01-01T00:00:00Z'",
    );
  });
});

describe("unit tests from samples", () => {
  const parse = { type: "remap", source: ". = parse_json!(.message)" };
  it("asserts every output field and treats timestamps as types", () => {
    const result: SampleResult = {
      sample: 0,
      outcome: "emitted",
      outputs: [
        {
          port: "",
          event: {
            status: 503,
            ok: false,
            at: "2026-01-01T00:00:00Z",
            tags: ["a"],
            "x y": 'q"\n',
          },
          timestamps: ["at"],
        },
      ],
    };
    const test = unitTestFromSample({
      componentId: "parse",
      component: parse,
      sample: { message: "{}" },
      result,
      name: "parse: sample 1",
      existing: [{ name: "parse: sample 1" }],
    });
    expect(test.name).toBe("parse: sample 1 (2)");
    expect(test.inputs).toEqual([
      { insert_at: "parse", type: "log", log_fields: { message: "{}" } },
    ]);
    expect(test.outputs[0].extract_from).toBe("parse");
    expect(test.outputs[0].conditions[0].source.split("\n")).toEqual([
      "assert_eq!(.status, 503)",
      "assert_eq!(.ok, false)",
      'assert!(is_timestamp(.at), message: ".at should be a timestamp")',
      'assert_eq!(.tags, ["a"])',
      'assert_eq!(."x y", "q\\"\\n")',
    ]);
  });

  it("maps errors, aborts and routing to the step's real behavior", () => {
    const base = {
      componentId: "parse",
      sample: { message: "bad" },
      name: "t",
    };
    const error: SampleResult = {
      sample: 0,
      outcome: "error",
      outputs: [],
      message: "failed",
    };
    // drop_on_error defaults to false: Vector passes the original event through.
    const passes = unitTestFromSample({
      ...base,
      component: parse,
      result: error,
    });
    expect(passes.outputs[0].conditions[0].source).toBe(
      'assert_eq!(.message, "bad")',
    );
    const dropped = unitTestFromSample({
      ...base,
      component: { ...parse, drop_on_error: true },
      result: error,
    });
    expect(dropped.no_outputs_from).toEqual(["parse"]);
    const aborted = unitTestFromSample({
      ...base,
      component: parse,
      result: { ...error, outcome: "aborted" },
    });
    expect(aborted.no_outputs_from).toEqual(["parse"]);
    const route = { type: "route", route: { errors: "true", ok: "false" } };
    const routed = unitTestFromSample({
      ...base,
      componentId: "by_status",
      component: route,
      result: {
        sample: 0,
        outcome: "emitted",
        outputs: [{ port: "errors", event: { a: 1 }, timestamps: [] }],
      },
    });
    expect(routed.outputs[0].extract_from).toBe("by_status.errors");
    const unmatched = unitTestFromSample({
      ...base,
      componentId: "by_status",
      component: { ...route, reroute_unmatched: false },
      result: { sample: 0, outcome: "unmatched", outputs: [] },
    });
    expect(unmatched.no_outputs_from).toEqual([
      "by_status.errors",
      "by_status.ok",
    ]);
  });

  it("writes valid VRL literals", () => {
    expect(vrlString("a\tb\u0001")).toBe('"a\\tb\\u{1}"');
    expect(vrlLiteral({ a: [1, null], b: "x" })).toBe(
      '{"a": [1, null], "b": "x"}',
    );
    expect(assertionsFor({})).toBe("true");
  });
});

describe("epoch nanoseconds and other big integers", () => {
  const response =
    '{"output":{"ns":1790669601180123456,"ms":1790669601180,"n":1.5}}';
  it("keep their exact digits through display, diff and saved tests", () => {
    const { output } = parseLosslessJSON(response);
    expect(output.ms).toBe(1790669601180);
    expect(JSON.stringify(output)).toBe(
      '{"ns":1790669601180123456,"ms":1790669601180,"n":1.5}',
    );
    expect(displayValue(output.ns)).toBe("1790669601180123456");
    expect([...flattenEvent(output).keys()]).toEqual([".ns", ".ms", ".n"]);
    expect(eventPaths([output])).toEqual([".ms", ".n", ".ns"]);
    expect(diffEvents({ ns: 1 }, output)[0]).toMatchObject({
      path: ".ns",
      kind: "changed",
    });
    expect(assertionsFor(output).split("\n")[0]).toBe(
      "assert_eq!(.ns, 1790669601180123456)",
    );
  });
  it("in samples are sent back exactly", () => {
    const parsed = parseSamples('{"id":18446744073709551615}');
    expect(parsed.errors).toEqual([]);
    expect(JSON.stringify(parsed.samples[0])).toBe(
      '{"id":18446744073709551615}',
    );
  });
});

describe("sample sets follow the source", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  });
  it("open on the events a source emits, and replace an untouched old default", () => {
    const events =
      '{"message":"<134>2 2026-09-29T08:45:37.562Z h app 1 ID1 - hi"}';
    expect(readSamples("u", "p", events).sets[0].text).toBe(events);
    // The old built-in example, saved untouched, is refreshed...
    writeSamples("u", "p", emptyStore(DEFAULT_SAMPLE));
    expect(readSamples("u", "p", events).sets[0].text).toBe(events);
    // ...but anything the person wrote is kept.
    writeSamples("u", "p", emptyStore('{"mine":true}'));
    expect(readSamples("u", "p", events).sets[0].text).toBe('{"mine":true}');
    // No fitting events: the store opens empty rather than red.
    expect(readSamples("u", "q", "").sets[0].text).toBe("");
  });
});
