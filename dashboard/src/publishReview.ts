import { diffLines } from "diff";
import type { Config } from "./api";

const SECTIONS = ["sources", "transforms", "sinks", "enrichment_tables"];
const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
/**
 * Semantic equality of configuration values: key order never matters (the
 * server returns sorted keys, a draft keeps insertion order), a missing key
 * equals an undefined one, and `inputs` is a set.
 */
export function sameValue(a: unknown, b: unknown, key?: string): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (key === "inputs" && a.every((item) => typeof item === "string")) {
      const sorted = (list: unknown[]) => [...(list as string[])].sort();
      return sameValue(sorted(a), sorted(b));
    }
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (record(a) && record(b)) {
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (!sameValue(a[name], b[name], name)) return false;
    return true;
  }
  return false;
}
const same = (a: unknown, b: unknown, key?: string) => sameValue(a, b, key);

/** Distance from a source: upstream steps sort before the steps they feed. */
function depths(...configs: (Config | null)[]) {
  const inputs = new Map<string, string[]>();
  for (const config of configs)
    for (const section of SECTIONS) {
      const components = record(config?.[section]) ? config![section] : {};
      for (const [id, component] of Object.entries(components))
        if (!inputs.has(id))
          inputs.set(
            id,
            record(component) && Array.isArray(component.inputs)
              ? component.inputs.filter(
                  (input: unknown): input is string =>
                    typeof input === "string",
                )
              : [],
          );
    }
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    let deepest = 0;
    for (const input of inputs.get(id) ?? []) {
      // `route.errors` is the `errors` output of `route`.
      const upstream = inputs.has(input)
        ? input
        : input.replace(/\.[^.]*$/, "");
      if (inputs.has(upstream))
        deepest = Math.max(deepest, depth(upstream, seen) + 1);
    }
    seen.delete(id);
    memo.set(id, deepest);
    return deepest;
  };
  return (id: string) => depth(id, new Set());
}
const PROGRAM_KEYS = new Set(["source", "condition", "route", "routes"]);

/** VRL programs and conditions of a component, by option path. */
export function componentPrograms(component: unknown): Map<string, string> {
  const programs = new Map<string, string>();
  if (!record(component)) return programs;
  const text = (value: unknown) =>
    typeof value === "string"
      ? value
      : record(value) && typeof value.source === "string"
        ? value.source
        : null;
  if (typeof component.source === "string")
    programs.set("source", component.source);
  const condition = text(component.condition);
  if (condition !== null) programs.set("condition", condition);
  if (record(component.route))
    for (const [name, value] of Object.entries(component.route)) {
      const program = text(value);
      if (program !== null) programs.set(`route.${name}`, program);
    }
  if (Array.isArray(component.routes))
    component.routes.forEach((route: unknown, index: number) => {
      const program = record(route) ? text(route.condition) : null;
      if (program !== null) programs.set(`routes.${index}.condition`, program);
    });
  return programs;
}

export function programLabel(path: string) {
  if (path === "source") return "VRL program";
  if (path === "condition") return "Condition";
  const route = /^route\.(.+)$/.exec(path);
  if (route) return `Route ${route[1]}`;
  const exclusive = /^routes\.(\d+)\.condition$/.exec(path);
  return exclusive ? `Route ${Number(exclusive[1]) + 1}` : path;
}

/** A value short enough to show inline: text up to 24 characters, a number, a flag. */
const short = (value: unknown) =>
  value === undefined ||
  value === null ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (typeof value === "string" && value.length <= 24 && !value.includes("\n"));
export function shortValue(value: unknown) {
  return value === undefined ? "unset" : JSON.stringify(value);
}

export type ProgramChange = {
  path: string;
  label: string;
  before: string;
  after: string;
};
export type ComponentChange = {
  id: string;
  section: string;
  type: string;
  change: "added" | "removed" | "changed";
  /** Changed options other than programs and inputs. */
  options: string[];
  /** Before and after for options whose values are short scalars. */
  values: Record<string, { before: unknown; after: unknown }>;
  programs: ProgramChange[];
  rewired: boolean;
};
export type ReviewChanges = {
  components: ComponentChange[];
  /** Pipeline-wide options that changed (global options, secrets, provider). */
  settings: string[];
  tests: { before: number; after: number } | null;
};

/** What publishing this draft changes compared with a published version. */
export function reviewChanges(
  before: Config | null,
  after: Config,
): ReviewChanges {
  const components: ComponentChange[] = [];
  for (const section of SECTIONS) {
    const old = record(before?.[section]) ? before![section] : {};
    const next = record(after?.[section]) ? after[section] : {};
    for (const [id, component] of Object.entries(next)) {
      const type =
        record(component) && typeof component.type === "string"
          ? component.type
          : "";
      if (!Object.hasOwn(old, id)) {
        components.push({
          id,
          section,
          type,
          change: "added",
          options: [],
          values: {},
          programs: [...componentPrograms(component)].map(([path, text]) => ({
            path,
            label: programLabel(path),
            before: "",
            after: text,
          })),
          rewired: false,
        });
        continue;
      }
      const previous = old[id];
      if (same(previous, component)) continue;
      const keys = [
        ...new Set([
          ...Object.keys(record(previous) ? previous : {}),
          ...Object.keys(record(component) ? component : {}),
        ]),
      ].filter((key) => !same(previous?.[key], component?.[key], key));
      const beforePrograms = componentPrograms(previous),
        afterPrograms = componentPrograms(component);
      const programs: ProgramChange[] = [];
      for (const path of new Set([
        ...beforePrograms.keys(),
        ...afterPrograms.keys(),
      ])) {
        const was = beforePrograms.get(path) ?? "",
          now = afterPrograms.get(path) ?? "";
        if (was !== now)
          programs.push({
            path,
            label: programLabel(path),
            before: was,
            after: now,
          });
      }
      const options = keys.filter(
        (key) => !PROGRAM_KEYS.has(key) && key !== "inputs",
      );
      components.push({
        id,
        section,
        type,
        change: "changed",
        options,
        values: Object.fromEntries(
          options.flatMap((key) =>
            short(previous?.[key]) && short(component?.[key])
              ? [[key, { before: previous?.[key], after: component?.[key] }]]
              : [],
          ),
        ),
        programs,
        rewired: keys.includes("inputs"),
      });
    }
    for (const [id, component] of Object.entries(old))
      if (!Object.hasOwn(next, id))
        components.push({
          id,
          section,
          type:
            record(component) && typeof component.type === "string"
              ? component.type
              : "",
          change: "removed",
          options: [],
          values: {},
          programs: [],
          rewired: false,
        });
  }
  // Source to sink: sections in pipeline order, then upstream steps first.
  const depth = depths(after, before);
  const order = new Map(
    components.map((component, index) => [component, index]),
  );
  components.sort(
    (a, b) =>
      SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) ||
      depth(a.id) - depth(b.id) ||
      order.get(a)! - order.get(b)!,
  );
  const settings = [
    ...new Set([...Object.keys(before || {}), ...Object.keys(after || {})]),
  ].filter(
    (key) =>
      !SECTIONS.includes(key) &&
      key !== "tests" &&
      !same(before?.[key], after?.[key]),
  );
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  const tests = same(before?.tests, after?.tests)
    ? null
    : { before: count(before?.tests), after: count(after?.tests) };
  return { components, settings, tests };
}

export type ChangeGroup =
  | { kind: "step"; component: ComponentChange }
  | {
      kind: "group";
      change: "added" | "removed";
      section: string;
      components: ComponentChange[];
    };

/**
 * The review's rows. Steps that changed always get their own row; a long run
 * of added or removed steps in one section folds into a single row with a
 * count ("36 sources added") that opens on demand.
 */
export function groupChanges(
  components: readonly ComponentChange[],
  threshold = 8,
): ChangeGroup[] {
  const runs = new Map<string, ComponentChange[]>();
  for (const component of components)
    if (component.change !== "changed") {
      const key = `${component.change}:${component.section}`;
      runs.set(key, [...(runs.get(key) ?? []), component]);
    }
  const rows: ChangeGroup[] = [];
  const emitted = new Set<string>();
  for (const component of components) {
    const key = `${component.change}:${component.section}`;
    const run = runs.get(key);
    if (component.change === "changed" || !run || run.length <= threshold)
      rows.push({ kind: "step", component });
    else if (!emitted.has(key)) {
      emitted.add(key);
      rows.push({
        kind: "group",
        change: component.change,
        section: component.section,
        components: run,
      });
    }
  }
  return rows;
}

const SECTION_NOUNS: Record<string, [string, string]> = {
  sources: ["source", "sources"],
  transforms: ["transform", "transforms"],
  sinks: ["destination", "destinations"],
  enrichment_tables: ["enrichment table", "enrichment tables"],
};
/** "36 sources", "1 destination". */
export function sectionCount(section: string, count: number) {
  const [one, many] = SECTION_NOUNS[section] ?? ["step", "steps"];
  return `${count} ${count === 1 ? one : many}`;
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Line diff of two programs; unchanged runs longer than `context` * 2 fold. */
export function programDiff(before: string, after: string, context = 2) {
  const lines: DiffLine[] = [];
  // Compare whole lines: a last line without a line break is still the same line.
  const text = (value: string) =>
    value && !value.endsWith("\n") ? `${value}\n` : value;
  for (const part of diffLines(text(before), text(after))) {
    const kind = part.added ? "added" : part.removed ? "removed" : "same";
    const texts = part.value.replace(/\n$/, "").split("\n");
    for (const text of texts) lines.push({ kind, text });
  }
  // Keep `context` unchanged lines around each change; fold the rest.
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let offset = -context; offset <= context; offset++)
      if (index + offset >= 0 && index + offset < lines.length)
        keep[index + offset] = true;
  });
  const result: (DiffLine | { kind: "fold"; count: number })[] = [];
  let folded = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (folded) result.push({ kind: "fold", count: folded });
      folded = 0;
      result.push(line);
    } else folded++;
  });
  if (folded) result.push({ kind: "fold", count: folded });
  return result;
}

type ReachDevice = {
  status?: string;
  desired_version_id?: string | null;
};

/**
 * Devices assigned a version of this pipeline, by version number. Verified
 * means the agent confirmed the assigned version is running.
 */
export function deviceReach(
  devices: readonly ReachDevice[],
  versions: readonly { id: string; number: number }[],
) {
  const numbers = new Map(
    versions.map((version) => [version.id, version.number]),
  );
  let assigned = 0,
    verified = 0;
  const byVersion = new Map<number, number>();
  for (const device of devices) {
    const number = device.desired_version_id
      ? numbers.get(device.desired_version_id)
      : undefined;
    if (number === undefined || device.status === "revoked") continue;
    assigned++;
    if (device.status === "verified") verified++;
    byVersion.set(number, (byVersion.get(number) || 0) + 1);
  }
  return {
    assigned,
    verified,
    versions: [...byVersion.entries()].sort((a, b) => b[0] - a[0]),
  };
}

export function reachLabel(reach: ReturnType<typeof deviceReach>) {
  if (!reach.assigned) return "Not assigned to any device yet.";
  const versions = reach.versions
    .map(([number, count]) =>
      reach.versions.length > 1 ? `v${number} ×${count}` : `v${number}`,
    )
    .join(", ");
  const devices =
    reach.assigned === 1 ? "1 device" : `${reach.assigned} devices`;
  const running =
    reach.verified === reach.assigned
      ? "all verified running"
      : `${reach.verified} verified running`;
  return `Assigned to ${devices} (${versions}) · ${running}.`;
}
