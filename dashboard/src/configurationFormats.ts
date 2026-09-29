import YAML from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configurationDiff, differencePath } from "./configurationDiff";
import { assertExactNumbers } from "./configurationNumbers";

const sectionOrder = ["api", "sources", "transforms", "sinks"];

export function stringifyConfiguration(
  value: Record<string, unknown>,
  format: string,
): string {
  assertExactNumbers(value);
  // Order only the document's sections; retain nested values and unknown settings.
  const ordered = Object.fromEntries([
    ...sectionOrder
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
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
  return text;
}
