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
  nodeOutputPorts,
  pipelineNodeHeight,
  PIPELINE_NODE_COLUMN_GAP,
  PIPELINE_NODE_WIDTH,
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

/** Automatic layout lives in `canvasLayout.ts`; every caller imports it from here. */
export { arrangeGraph } from "./canvasLayout";

type PlacedNode = {
  id: string;
  position: { x: number; y: number };
  data: { kind?: Kind; component?: Config };
};
const ROW_GAP = 40;

/** Cards overlapping (or within half a row gap of) the card at `x`,`y`. */
function overlapping(
  nodes: readonly PlacedNode[],
  x: number,
  y: number,
  height: number,
) {
  return nodes.filter(
    (node) =>
      x < node.position.x + PIPELINE_NODE_WIDTH + ROW_GAP / 2 &&
      node.position.x < x + PIPELINE_NODE_WIDTH + ROW_GAP / 2 &&
      y < node.position.y + pipelineNodeHeight(node.data) + ROW_GAP / 2 &&
      node.position.y < y + height + ROW_GAP / 2,
  );
}
const bottom = (node: PlacedNode) =>
  node.position.y + pipelineNodeHeight(node.data);

/**
 * The first free spot at or below `preferred` where a new card overlaps no
 * existing card, so new steps never stack on top of each other.
 */
export function freePosition(
  nodes: readonly PlacedNode[],
  preferred: { x: number; y: number },
  height = pipelineNodeHeight({}),
) {
  let y = preferred.y;
  for (let tries = 0; tries < 200; tries++) {
    const blockers = overlapping(nodes, preferred.x, y, height);
    if (!blockers.length) break;
    y = Math.max(...blockers.map(bottom)) + ROW_GAP;
  }
  return { x: preferred.x, y };
}

export type BlockStep = {
  id: string;
  kind: Kind;
  component: Config;
  /** Where the step sat in the pipeline it came from, when known. */
  position?: { x: number; y: number };
};

/**
 * A layout for steps that have no positions: columns by distance from the
 * block's sources (following inputs between them), stacked in each column.
 * Positions are relative to the block's top-left corner.
 */
export function layoutBlock(steps: readonly BlockStep[]) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const visit = (step: BlockStep, seen: Set<string>): number => {
    const known = depth.get(step.id);
    if (known !== undefined) return known;
    if (seen.has(step.id)) return 0;
    seen.add(step.id);
    let deepest = -1;
    for (const input of Array.isArray(step.component.inputs)
      ? step.component.inputs
      : []) {
      const upstream = byId.get(String(input).split(".")[0]);
      if (upstream && upstream !== step)
        deepest = Math.max(deepest, visit(upstream, seen));
    }
    seen.delete(step.id);
    depth.set(step.id, deepest + 1);
    return deepest + 1;
  };
  const rows = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const step of steps) {
    const column = visit(step, new Set());
    const y = rows.get(column) ?? 0;
    positions.set(step.id, { x: column * PIPELINE_NODE_COLUMN_GAP, y });
    rows.set(
      column,
      y +
        pipelineNodeHeight({ kind: step.kind, component: step.component }) +
        ROW_GAP,
    );
  }
  return positions;
}

/**
 * Where a block of steps goes. The block keeps its own arrangement (steps
 * with known positions keep their spacing; the rest are laid out by flow)
 * and lands at `anchor`, moved down until it overlaps no existing card.
 */
export function placeBlock(
  existing: readonly PlacedNode[],
  steps: readonly BlockStep[],
  anchor: { x: number; y: number },
) {
  const relative = new Map<string, { x: number; y: number }>();
  if (steps.length && steps.every((step) => step.position)) {
    const left = Math.min(...steps.map((step) => step.position!.x)),
      top = Math.min(...steps.map((step) => step.position!.y));
    for (const step of steps)
      relative.set(step.id, {
        x: step.position!.x - left,
        y: step.position!.y - top,
      });
  } else for (const [id, at] of layoutBlock(steps)) relative.set(id, at);
  const cards = steps.map((step) => ({
    id: step.id,
    data: { kind: step.kind, component: step.component },
    position: relative.get(step.id)!,
  }));
  let dy = 0;
  for (let tries = 0; tries < 200; tries++) {
    let push = 0;
    for (const card of cards) {
      const blockers = overlapping(
        existing,
        anchor.x + card.position.x,
        anchor.y + dy + card.position.y,
        pipelineNodeHeight(card.data),
      );
      if (blockers.length)
        push = Math.max(
          push,
          Math.max(...blockers.map(bottom)) +
            ROW_GAP -
            (anchor.y + dy + card.position.y),
        );
    }
    if (!push) break;
    dy += push;
  }
  return new Map(
    cards.map((card) => [
      card.id,
      { x: anchor.x + card.position.x, y: anchor.y + dy + card.position.y },
    ]),
  );
}

/**
 * The reference a new step reads when it is added next to `node`: its
 * default output, or its first named output (a route's first route).
 * Empty for destinations, which have no outputs.
 */
export function primaryOutput(node: PlacedNode) {
  const kind = node.data.kind || "transforms";
  const ports = nodeOutputPorts(node.data.component || {}, kind);
  if (!ports.length) return "";
  if (ports.includes("output")) return node.id;
  const named = ports.find((port) => port !== "_unmatched") || ports[0];
  return `${node.id}.${named}`;
}

/** Where a step added next to `node` goes: the next column, first free row. */
export function besidePosition(nodes: readonly PlacedNode[], node: PlacedNode) {
  return freePosition(nodes, {
    x: node.position.x + PIPELINE_NODE_COLUMN_GAP,
    y: node.position.y,
  });
}
