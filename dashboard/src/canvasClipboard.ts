import type { Config } from "./api";
import type { Kind } from "./catalog";
import { stringifyConfiguration } from "./configurationFormats";
import { guessConfigurationFormat, parseSource } from "./configurationSource";

const SECTIONS: Kind[] = ["sources", "transforms", "sinks"];
const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
const reference = (input: string) => input.split(".")[0];

/**
 * The selected steps as Vector configuration, each with its inputs as they
 * are. Pasting into the same pipeline keeps a step reading from the same
 * upstream steps; pasting elsewhere drops inputs that don't exist there.
 */
export function copySteps(config: Config, ids: Iterable<string>): Config {
  const chosen = new Set(ids);
  const copy: Config = {};
  for (const section of SECTIONS)
    for (const [id, component] of Object.entries(config[section] || {})) {
      if (!chosen.has(id) || !record(component)) continue;
      (copy[section] ??= {})[id] = structuredClone(component);
    }
  return copy;
}

/** Copied steps as Vector YAML for the clipboard. */
export function stepsText(steps: Config) {
  return stringifyConfiguration(steps, "yaml");
}

export type PastedSteps = {
  config: Config;
  /** Pasted step IDs, old name → name in the pipeline. */
  ids: Map<string, string>;
  kinds: Map<string, Kind>;
};

/**
 * Add the steps in Vector configuration text (YAML, TOML or JSON) to a
 * pipeline. Taken IDs get a `_copy` suffix, and inputs between pasted steps
 * follow the new names. Throws when the text holds no steps.
 */
export function pasteSteps(config: Config, text: string): PastedSteps {
  const parsed = parseSource(text, guessConfigurationFormat(text));
  const taken = new Set(
    [...SECTIONS, "enrichment_tables"].flatMap((section) =>
      Object.keys(config[section] || {}),
    ),
  );
  const ids = new Map<string, string>(),
    kinds = new Map<string, Kind>();
  for (const section of SECTIONS)
    for (const id of Object.keys(
      record(parsed[section]) ? parsed[section] : {},
    )) {
      if (!record(parsed[section][id])) continue;
      let name = taken.has(id) ? `${id}_copy` : id,
        number = 2;
      while (taken.has(name)) name = `${id}_copy_${number++}`;
      taken.add(name);
      ids.set(id, name);
      kinds.set(name, section);
    }
  if (!ids.size)
    throw Error(
      "The clipboard has no Vector steps. Copy steps from a pipeline or a Vector configuration.",
    );
  const next = structuredClone(config);
  for (const section of SECTIONS)
    for (const [id, component] of Object.entries(
      record(parsed[section]) ? parsed[section] : {},
    )) {
      if (!record(component)) continue;
      const value = structuredClone(component);
      if (Array.isArray(value.inputs))
        value.inputs = value.inputs.flatMap((input: unknown) => {
          if (typeof input !== "string") return [];
          const renamed = ids.get(reference(input));
          if (renamed) return [renamed + input.slice(reference(input).length)];
          // Keep a reference that this pipeline can satisfy; drop the rest.
          return taken.has(reference(input)) && !ids.has(reference(input))
            ? [input]
            : [];
        });
      (next[section] ??= {})[ids.get(id)!] = value;
    }
  return { config: next, ids, kinds };
}
