import type { Config } from "./api";

const SECTIONS = ["sources", "transforms", "sinks", "enrichment_tables"];
const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);
// Options whose text is a VRL program or condition, by what they are called.
const programs: Record<string, string> = {
  source: "VRL",
  condition: "condition",
  route: "routes",
  routes: "routes",
};

function componentChange(before: Config, after: Config): string | null {
  if (same(before, after)) return null;
  if (before?.type !== after?.type)
    return `now ${typeof after?.type === "string" ? after.type : "untyped"}`;
  const keys = [
    ...new Set([...Object.keys(before || {}), ...Object.keys(after || {})]),
  ].filter((key) => key !== "type" && !same(before?.[key], after?.[key]));
  const words: string[] = [];
  for (const key of keys)
    if (programs[key] && !words.includes(programs[key]))
      words.push(programs[key]);
  const options = keys.filter((key) => !programs[key] && key !== "inputs");
  if (options.length === 1) words.push(options[0]);
  else if (options.length > 1) words.push(`${options.length} options`);
  const text = words.length ? `${words.join(", ")} changed` : "";
  return keys.includes("inputs")
    ? text
      ? `${text}, rewired`
      : "rewired"
    : text;
}

/**
 * A short account of how a draft differs from the saved one, used as the
 * default note of a saved revision: "parse: VRL changed; + archive (aws_s3)".
 */
export function draftSummary(
  before: Config,
  after: Config,
  beforeVariables: unknown[] = [],
  afterVariables: unknown[] = [],
  limit = 160,
): string {
  const changed: string[] = [],
    added: string[] = [],
    removed: string[] = [];
  for (const section of SECTIONS) {
    const old = record(before?.[section]) ? before[section] : {};
    const next = record(after?.[section]) ? after[section] : {};
    for (const [id, component] of Object.entries(next)) {
      if (!Object.hasOwn(old, id)) {
        const type = record(component) ? component.type : undefined;
        added.push(
          typeof type === "string" && type !== id
            ? `+ ${id} (${type})`
            : `+ ${id}`,
        );
        continue;
      }
      const change = componentChange(old[id], component);
      if (change) changed.push(`${id}: ${change}`);
    }
    for (const id of Object.keys(old))
      if (!Object.hasOwn(next, id)) removed.push(`− ${id}`);
  }
  const pipeline: string[] = [];
  const globalKeys = new Set(
    [...Object.keys(before || {}), ...Object.keys(after || {})].filter(
      (key) => !SECTIONS.includes(key),
    ),
  );
  const tests =
    globalKeys.delete("tests") && !same(before?.tests, after?.tests);
  if ([...globalKeys].some((key) => !same(before?.[key], after?.[key])))
    pipeline.push("pipeline settings changed");
  if (tests) {
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    const delta = count(after?.tests) - count(before?.tests);
    pipeline.push(
      delta > 0
        ? `+ ${delta} ${delta === 1 ? "test" : "tests"}`
        : delta < 0
          ? `− ${-delta} ${delta === -1 ? "test" : "tests"}`
          : "tests changed",
    );
  }
  if (!same(beforeVariables, afterVariables))
    pipeline.push("variables changed");
  const parts = [...changed, ...added, ...removed, ...pipeline];
  if (!parts.length) return "No configuration changes";
  let summary = "";
  for (const [index, part] of parts.entries()) {
    const next = summary ? `${summary}; ${part}` : part;
    const rest = parts.length - index - 1;
    const suffix = rest ? `; ${rest} more` : "";
    if (next.length + suffix.length > limit && summary)
      return `${summary}; ${parts.length - index} more`;
    summary = next;
  }
  return summary;
}
