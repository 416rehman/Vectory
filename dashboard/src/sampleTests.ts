import type { Config } from "./api";
import { isExactInteger } from "./configurationNumbers";
import { flattenEvent } from "./eventDiff";

/** One sample's run through a step, as returned by `POST /vrl/test`. */
export type SampleOutcome =
  "emitted" | "filtered" | "unmatched" | "dropped" | "error" | "aborted";
export type SampleResult = {
  sample: number;
  outcome: SampleOutcome;
  outputs: {
    port: string;
    event: Record<string, unknown>;
    timestamps: string[];
  }[];
  message?: string;
  line?: number;
  column?: number;
  length?: number;
};

/** VRL string literal: escapes quotes, backslashes and control characters. */
export function vrlString(text: string) {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u{${code.toString(16)}}`;
    else out += character;
  }
  return `${out}"`;
}

/** A JSON value as a VRL literal. */
export function vrlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return vrlString(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  if (isExactInteger(value)) return value.rawJSON;
  if (Array.isArray(value)) return `[${value.map(vrlLiteral).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${vrlString(key)}: ${vrlLiteral(item)}`)
    .join(", ")}}`;
}

/**
 * Assertions describing an output event. Timestamps become `is_timestamp`
 * checks so values such as `now()` don't make the test flaky.
 */
export function assertionsFor(
  event: Record<string, unknown>,
  timestamps: readonly string[] = [],
  limit = 40,
  omittedPaths: ReadonlySet<string> = new Set(),
) {
  const stamped = new Set(
    timestamps.map((path) => (path.startsWith(".") ? path : `.${path}`)),
  );
  const lines: string[] = [];
  for (const [path, value] of flattenEvent(event)) {
    if (omittedPaths.has(path)) continue;
    if (lines.length >= limit) break;
    lines.push(
      stamped.has(path)
        ? `assert!(is_timestamp(${path}), message: ${vrlString(`${path} should be a timestamp`)})`
        : `assert_eq!(${path}, ${vrlLiteral(value)})`,
    );
  }
  return lines.length ? lines.join("\n") : "true";
}

const reference = (id: string, port: string) => (port ? `${id}.${port}` : id);

function uniqueName(tests: readonly Config[], base: string) {
  const names = new Set(tests.map((test) => test?.name));
  let name = base.slice(0, 120),
    number = 2;
  while (names.has(name)) name = `${base.slice(0, 114)} (${number++})`;
  return name;
}

/**
 * A native Vector `tests` entry for one sample. The expectation follows the
 * step's real settings: the tester runs remap with drops observable, so an
 * error or abort maps back to what `drop_on_error`/`drop_on_abort` do.
 */
export function unitTestFromSample({
  componentId,
  component,
  sample,
  result,
  name,
  existing = [],
  omitOutputPaths = [],
}: {
  componentId: string;
  component: Config;
  sample: Record<string, unknown>;
  result: SampleResult;
  name: string;
  existing?: readonly Config[];
  omitOutputPaths?: readonly (readonly string[])[];
}): Config {
  const outputs: Config[] = [];
  let noOutputs: string[] | undefined;
  const passthrough = () =>
    outputs.push({
      extract_from: componentId,
      conditions: [{ type: "vrl", source: assertionsFor(sample) }],
    });
  switch (result.outcome) {
    case "emitted":
      for (const [index, output] of result.outputs.entries())
        outputs.push({
          extract_from: reference(componentId, output.port),
          conditions: [
            {
              type: "vrl",
              source: assertionsFor(
                output.event,
                output.timestamps,
                40,
                new Set(omitOutputPaths[index]),
              ),
            },
          ],
        });
      break;
    case "error":
      if (component.drop_on_error === true) noOutputs = [componentId];
      else passthrough();
      break;
    case "aborted":
      if (component.drop_on_abort === false) passthrough();
      else noOutputs = [componentId];
      break;
    default:
      noOutputs =
        component.type === "route"
          ? [
              ...Object.keys(component.route || {}),
              ...(component.reroute_unmatched === false ? [] : ["_unmatched"]),
            ].map((port) => reference(componentId, port))
          : [componentId];
  }
  return {
    name: uniqueName(existing, name),
    inputs: [{ insert_at: componentId, type: "log", log_fields: sample }],
    ...(outputs.length ? { outputs } : {}),
    ...(noOutputs ? { no_outputs_from: noOutputs } : {}),
  };
}

const volatileCall =
  /\b(?:now|uuid_v4|uuid_v7|random_[A-Za-z0-9_]+|get_hostname|get_env_var|get_timezone_name)!?\s*\(/;
const pathSegment = '(?:[A-Za-z_@][\\w@]*|"(?:\\\\.|[^"\\\\])*")';
const pathPattern = `\\.${pathSegment}(?:\\.${pathSegment}|\\[-?\\d+\\])*`;
const pathAssignment = new RegExp(
  `^\\s*(${pathPattern})(?:\\s*,\\s*[A-Za-z_]\\w*)?\\s*=(?!=)\\s*(.*)$`,
);
const variableAssignment =
  /^\s*([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)?\s*=(?!=)\s*(.*)$/;
const pathReference = new RegExp(pathPattern, "g");

function canonicalPath(path: string) {
  return path.replace(/\.("(?:\\.|[^"\\])*")/g, (_whole, literal: string) => {
    try {
      const key = JSON.parse(literal) as string;
      return `.${/^[A-Za-z_@][\w@]*$/.test(key) ? key : JSON.stringify(key)}`;
    } catch {
      return `.${literal}`;
    }
  });
}

/** Hide strings and comments so function names in sample text do not count. */
function expressionCode(expression: string) {
  let code = "";
  let quote = "";
  let escaped = false;
  let comment = false;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (character === "\n") {
      code += "\n";
      comment = false;
      continue;
    }
    if (comment) {
      code += " ";
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      code += " ";
      continue;
    }
    if (character === "#") {
      comment = true;
      code += " ";
    } else if (character === '"' || character === "'") {
      quote = character;
      code += " ";
    } else code += character;
  }
  return code;
}

function bracketDepth(code: string) {
  return [...code].reduce(
    (level, character) =>
      level +
      ("([{".includes(character) ? 1 : 0) -
      (")]}".includes(character) ? 1 : 0),
    0,
  );
}

const overlappingPaths = (left: string, right: string) =>
  left === right ||
  left.startsWith(`${right}.`) ||
  left.startsWith(`${right}[`) ||
  right.startsWith(`${left}.`) ||
  right.startsWith(`${left}[`);

function referencesVolatile(
  expression: string,
  code: string,
  paths: readonly string[],
  variables: ReadonlySet<string>,
) {
  for (const match of expression.matchAll(pathReference)) {
    const offset = match.index;
    if (
      code[offset] !== "." ||
      (offset > 0 && /[\w@%]/.test(expression[offset - 1]))
    )
      continue;
    const reference = canonicalPath(match[0]);
    if (paths.some((path) => overlappingPaths(reference, path))) return true;
  }
  for (const match of code.matchAll(/[A-Za-z_]\w*/g)) {
    const offset = match.index;
    if (
      variables.has(match[0]) &&
      (offset === 0 || !/[\w.@%]/.test(code[offset - 1]))
    )
      return true;
  }
  return false;
}

/** VRL assignments fed by run-dependent calls or earlier volatile values. */
function volatileAssignedPaths(component: Config) {
  if (component.type !== "remap" || typeof component.source !== "string")
    return [];
  const lines = component.source.split("\n");
  const paths: string[] = [];
  const variables = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const field = pathAssignment.exec(lines[index]);
    const match = field || variableAssignment.exec(lines[index]);
    if (!match) continue;
    let expression = match[2];
    let code = expressionCode(expression);
    let depth = bracketDepth(code);
    while ((depth > 0 || !code.trim()) && index + 1 < lines.length) {
      expression += `\n${lines[++index]}`;
      code = expressionCode(expression);
      depth = bracketDepth(code);
    }
    if (
      volatileCall.test(code) ||
      referencesVolatile(expression, code, paths, variables)
    ) {
      if (field) paths.push(canonicalPath(match[1]));
      else variables.add(match[1]);
    }
  }
  return paths;
}

type SampleCase = {
  sample: Record<string, unknown>;
  result: SampleResult;
  name: string;
};

/** Rerun the exact step inputs before turning observed output into a test. */
export async function unitTestsFromSamples({
  componentId,
  component,
  cases,
  existing = [],
  rerun,
}: {
  componentId: string;
  component: Config;
  cases: readonly SampleCase[];
  existing?: readonly Config[];
  rerun: (samples: Record<string, unknown>[]) => Promise<SampleResult[]>;
}): Promise<{ tests: Config[]; omittedPaths: string[] }> {
  if (!cases.length) return { tests: [], omittedPaths: [] };
  const repeated = await rerun(cases.map(({ sample }) => sample));
  if (repeated.length !== cases.length)
    throw new Error(
      "The sample check returned an unexpected number of results. Run the samples again before saving tests.",
    );
  const assigned = volatileAssignedPaths(component);
  const omitted = new Set<string>();
  const tests: Config[] = [];
  for (const [index, item] of cases.entries()) {
    const next = repeated[index];
    if (
      !next ||
      next.outcome !== item.result.outcome ||
      next.outputs.length !== item.result.outputs.length ||
      next.outputs.some(
        (output, outputIndex) =>
          output.port !== item.result.outputs[outputIndex].port,
      )
    )
      throw new Error(
        `Sample ${index + 1} changed its outcome or output port between runs. Run it again before saving a test.`,
      );
    const omitOutputPaths = item.result.outputs.map((output, outputIndex) => {
      const first = flattenEvent(output.event);
      const second = flattenEvent(next.outputs[outputIndex].event);
      const paths: string[] = [];
      for (const [path, value] of first) {
        if (
          !second.has(path) ||
          JSON.stringify(value) !== JSON.stringify(second.get(path)) ||
          assigned.some((assignment) => overlappingPaths(path, assignment))
        ) {
          paths.push(path);
          omitted.add(path);
        }
      }
      return paths;
    });
    tests.push(
      unitTestFromSample({
        componentId,
        component,
        sample: item.sample,
        result: item.result,
        name: item.name,
        existing: [...existing, ...tests],
        omitOutputPaths,
      }),
    );
  }
  return { tests, omittedPaths: [...omitted] };
}
