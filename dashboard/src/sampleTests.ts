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
) {
  const stamped = new Set(
    timestamps.map((path) => (path.startsWith(".") ? path : `.${path}`)),
  );
  const lines: string[] = [];
  for (const [path, value] of flattenEvent(event)) {
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
}: {
  componentId: string;
  component: Config;
  sample: Record<string, unknown>;
  result: SampleResult;
  name: string;
  existing?: readonly Config[];
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
      for (const output of result.outputs)
        outputs.push({
          extract_from: reference(componentId, output.port),
          conditions: [
            {
              type: "vrl",
              source: assertionsFor(output.event, output.timestamps),
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
