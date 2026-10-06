import { diffLines } from "diff";
import type { Difference } from "./configurationDiff";
import { assertExactNumbers } from "./configurationNumbers";

export type HistoryDifferenceLine = {
  kind: "added" | "removed" | "context";
  text: string;
  /** One-based line within this field's formatted JSON value, not the whole document. */
  beforeLine?: number;
  afterLine?: number;
};

const MAX_DIFF_CHARACTERS = 262_144;
const MAX_EDIT_LENGTH = 2_000;
const DIFF_TIMEOUT_MS = 50;

/** Canonical display order only: array order and every JSON value remain unchanged. */
function formattedValue(value: unknown): string {
  if (value === undefined) return "";
  const active = new Set<object>();
  function normalize(item: unknown, depth: number): unknown {
    if (depth > 256)
      throw Error("This history value is too deeply nested to compare.");
    if (item === null || ["string", "number", "boolean"].includes(typeof item))
      return item;
    if (typeof item !== "object")
      throw Error(
        "This history value contains data that JSON cannot represent.",
      );
    if (active.has(item))
      throw Error("This history value contains a circular reference.");
    active.add(item);
    let normalized: unknown;
    if (Array.isArray(item)) {
      // Array.from also checks sparse entries rather than silently converting them to null.
      normalized = Array.from(item, (entry) => normalize(entry, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw Error("This history value is not a JSON object.");
      normalized = Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [
            key,
            normalize((item as Record<string, unknown>)[key], depth + 1),
          ]),
      );
    }
    active.delete(item);
    return normalized;
  }
  const normalized = normalize(value, 0);
  assertExactNumbers(normalized, "history value");
  // Every present JSON value has at least one line, including null and "".
  return JSON.stringify(normalized, null, 2) + "\n";
}

/** Complete, value-local unified diff. Expensive comparisons fall back to full replacement. */
/**
 * Whether a change is a program (multi-line text such as VRL). Programs
 * compare line by line as written, not as one escaped JSON string.
 */
export function isProgramDifference(difference: Difference) {
  const sides = [difference.before, difference.after];
  return (
    sides.some((side) => typeof side === "string" && side.includes("\n")) &&
    sides.every((side) => side === undefined || typeof side === "string")
  );
}

export function historyDifferenceLines(
  difference: Difference,
): HistoryDifferenceLine[] {
  const program = isProgramDifference(difference);
  // Each program line becomes a diff line; the added line break keeps a
  // trailing newline (or its absence) visible as its own line.
  const format = (value: unknown) =>
    program
      ? `${(value as string | undefined) ?? ""}\n`
      : formattedValue(value);
  const before = difference.kind === "added" ? "" : format(difference.before);
  const after = difference.kind === "removed" ? "" : format(difference.after);
  const changes =
    before === after
      ? [{ value: before, added: false, removed: false }]
      : before.length + after.length <= MAX_DIFF_CHARACTERS
        ? diffLines(before, after, {
            timeout: DIFF_TIMEOUT_MS,
            maxEditLength: MAX_EDIT_LENGTH,
          })
        : undefined;
  const complete = changes ?? [
    ...(before ? [{ value: before, removed: true, added: false }] : []),
    ...(after ? [{ value: after, removed: false, added: true }] : []),
  ];
  let beforeLine = 1,
    afterLine = 1;
  const lines: HistoryDifferenceLine[] = [];
  for (const change of complete) {
    const texts = change.value.split("\n");
    if (texts.at(-1) === "") texts.pop();
    for (const text of texts) {
      const kind = change.added
        ? "added"
        : change.removed
          ? "removed"
          : "context";
      lines.push({
        kind,
        text,
        ...(!change.added ? { beforeLine: beforeLine++ } : {}),
        ...(!change.removed ? { afterLine: afterLine++ } : {}),
      });
    }
  }
  return lines;
}

export function historyDifferenceTotals(
  lines: readonly HistoryDifferenceLine[],
): {
  added: number;
  removed: number;
} {
  return lines.reduce(
    (counts, line) => {
      if (line.kind === "added") counts.added++;
      else if (line.kind === "removed") counts.removed++;
      return counts;
    },
    { added: 0, removed: 0 },
  );
}
