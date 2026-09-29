import type { Config, Graph } from "./api";
import {
  connectionEdgeId,
  isInputPattern,
  memoryComponents,
  outputPorts,
  validateGraph,
  type Kind,
} from "./catalog";

import {
  pipelineNodeHeight,
  PIPELINE_NODE_COLUMN_GAP,
} from "./pipelineNodeModel";

const kinds: Kind[] = ["sources", "transforms", "sinks"];

/** Compatible with React Flow connections and edges; edge IDs disambiguate imported duplicates. */
export type PipelineConnection = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  id?: string;
};

type ConnectionComponent = {
  kind: Kind;
  component: Config;
};

function connectionComponent(config: Config, id: string): ConnectionComponent {
  const entries: ConnectionComponent[] = kinds.flatMap((kind) =>
    Object.hasOwn(config[kind] || {}, id)
      ? [{ kind, component: config[kind][id] }]
      : [],
  );
  entries.push(...memoryComponents(config).filter((entry) => entry.id === id));
  if (entries.length !== 1)
    throw Error(
      entries.length
        ? "This component ID is ambiguous."
        : "This component no longer exists.",
    );
  const entry = entries[0];
  if (
    !entry.component ||
    typeof entry.component !== "object" ||
    Array.isArray(entry.component)
  )
    throw Error("This component has an invalid configuration.");
  return entry;
}

function previousInput(config: Config, previous: PipelineConnection) {
  if ((previous.targetHandle ?? "input") !== "input")
    throw Error("Choose the component input handle.");
  const { component } = connectionComponent(config, previous.target);
  const inputs: unknown[] = Array.isArray(component.inputs)
    ? component.inputs
    : [];
  const matches = inputs.flatMap((reference, index) => {
    if (typeof reference !== "string" || isInputPattern(reference)) return [];
    const dot = reference.indexOf(".");
    const source = dot < 0 ? reference : reference.slice(0, dot);
    const handle = dot < 0 ? "output" : reference.slice(dot + 1);
    return source === previous.source &&
      handle === (previous.sourceHandle ?? "output") &&
      (previous.id === undefined ||
        previous.id === connectionEdgeId(reference, previous.target, index))
      ? [{ reference, index }]
      : [];
  });
  if (!matches.length)
    throw Error("This connection no longer exists. Select it again.");
  if (matches.length > 1)
    throw Error("Select the exact connection to edit this repeated input.");
  return { component, ...matches[0] };
}

/** Resolve a selection before removing any indexed inputs; preserve duplicates and patterns outside it. */
export function disconnect(
  config: Config,
  previous: PipelineConnection | readonly PipelineConnection[],
): Config {
  const next = structuredClone(config);
  const removals = new Map<Config, Set<number>>();
  for (const connection of Array.isArray(previous)
    ? previous
    : [previous as PipelineConnection]) {
    const old = previousInput(next, connection);
    const indices = removals.get(old.component) || new Set<number>();
    indices.add(old.index);
    removals.set(old.component, indices);
  }
  for (const [component, indices] of removals)
    for (const index of [...indices].sort((a, b) => b - a))
      component.inputs.splice(index, 1);
  return next;
}

function replaceConnection(
  config: Config,
  connection: PipelineConnection,
  previous?: PipelineConnection,
): Config {
  const next = structuredClone(config);
  const old = previous ? previousInput(next, previous) : undefined;
  const source = connectionComponent(next, connection.source);
  const target = connectionComponent(next, connection.target);
  if (
    typeof source.component.type !== "string" ||
    typeof target.component.type !== "string"
  )
    throw Error("Choose components with a configured type.");
  if (
    source.kind === "sinks" ||
    target.kind === "sources" ||
    connection.source === connection.target
  )
    throw Error("Connect a source or transform to a transform or sink.");
  if ((connection.targetHandle ?? "input") !== "input")
    throw Error("Choose the component input handle.");
  const handle = connection.sourceHandle ?? "output";
  if (!outputPorts(source.component).includes(handle))
    throw Error("This output no longer exists. Choose an available output.");
  // Route outputs are always named, even when a route happens to be named "output".
  const namedOnly = ["route", "exclusive_route"].includes(
    source.component.type,
  );
  const reference =
    handle === "output" && !namedOnly
      ? connection.source
      : `${connection.source}.${handle}`;
  if (isInputPattern(reference))
    throw Error("Edit wildcard or dynamic inputs in Code view.");
  if (
    target.component.inputs !== undefined &&
    !Array.isArray(target.component.inputs)
  )
    throw Error("The destination inputs must be a list before connecting.");
  if (
    old &&
    previous!.source === connection.source &&
    previous!.target === connection.target &&
    (previous!.sourceHandle ?? "output") === handle
  )
    return config;

  if (old) old.component.inputs.splice(old.index, 1);
  const inputs: unknown[] = target.component.inputs ?? [];
  if (inputs.includes(reference))
    throw Error("This connection already exists.");
  target.component.inputs = [...inputs];
  if (old && previous!.target === connection.target)
    target.component.inputs.splice(old.index, 0, reference);
  else target.component.inputs.push(reference);

  const before = new Set(validateGraph(config));
  const failure = validateGraph(next).find(
    (message) =>
      message.startsWith("Cycle") ||
      message ===
        `${connection.target}: incompatible event types from ${reference}` ||
      (!before.has(message) &&
        message.includes(": incompatible event types from ")),
  );
  if (failure) throw Error(failure);
  return next;
}

/** The same strict operation used by connection previews; never normalizes unrelated inputs. */
export function connectConnection(
  config: Config,
  connection: PipelineConnection,
): Config {
  return replaceConnection(config, connection);
}

/** Validate and replace an edge atomically. Rejected replacements leave the original config intact. */
export function reconnect(
  config: Config,
  previous: PipelineConnection,
  replacement: PipelineConnection,
): Config {
  return replaceConnection(config, replacement, previous);
}

export function canConnect(
  config: Config,
  connection: PipelineConnection,
  previous?: PipelineConnection,
): boolean {
  try {
    replaceConnection(config, connection, previous);
    return true;
  } catch {
    return false;
  }
}

export function componentName(
  config: Config,
  requested: string,
  before?: string,
  forbidden: string[] = [],
): string {
  const after = requested.trim();
  if (
    !after ||
    new TextEncoder().encode(after).length > 128 ||
    after.includes(".")
  )
    throw Error("Use a name of 1–128 bytes without periods.");
  const used = [
    ...kinds.flatMap((kind) => Object.keys(config[kind] || {})),
    ...memoryComponents(config).map((entry) => entry.id),
  ];
  if (forbidden.includes(after) || (after !== before && used.includes(after)))
    throw Error("A component with this name already exists.");
  return after;
}

/** Rename references, never event fields, VRL source, templates or wildcard expressions. */
export function renameComponent(
  config: Config,
  before: string,
  requested: string,
): Config {
  const after = componentName(config, requested, before);
  const kind = kinds.find((section) =>
    Object.hasOwn(config[section] || {}, before),
  );
  if (!kind) throw Error("This component no longer exists.");
  if (before === after) return config;
  const next = structuredClone(config);
  next[kind] = Object.fromEntries(
    Object.entries(next[kind]).map(([id, value]) => [
      id === before ? after : id,
      value,
    ]),
  );
  return retargetReferences(next, before, after);
}

export function retargetReferences(
  config: Config,
  before: string,
  after: string,
): Config {
  const next = structuredClone(config);
  const reference = (value: unknown) =>
    typeof value === "string" && !isInputPattern(value)
      ? value === before
        ? after
        : value.startsWith(before + ".")
          ? after + value.slice(before.length)
          : value
      : value;
  for (const section of ["transforms", "sinks", "enrichment_tables"])
    for (const component of Object.values(next[section] || {}) as Config[])
      if (Array.isArray(component?.inputs))
        component.inputs = component.inputs.map(reference);
  for (const test of Array.isArray(next.tests) ? next.tests : []) {
    if (!test || typeof test !== "object") continue;
    if (test.input && typeof test.input === "object")
      test.input.insert_at = reference(test.input.insert_at);
    for (const input of Array.isArray(test.inputs) ? test.inputs : [])
      if (input && typeof input === "object")
        input.insert_at = reference(input.insert_at);
    for (const output of Array.isArray(test.outputs) ? test.outputs : [])
      if (output && typeof output === "object")
        output.extract_from = reference(output.extract_from);
    if (Array.isArray(test.no_outputs_from))
      test.no_outputs_from = test.no_outputs_from.map(reference);
  }
  return next;
}

/** Stable left-to-right layers. All destinations share a column; sweeps reduce crossings. */
export function arrangeGraph(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>(),
    children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    parents.set(edge.target, [
      ...(parents.get(edge.target) || []),
      edge.source,
    ]);
    children.set(edge.source, [
      ...(children.get(edge.source) || []),
      edge.target,
    ]);
  }
  const depths = new Map<string, number>(),
    active = new Set<string>();
  function depth(id: string): number {
    if (depths.has(id)) return depths.get(id)!;
    if (active.has(id)) return 0;
    active.add(id);
    const incoming = parents.get(id) || [];
    const result = incoming.length
      ? Math.max(...incoming.map(depth)) + 1
      : byId.get(id)?.data.kind === "sources"
        ? 0
        : 1;
    active.delete(id);
    depths.set(id, result);
    return result;
  }
  graph.nodes.forEach((node) => depth(node.id));
  const last = Math.max(
    1,
    ...graph.nodes
      .filter((node) => node.data.kind !== "sinks")
      .map((node) => depths.get(node.id)! + 1),
  );
  const layers = new Map<number, any[]>();
  for (const node of graph.nodes) {
    const rank = node.data.kind === "sinks" ? last : depths.get(node.id)!;
    depths.set(node.id, rank);
    layers.set(rank, [...(layers.get(rank) || []), node]);
  }
  const ranks = [...layers.keys()].sort((a, b) => a - b);
  const height = (node: any) => pipelineNodeHeight(node.data);
  const centers = () => {
    const values = new Map<string, number>();
    for (const nodes of layers.values()) {
      const total = nodes.reduce((sum, node) => sum + height(node) + 66, -66);
      let y = -total / 2;
      for (const node of nodes) {
        values.set(node.id, y + height(node) / 2);
        y += height(node) + 66;
      }
    }
    return values;
  };
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    for (const rank of forward ? ranks : [...ranks].reverse()) {
      const positions = centers(),
        nodes = layers.get(rank)!;
      const original = new Map(nodes.map((node, index) => [node.id, index]));
      const average = (id: string) => {
        const related = (forward ? parents : children).get(id) || [];
        return related.length
          ? related.reduce((sum, n) => sum + (positions.get(n) || 0), 0) /
              related.length
          : positions.get(id) || 0;
      };
      nodes.sort(
        (a, b) =>
          average(a.id) - average(b.id) ||
          original.get(a.id)! - original.get(b.id)!,
      );
    }
  }
  const positions = centers();
  const top = Math.min(
    0,
    ...graph.nodes.map((node) => positions.get(node.id)! - height(node) / 2),
  );
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: {
        x: 70 + depths.get(node.id)! * PIPELINE_NODE_COLUMN_GAP,
        y: positions.get(node.id)! - height(node) / 2 - top + 70,
      },
    })),
  };
}
