import type { Config } from "./api";
import { isInputPattern, outputPorts } from "./catalog";

type Token =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "char"; value: string }
  | { kind: "set"; negated: boolean; ranges: [string, string][] };

/** Whether an input uses glob characters (as opposed to only a device variable). */
export const isGlobInput = (input: string) => /[*?[]/.test(input);

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  const chars = [...pattern];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char === "*") {
      // Consecutive stars match the same text as one.
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
    } else if (char === "?") tokens.push({ kind: "any" });
    else if (char === "[") {
      let end = index + 1;
      if (chars[end] === "!" || chars[end] === "^") end++;
      if (chars[end] === "]") end++;
      while (end < chars.length && chars[end] !== "]") end++;
      if (end >= chars.length) tokens.push({ kind: "char", value: "[" });
      else {
        const body = chars.slice(index + 1, end);
        const negated = body[0] === "!" || body[0] === "^";
        const members = negated ? body.slice(1) : body;
        const ranges: [string, string][] = [];
        for (let at = 0; at < members.length; at++) {
          if (members[at + 1] === "-" && at + 2 < members.length) {
            ranges.push([members[at], members[at + 2]]);
            at += 2;
          } else ranges.push([members[at], members[at]]);
        }
        tokens.push({ kind: "set", negated, ranges });
        index = end;
      }
    } else tokens.push({ kind: "char", value: char });
  }
  return tokens;
}

function tokenMatches(token: Token, char: string) {
  switch (token.kind) {
    case "any":
      return true;
    case "char":
      return token.value === char;
    case "set": {
      const inside = token.ranges.some(
        ([low, high]) => char >= low && char <= high,
      );
      return inside !== token.negated;
    }
    default:
      return false;
  }
}

/**
 * Glob matching as Vector applies it to component names: `*` any run of
 * characters, `?` one character, `[abc]` or `[!a-z]` one of a set. Linear
 * backtracking only ever revisits the last star, so a hostile pattern cannot
 * stall the editor.
 */
export function globMatch(pattern: string, text: string) {
  if (pattern.length > 256) return false;
  const tokens = tokenize(pattern);
  const chars = [...text];
  let t = 0,
    p = 0,
    star = -1,
    resume = 0;
  while (t < chars.length) {
    const token = tokens[p];
    if (token?.kind === "star") {
      star = p++;
      resume = t;
    } else if (token && tokenMatches(token, chars[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else return false;
  }
  while (tokens[p]?.kind === "star") p++;
  return p === tokens.length;
}

export type PatternMatch = {
  /** Component that produces the matching output. */
  id: string;
  /** Output name; "output" is the default output. */
  port: string;
  /** The reference as written in an `inputs` list. */
  reference: string;
};
export type PatternInput = {
  /** The step whose `inputs` holds the pattern. */
  target: string;
  pattern: string;
  matches: PatternMatch[];
};

const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
const SECTIONS = ["sources", "transforms"] as const;

/** Every output a pattern can name: `id` for a default output, `id.port` for a named one. */
function candidates(config: Config): PatternMatch[] {
  const found: PatternMatch[] = [];
  for (const section of SECTIONS)
    for (const [id, component] of Object.entries(
      record(config[section]) ? config[section] : {},
    )) {
      if (!record(component)) continue;
      for (const port of outputPorts(component)) {
        found.push({
          id,
          port,
          reference: port === "output" ? id : `${id}.${port}`,
        });
      }
    }
  return found;
}

/**
 * The wildcard inputs in a pipeline and the outputs each one matches now.
 * Vector resolves patterns on each device, so this is a preview of the same
 * matching against the steps in this draft.
 */
export function patternInputs(config: Config): PatternInput[] {
  let outputs: PatternMatch[] | null = null;
  const found: PatternInput[] = [];
  for (const section of ["transforms", "sinks"] as const)
    for (const [target, component] of Object.entries(
      record(config[section]) ? config[section] : {},
    )) {
      if (!record(component) || !Array.isArray(component.inputs)) continue;
      for (const input of component.inputs) {
        if (typeof input !== "string" || !isGlobInput(input)) continue;
        if (found.some((f) => f.target === target && f.pattern === input))
          continue;
        outputs ??= candidates(config);
        found.push({
          target,
          pattern: input,
          matches: outputs.filter(
            (output) =>
              output.id !== target && globMatch(input, output.reference),
          ),
        });
      }
    }
  return found;
}

/** Derived, display-only connections for the canvas: one per matched output. */
export type PatternEdge = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: "input";
  pattern: string;
  /** Matches beyond the drawn limit, on the last edge only. */
  more: number;
};
export const MAX_PATTERN_EDGES = 24;

export function patternEdges(inputs: readonly PatternInput[]): PatternEdge[] {
  return inputs.flatMap((input) => {
    const shown = input.matches.slice(0, MAX_PATTERN_EDGES);
    return shown.map((match, index) => ({
      id: `pattern:${encodeURIComponent(JSON.stringify([input.pattern, input.target, match.reference]))}`,
      source: match.id,
      sourceHandle: match.port,
      target: input.target,
      targetHandle: "input" as const,
      pattern: input.pattern,
      more:
        index === shown.length - 1 ? input.matches.length - shown.length : 0,
    }));
  });
}

const names = (matches: readonly PatternMatch[]) => {
  const list = matches.map((match) => match.reference);
  const shown = list.slice(0, 4);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1
    ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
    : shown[0];
};

/** One sentence about a pattern, for the inspector: what it matches today. */
export function patternSummary(input: PatternInput) {
  return input.matches.length
    ? `${input.pattern} matches ${names(input.matches)}. Vector resolves the pattern on each device.`
    : `${input.pattern} matches no step in this pipeline yet.`;
}

/**
 * The warning for a wildcard that matches nothing. Vector refuses such a
 * pattern unless `wildcard_matching` is relaxed.
 */
export function unmatchedPatternMessage(
  input: PatternInput,
  config: Config,
): { message: string; hint: string } {
  const relaxed = config.wildcard_matching === "relaxed";
  return {
    message: `${input.pattern} matches no step in this pipeline.`,
    hint: relaxed
      ? "The pipeline still runs; the step reads nothing until a matching step exists."
      : "Vector refuses a pattern that matches nothing. Add a matching step, or set wildcard_matching to relaxed.",
  };
}

export { isInputPattern };
