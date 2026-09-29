import YAML from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configurationDiff, differencePath } from "./configurationDiff";
import { assertExactNumbers } from "./configurationNumbers";

const sectionOrder = ["api", "sources", "transforms", "sinks"];
const componentSections = new Set(["sources", "transforms", "sinks"]);
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
  // Order only the document's sections; retain nested values and unknown settings.
  const ordered = Object.fromEntries([
    ...sectionOrder
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, orderSection(key, value[key])]),
    ...Object.entries(value).filter(([key]) => !sectionOrder.includes(key)),
  ]);
  if (format === "json") return JSON.stringify(ordered, null, 2);
  if (format !== "toml") return YAML.stringify(ordered);
  // TOML root assignments must precede table sections to retain their scope.
  const text = stringifyToml(ordered);
  // TOML has no null value. The serializer can omit unsupported object values
  // without throwing, so verify the complete semantic document before use.
  const changes = configurationDiff(value, parseToml(text));
  if (changes.length)
    throw Error(
      `TOML cannot preserve ${differencePath(changes[0].path)}. Use JSON or YAML to keep every value.`,
    );
  // Multi-line programs read better as literal blocks; keep them only when
  // TOML parses them back to the same document.
  const literal = literalBlocks(text);
  if (literal === text) return text;
  try {
    if (!configurationDiff(value, parseToml(literal)).length) return literal;
  } catch {
    // Fall back to the serializer's quoted strings.
  }
  return text;
}
