import { describe, expect, it } from "vitest";
import {
  historyDifferenceLines,
  historyDifferenceTotals,
  type HistoryDifferenceLine,
} from "./historyDiff";

const changed = (before: unknown, after: unknown) =>
  historyDifferenceLines({
    path: ["settings"],
    kind: "changed",
    before,
    after,
  });
function reconstructed(
  lines: HistoryDifferenceLine[],
  side: "before" | "after",
) {
  return lines
    .filter((line) => line.kind !== (side === "before" ? "added" : "removed"))
    .map((line) => line.text)
    .join("\n");
}

describe("Git-style configuration value line differences", () => {
  it("shows a changed setting with surrounding JSON context and independent line numbers", () => {
    const lines = changed(
      { batch: { max_events: 10, timeout: 2 }, enabled: true },
      { enabled: true, batch: { timeout: 2, max_events: 20 } },
    );
    expect(lines).toEqual([
      { kind: "context", text: "{", beforeLine: 1, afterLine: 1 },
      { kind: "context", text: '  "batch": {', beforeLine: 2, afterLine: 2 },
      { kind: "removed", text: '    "max_events": 10,', beforeLine: 3 },
      { kind: "added", text: '    "max_events": 20,', afterLine: 3 },
      {
        kind: "context",
        text: '    "timeout": 2',
        beforeLine: 4,
        afterLine: 4,
      },
      { kind: "context", text: "  },", beforeLine: 5, afterLine: 5 },
      {
        kind: "context",
        text: '  "enabled": true',
        beforeLine: 6,
        afterLine: 6,
      },
      { kind: "context", text: "}", beforeLine: 7, afterLine: 7 },
    ]);
    expect(historyDifferenceTotals(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("distinguishes an absent side, actual null, empty string, and different primitive types", () => {
    expect(
      historyDifferenceLines({
        path: ["namespace"],
        kind: "added",
        after: null,
      }),
    ).toEqual([{ kind: "added", text: "null", afterLine: 1 }]);
    expect(
      historyDifferenceLines({
        path: ["namespace"],
        kind: "removed",
        before: "",
      }),
    ).toEqual([{ kind: "removed", text: '""', beforeLine: 1 }]);
    expect(changed(null, "null")).toEqual([
      { kind: "removed", text: "null", beforeLine: 1 },
      { kind: "added", text: '"null"', afterLine: 1 },
    ]);
    expect(changed(undefined, false)).toEqual([
      { kind: "added", text: "false", afterLine: 1 },
    ]);
    expect(historyDifferenceTotals(changed(10, "10"))).toEqual({
      added: 1,
      removed: 1,
    });
  });

  it("renders all lines for wholly added and removed objects", () => {
    const value = { path: "/var/log/*.log", exclude: [] };
    const added = historyDifferenceLines({
      path: ["sources", "logs"],
      kind: "added",
      after: value,
    });
    const removed = historyDifferenceLines({
      path: ["sources", "logs"],
      kind: "removed",
      before: value,
    });
    expect(
      added.every(
        (line) => line.kind === "added" && line.beforeLine === undefined,
      ),
    ).toBe(true);
    expect(
      removed.every(
        (line) => line.kind === "removed" && line.afterLine === undefined,
      ),
    ).toBe(true);
    expect(added.map((line) => line.afterLine)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(reconstructed(added, "after"))).toEqual(value);
    expect(JSON.parse(reconstructed(removed, "before"))).toEqual(value);
  });

  it("ignores nested object insertion order without mutating either input", () => {
    const before = { zebra: [{ z: 2, a: 1 }], alpha: { second: 2, first: 1 } };
    const after = { alpha: { first: 1, second: 2 }, zebra: [{ a: 1, z: 2 }] };
    const original = JSON.stringify(before);
    const lines = changed(before, after);
    expect(lines.every((line) => line.kind === "context")).toBe(true);
    expect(historyDifferenceTotals(lines)).toEqual({ added: 0, removed: 0 });
    expect(JSON.stringify(before)).toBe(original);
    expect(lines[1].text).toBe('  "alpha": {');
  });

  it("preserves array ordering, repeated values, and shifted line numbers", () => {
    const before = ["alpha", "beta", "alpha", "omega"];
    const after = ["beta", "alpha", "alpha", "new", "omega"];
    const lines = changed(before, after);
    expect(JSON.parse(reconstructed(lines, "before"))).toEqual(before);
    expect(JSON.parse(reconstructed(lines, "after"))).toEqual(after);
    expect(historyDifferenceTotals(lines).added).toBeGreaterThan(0);
    expect(historyDifferenceTotals(lines).removed).toBeGreaterThan(0);
    expect(lines.at(-1)).toEqual({
      kind: "context",
      text: "]",
      beforeLine: 6,
      afterLine: 7,
    });
  });

  it("compares programs line by line, keeping escaped and trailing newlines distinct", () => {
    const before = '.a = 1\n.b = "x"\n',
      after = '.a = 1\\n.b = "x"\n';
    const lines = changed(before, after);
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["removed", ".a = 1"],
      ["removed", '.b = "x"'],
      ["added", '.a = 1\\n.b = "x"'],
      ["context", ""],
    ]);
    expect(reconstructed(lines, "before")).toBe(before);
    expect(reconstructed(lines, "after")).toBe(after);
    const edited = changed(".a = 1\n.b = 2", ".a = 1\n.b = 3\n.c = 4");
    expect(edited.filter((line) => line.kind !== "context")).toEqual([
      expect.objectContaining({ kind: "removed", text: ".b = 2" }),
      expect.objectContaining({ kind: "added", text: ".b = 3" }),
      expect.objectContaining({ kind: "added", text: ".c = 4" }),
    ]);
    expect(changed(".a = 1\n", ".a = 1").map((line) => line.kind)).toEqual([
      "context",
      "removed",
    ]);
  });

  it("falls back to complete replacement for large values instead of truncating their data", () => {
    const before = { retained: "x".repeat(140_000), value: 1 };
    const after = { retained: before.retained, value: 2 };
    const lines = changed(before, after);
    expect(lines.every((line) => line.kind !== "context")).toBe(true);
    expect(JSON.parse(reconstructed(lines, "before"))).toEqual(before);
    expect(JSON.parse(reconstructed(lines, "after"))).toEqual(after);
    expect(historyDifferenceTotals(lines)).toEqual({ added: 4, removed: 4 });
    expect(
      historyDifferenceTotals(
        changed(before, { value: 1, retained: before.retained }),
      ),
    ).toEqual({ added: 0, removed: 0 });
  });

  it("bounds high-edit-distance comparisons and retains every old/new array entry", () => {
    const before = Array.from(
      { length: 2100 },
      (_, index) => `before-${index}`,
    );
    const after = before.map((_, index) => `after-${index}`);
    const lines = changed(before, after);
    expect(historyDifferenceTotals(lines)).toEqual({
      added: 2102,
      removed: 2102,
    });
    expect(JSON.parse(reconstructed(lines, "before"))).toEqual(before);
    expect(JSON.parse(reconstructed(lines, "after"))).toEqual(after);
  });

  it("rejects unsafe numbers and non-JSON data without silently dropping values", () => {
    for (const value of [9007199254740992, Infinity, NaN])
      expect(() => changed({ value }, {})).toThrow(
        "cannot be represented exactly",
      );
    expect(() => changed({ hidden: undefined }, {})).toThrow(
      "JSON cannot represent",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => changed(circular, {})).toThrow("circular reference");
    const unusual = JSON.parse(
      '{"__proto__":{"safe":true},"constructor":null}',
    );
    expect(JSON.parse(reconstructed(changed({}, unusual), "after"))).toEqual(
      unusual,
    );
  });
});
