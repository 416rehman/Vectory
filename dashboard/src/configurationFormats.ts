import YAML from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configurationDiff, differencePath } from "./configurationDiff";
import { assertExactNumbers } from "./configurationNumbers";

/** A pipeline reads in the order events flow: sources, transforms, sinks. */
const sectionOrder = ["sources", "transforms", "sinks"];
/** What follows the pipeline in a file, in this order, after everything else. */
const trailingSections = ["tests"];
const componentSections = new Set(sectionOrder);
const leadingKeys = ["type", "inputs"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Each step reads "type", then "inputs", then its settings in their order.
function orderComponent(value: unknown) {
  if (!isRecord(value)) return value;
  return Object.fromEntries([
    ...leadingKeys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
    ...Object.entries(value).filter(([key]) => !leadingKeys.includes(key)),
  ]);
}

function orderSection(key: string, value: unknown) {
  if (!componentSections.has(key) || !isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([id, component]) => [
      id,
      orderComponent(component),
    ]),
  );
}

// `key = "multi\nline"` becomes a literal block TOML reads back unchanged.
const basicStringLine =
  /^(\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*")\s*=\s*)"((?:[^"\\\n]|\\.)*)"\s*$/;

function literalBlocks(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const match = basicStringLine.exec(line);
      if (!match || !match[2].includes("\\n")) return line;
      let decoded: string;
      try {
        decoded = JSON.parse(`"${match[2]}"`) as string;
      } catch {
        return line;
      }
      // Literal strings cannot hold ''' or control characters other than tab
      // and newline, and a trailing quote would merge into the delimiter.
      if (
        decoded.includes("'''") ||
        decoded.endsWith("'") ||
        /[\u0000-\u0008\u000b-\u001f\u007f]/.test(decoded)
      )
        return line;
      return `${match[1]}'''\n${decoded}'''`;
    })
    .join("\n");
}

export function stringifyConfiguration(
  value: Record<string, unknown>,
  format: string,
): string {
  assertExactNumbers(value);
  // The pipeline's sections in flow order lead; global options and anything
  // else follow in their own order, and the pipeline tests come last. Nested
  // values and unknown settings keep their order.
  const rest = (key: string) =>
    !sectionOrder.includes(key) && !trailingSections.includes(key);
  const ordered = Object.fromEntries([
    ...sectionOrder
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, orderSection(key, value[key])]),
    ...Object.entries(value).filter(([key]) => rest(key)),
    ...trailingSections
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  ]);
  if (format === "json") return JSON.stringify(ordered, null, 2);
  if (format !== "toml") return YAML.stringify(ordered);
  // The TOML writer puts root assignments before the tables, where their
  // scope is the whole file, whatever order they are given in.
  const text = stringifyToml(ordered);
  // TOML has no null value. The serializer can omit unsupported object values
  // without throwing, so verify the complete semantic document before use.
  const changes = configurationDiff(value, parseToml(text));
  if (changes.length)
    throw Error(
      `TOML cannot preserve ${differencePath(changes[0].path)}. Use JSON or YAML to keep every value.`,
    );
  // Multi-line programs read better as literal blocks, and one blank line
  // between tables is enough; keep each only when TOML parses it back to the
  // same document.
  let result = text;
  for (const tidy of [
    literalBlocks,
    (current: string) => current.replace(/\n{3,}/g, "\n\n"),
  ]) {
    const next = tidy(result);
    if (next === result) continue;
    try {
      if (!configurationDiff(value, parseToml(next)).length) result = next;
    } catch {
      // Keep the previous, verified text.
    }
  }
  return result;
}

/**
 * Whether configuration text has comments of its own. The editor stores the
 * pipeline as data, so they are not kept when code is applied. Text inside
 * strings (such as `#` lines in a VRL program) is content, not a comment.
 */
export function hasSourceComments(text: string, format: string): boolean {
  if (format === "json" || !text.includes("#")) return false;
  if (format === "toml") {
    let multiline: string | null = null;
    for (const line of text.split("\n")) {
      let quote: string | null = null;
      for (let index = 0; index < line.length; index++) {
        const rest = line.slice(index);
        if (multiline) {
          if (rest.startsWith(multiline)) {
            index += 2;
            multiline = null;
          } else if (multiline === '"""' && line[index] === "\\") index++;
          continue;
        }
        if (quote) {
          if (quote === '"' && line[index] === "\\") index++;
          else if (line[index] === quote) quote = null;
          continue;
        }
        if (rest.startsWith("'''") || rest.startsWith('"""')) {
          multiline = rest.slice(0, 3);
          index += 2;
        } else if (line[index] === '"' || line[index] === "'")
          quote = line[index];
        else if (line[index] === "#") return true;
      }
    }
    return false;
  }
  try {
    const document = YAML.parseDocument(text);
    if (document.commentBefore || document.comment) return true;
    let found = false;
    YAML.visit(document, (_key, node) => {
      const commented = node as { commentBefore?: string; comment?: string };
      if (commented?.commentBefore || commented?.comment) {
        found = true;
        return YAML.visit.BREAK;
      }
    });
    return found;
  } catch {
    return false;
  }
}
