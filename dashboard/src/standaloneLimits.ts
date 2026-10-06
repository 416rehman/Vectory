import type { Config } from "./api";
import { memoryComponents, outputPorts } from "./catalog";
import { stringifyConfiguration } from "./configurationFormats";
import {
  MAX_CONFIGURATION_BYTES,
  type ConfigurationFormat,
} from "./configurationSource";
import { MAX_PATTERN_EDGES, patternInputs } from "./inputPatterns";

const MAX_GRAPH_COMPONENTS = 500;
const MAX_GRAPH_CONNECTIONS = 2000;
const MAX_GRAPH_OUTPUTS = 2000;
const MAX_COMPONENT_OUTPUTS = 128;

/** Bound the actual rendered graph, including implicit nodes and named ports. */
export function graphIsTooLarge(config: Config): boolean {
  const components = memoryComponents(config).map((entry) => entry.component);
  for (const kind of ["sources", "transforms", "sinks"] as const) {
    const section = config[kind];
    if (section && typeof section === "object" && !Array.isArray(section))
      components.push(...(Object.values(section) as Config[]));
  }
  if (components.length > MAX_GRAPH_COMPONENTS) return true;

  let connections = 0;
  let outputs = 0;
  for (const component of components) {
    if (!component || typeof component !== "object" || Array.isArray(component))
      continue;
    connections += Array.isArray(component.inputs)
      ? component.inputs.length
      : 0;
    const ports = outputPorts(component).length;
    outputs += ports;
    if (
      connections > MAX_GRAPH_CONNECTIONS ||
      outputs > MAX_GRAPH_OUTPUTS ||
      ports > MAX_COMPONENT_OUTPUTS
    )
      return true;
  }
  // Count wildcard edges before rendering them. The port guard above also
  // bounds the candidate set used to expand those wildcard patterns.
  for (const pattern of patternInputs(config)) {
    connections += Math.min(MAX_PATTERN_EDGES, pattern.matches.length);
    if (connections > MAX_GRAPH_CONNECTIONS) return true;
  }
  return false;
}

/** Reject an oversized conversion before the caller replaces its source. */
export function renderBoundedConfiguration(
  config: Config,
  format: ConfigurationFormat,
): string {
  const rendered = stringifyConfiguration(config, format);
  if (new TextEncoder().encode(rendered).length > MAX_CONFIGURATION_BYTES)
    throw Error(
      "The converted configuration exceeds the 1 MiB limit. Your current configuration and export remain unchanged.",
    );
  return rendered;
}
