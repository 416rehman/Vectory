import { describe, expect, it } from "vitest";
import { configurationDiff, differencePath } from "./configurationDiff";

describe("configuration history comparison", () => {
  it("finds values exchanged between components even when every YAML line exists on both sides", () => {
    const before = {
      transforms: { first: { rate: 10 }, second: { rate: 20 } },
    };
    const after = { transforms: { first: { rate: 20 }, second: { rate: 10 } } };
    expect(configurationDiff(before, after)).toEqual([
      {
        path: ["transforms", "first", "rate"],
        kind: "changed",
        before: 10,
        after: 20,
      },
      {
        path: ["transforms", "second", "rate"],
        kind: "changed",
        before: 20,
        after: 10,
      },
    ]);
  });
  it("ignores object property order but preserves array order and types", () => {
    expect(configurationDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
    expect(configurationDiff(["a", "b", 1], ["b", "a", "1"])).toHaveLength(3);
  });
  it("distinguishes omission, null, empty strings and removed array entries", () => {
    expect(
      configurationDiff(
        { a: null, b: "", inputs: ["one", "two"] },
        { b: null, c: "", inputs: ["one"] },
      ),
    ).toEqual([
      { path: ["a"], kind: "removed", before: null },
      { path: ["b"], kind: "changed", before: "", after: null },
      { path: ["c"], kind: "added", after: "" },
      { path: ["inputs", 1], kind: "removed", before: "two" },
    ]);
  });
  it("compares unknown objects, multiline programs and unusual keys without mutation", () => {
    const before = { extension: { "route.a/b": { source: ".a = 1\n.b = 2" } } };
    const after = { extension: { "route.a/b": { source: ".a = 2\n.b = 1" } } };
    const original = JSON.stringify(before);
    const [change] = configurationDiff(before, after);
    expect(differencePath(change.path)).toBe('extension["route.a/b"].source');
    expect(change.before).not.toEqual(change.after);
    expect(JSON.stringify(before)).toBe(original);
  });
});
