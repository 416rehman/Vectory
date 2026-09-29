import type { Config } from "./api";
import {
  isInputPattern,
  memoryComponents,
  outputPorts,
  exactOutputTypes,
  type Kind,
} from "./catalog";

export const NO_DESTINATION_WARNING =
  "This branch has no path to a destination. Connect an output to use its events.";

const record = (value: unknown): value is Config =>
  !!value && typeof value === "object" && !Array.isArray(value);
type Entry = { id: string; kind: Kind; component: Config; advisory: boolean };

/** Advisory reachability only: never changes validation, config, or stored graph. */
export function pipelineConnectivity(config: Config): Map<string, string> {
  const warnings = new Map<string, string>();
  if (!record(config) || config.provider != null) return warnings;
  const entries: Entry[] = [];
  for (const kind of ["sources", "transforms", "sinks"] as const)
    for (const [id, component] of Object.entries(
      record(config[kind]) ? config[kind] : {},
    ))
      if (record(component) && typeof component.type === "string")
        entries.push({ id, kind, component, advisory: kind !== "sinks" });
  // A memory table consumes events independently of its optional export source.
  // Do not invent an edge from the table to that source or warn about its use.
  for (const entry of memoryComponents({
    ...config,
    enrichment_tables: record(config.enrichment_tables)
      ? config.enrichment_tables
      : {},
  }))
    entries.push({ ...entry, advisory: false });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) return warnings; // ambiguous IDs already have graph errors
  const parents = new Map<string, Set<string>>(),
    portsBySource = new Map<string, Set<string>>(),
    uncertainConsumers = new Set<string>();
  for (const consumer of entries) {
    if (consumer.kind === "sources") continue;
    for (const input of Array.isArray(consumer.component.inputs)
      ? consumer.component.inputs
      : []) {
      if (typeof input !== "string" || !input) continue;
      if (isInputPattern(input)) {
        uncertainConsumers.add(consumer.id);
        continue;
      }
      const dot = input.indexOf("."),
        source = byId.get(dot < 0 ? input : input.slice(0, dot));
      if (!source) {
        // Native/custom builds can register outputs not represented as nodes.
        // Treat unresolved references as unknown rather than guessing a match.
        uncertainConsumers.add(consumer.id);
        continue;
      }
      if (source.kind === "sinks") continue;
      const namedOnly = ["route", "exclusive_route"].includes(
        source.component.type,
      );
      if (exactOutputTypes.has(source.component.type) || namedOnly) {
        let ports = portsBySource.get(source.id);
        if (!ports) {
          ports = new Set(outputPorts(source.component));
          portsBySource.set(source.id, ports);
        }
        // "output" is the UI handle for an unnamed default. Only route-style
        // components can have a native named branch literally called output.
        if (dot < 0) {
          if (namedOnly || !ports.has("output")) continue;
        } else {
          const port = input.slice(dot + 1);
          if (!ports.has(port) || (port === "output" && !namedOnly)) continue;
        }
      }
      const incoming = parents.get(consumer.id) || new Set<string>();
      incoming.add(source.id);
      parents.set(consumer.id, incoming);
    }
  }
  const reached = new Set<string>(),
    queue = entries
      .filter((entry) => entry.kind === "sinks")
      .map((entry) => entry.id);
  let expandedUncertainty = false;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (reached.has(id)) continue;
    reached.add(id);
    for (const parent of parents.get(id) || []) queue.push(parent);
    if (uncertainConsumers.has(id) && !expandedUncertainty) {
      expandedUncertainty = true;
      // Conservative over-approximation, not a Vector glob implementation.
      // Expanding once keeps the walk linear even with many dynamic inputs.
      for (const entry of entries)
        if (entry.kind !== "sinks") queue.push(entry.id);
    }
  }
  for (const entry of entries)
    if (entry.advisory && !reached.has(entry.id))
      warnings.set(entry.id, NO_DESTINATION_WARNING);
  return warnings;
}
