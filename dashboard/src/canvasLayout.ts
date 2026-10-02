import type { Graph } from "./api";
import {
  CLEARANCE,
  LANE_SPACING,
  routeConnections,
  type Card,
  type Lane,
  type Link as Connection,
  type RouteStyle,
} from "./connectionRoute";
import {
  nodeOutputPorts,
  pipelineNodeHeight,
  PIPELINE_NODE_BODY_HEIGHT,
  PIPELINE_NODE_COLUMN_GAP,
  PIPELINE_NODE_HEADER_HEIGHT,
  PIPELINE_NODE_PORT_HEIGHT,
  PIPELINE_NODE_WIDTH,
} from "./pipelineNodeModel";

/**
 * Automatic layout: left-to-right columns, every destination in the last one.
 *
 * A connection that skips columns gets a lane in each column it crosses, so
 * the cards of those columns are placed around it and the line never runs
 * behind a card. Cards are ordered by where their connections leave and
 * arrive, a named output counting at its own row, so the destinations of a
 * route stack in the order of its outputs. Each column is then placed as close
 * as the gaps allow to where its connections want it, which draws the
 * connections nearly level.
 */

/** Space between two cards in a column. */
export const NODE_GAP = 66;
/** Space between a card and a connection passing through its column. */
const LANE_CLEARANCE = CLEARANCE;
/** Space between two connections passing through one column. */
const LANE_STEP = LANE_SPACING;
const MARGIN = 70;
/** Output handles of a named-output card sit in rows below its body. */
const FIRST_PORT_ROW =
  PIPELINE_NODE_BODY_HEIGHT + 4 + PIPELINE_NODE_PORT_HEIGHT / 2;

type Item = {
  id: string;
  rank: number;
  /** A connection passing through the column, not a card. */
  lane: boolean;
  height: number;
  /** Outputs of a card with named outputs; empty for one output. */
  ports: string[];
  top: number;
};
type Link = {
  from: Item;
  to: Item;
  /** Where the connection leaves `from` and arrives at `to`, below their tops. */
  out: number;
  into: number;
  weight: number;
};

/** Where a connection leaves a card, below the card's top. */
export function outputOffset(ports: readonly string[], handle: string) {
  if (!ports.length || (ports.length === 1 && ports[0] === "output"))
    return PIPELINE_NODE_HEADER_HEIGHT;
  return (
    FIRST_PORT_ROW +
    Math.max(0, ports.indexOf(handle)) * PIPELINE_NODE_PORT_HEIGHT
  );
}
export const inputOffset = PIPELINE_NODE_HEADER_HEIGHT;

const gapBetween = (above: Item, below: Item) =>
  above.lane && below.lane
    ? LANE_STEP
    : above.lane || below.lane
      ? LANE_CLEARANCE
      : NODE_GAP;

/**
 * The tops closest to `ideal` (weighted least squares) that keep a column in
 * order with its gaps: isotonic regression on the offsets from the column's
 * stacked top.
 */
function place(
  column: Item[],
  ideal: (item: Item) => { top: number; weight: number },
) {
  const shifts: number[] = [];
  let shift = 0;
  column.forEach((item, index) => {
    shifts.push(shift);
    if (index + 1 < column.length)
      shift += item.height + gapBetween(item, column[index + 1]);
  });
  const blocks: { sum: number; weight: number; count: number }[] = [];
  column.forEach((item, index) => {
    const { top, weight } = ideal(item);
    blocks.push({ sum: (top - shifts[index]) * weight, weight, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1],
        before = blocks[blocks.length - 2];
      if (before.sum / before.weight <= last.sum / last.weight) break;
      blocks.splice(-2, 2, {
        sum: before.sum + last.sum,
        weight: before.weight + last.weight,
        count: before.count + last.count,
      });
    }
  });
  let index = 0;
  for (const block of blocks)
    for (let n = 0; n < block.count; n++, index++)
      column[index].top = block.sum / block.weight + shifts[index];
}

export function arrangeGraph(graph: Graph): Graph {
  const byId = new Map<string, any>(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    parents.set(edge.target, [
      ...(parents.get(edge.target) || []),
      edge.source,
    ]);
  }
  // Columns by the longest path from a source; destinations share the last.
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
  const rankOf = (node: any) =>
    node.data.kind === "sinks" ? last : depths.get(node.id)!;

  const items = new Map<string, Item>();
  const columns: Item[][] = Array.from({ length: last + 1 }, () => []);
  for (const node of graph.nodes) {
    const item: Item = {
      id: node.id,
      rank: rankOf(node),
      lane: false,
      height: pipelineNodeHeight(node.data),
      ports: nodeOutputPorts(node.data.component || {}, node.data.kind),
      top: 0,
    };
    items.set(node.id, item);
    columns[item.rank].push(item);
  }

  // Connections, with a lane in every column a long one crosses.
  const incoming = new Map<Item, Link[]>(),
    outgoing = new Map<Item, Link[]>();
  const link = (from: Item, to: Item, out: number, into: number) => {
    const weight = from.lane && to.lane ? 4 : from.lane || to.lane ? 2 : 1;
    const entry = { from, to, out, into, weight };
    outgoing.set(from, [...(outgoing.get(from) || []), entry]);
    incoming.set(to, [...(incoming.get(to) || []), entry]);
  };
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = items.get(edge.source),
      to = items.get(edge.target);
    const handle = edge.sourceHandle || "output";
    const key = `${edge.source}\u0000${handle}\u0000${edge.target}`;
    if (!from || !to || to.rank <= from.rank || seen.has(key)) continue;
    seen.add(key);
    let previous = from,
      out = outputOffset(from.ports, handle);
    for (let rank = from.rank + 1; rank < to.rank; rank++) {
      const lane: Item = {
        id: `${key}\u0000${rank}`,
        rank,
        lane: true,
        height: 0,
        ports: [],
        top: 0,
      };
      columns[rank].push(lane);
      link(previous, lane, out, 0);
      previous = lane;
      out = 0;
    }
    link(previous, to, out, inputOffset);
  }

  // Start from each column stacked around the middle.
  for (const column of columns) {
    const total = column.reduce(
      (sum, item, index) =>
        sum + item.height + (index ? gapBetween(column[index - 1], item) : 0),
      0,
    );
    let top = -total / 2;
    column.forEach((item, index) => {
      if (index) top += gapBetween(column[index - 1], item);
      item.top = top;
      top += item.height;
    });
  }

  // Sweep left to right and back: each column is ordered by where its
  // connections meet it (`reorder`), then placed near where they want it.
  function sweep(forward: boolean, reorder: boolean) {
    const ranks = columns.map((_, rank) => rank);
    for (const rank of forward
      ? ranks.slice(1)
      : ranks.slice(0, -1).reverse()) {
      const column = columns[rank];
      const wanted = new Map<
        Item,
        { top: number; handle: number; weight: number }
      >();
      for (const item of column) {
        const links = (forward ? incoming : outgoing).get(item) || [];
        if (!links.length) {
          wanted.set(item, {
            top: item.top,
            handle: item.top + (forward ? inputOffset : 0),
            weight: 0.01,
          });
          continue;
        }
        let top = 0,
          handle = 0,
          weight = 0;
        for (const entry of links) {
          const at = forward
            ? entry.from.top + entry.out
            : entry.to.top + entry.into;
          top += entry.weight * (at - (forward ? entry.into : entry.out));
          handle += entry.weight * at;
          weight += entry.weight;
        }
        wanted.set(item, {
          top: top / weight,
          handle: handle / weight,
          weight,
        });
      }
      if (reorder) {
        const current = new Map(column.map((item, index) => [item, index]));
        column.sort(
          (a, b) =>
            wanted.get(a)!.handle - wanted.get(b)!.handle ||
            current.get(a)! - current.get(b)!,
        );
      }
      place(column, (item) => wanted.get(item)!);
    }
  }
  for (let pass = 0; pass < 12; pass++) sweep(pass % 2 === 0, pass < 6);
  sweep(false, false);
  sweep(true, false);

  const shift =
    MARGIN -
    Math.min(...graph.nodes.map((node) => items.get(node.id)!.top), Infinity);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const item = items.get(node.id)!;
      return {
        ...node,
        position: {
          x: MARGIN + item.rank * PIPELINE_NODE_COLUMN_GAP,
          y: Math.round(item.top + (Number.isFinite(shift) ? shift : 0)),
        },
      };
    }),
  };
}

/** Every card on the canvas, as a box. */
export function canvasCards(graph: Graph): Card[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: PIPELINE_NODE_WIDTH,
    height: pipelineNodeHeight(node.data),
  }));
}

/** Every connection with the points where it leaves and arrives. */
export function canvasConnections(graph: Graph): Connection[] {
  const cards = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return graph.edges.flatMap((edge) => {
    const source = cards.get(edge.source),
      target = cards.get(edge.target);
    if (!source || !target) return [];
    return [
      {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        from: {
          x: source.position.x + PIPELINE_NODE_WIDTH,
          y:
            source.position.y +
            outputOffset(
              nodeOutputPorts(source.data.component || {}, source.data.kind),
              edge.sourceHandle || "output",
            ),
        },
        to: { x: target.position.x, y: target.position.y + inputOffset },
      },
    ];
  });
}

/**
 * The lanes for every connection that would run behind a card, by edge ID:
 * what the canvas routes around the cards. Straight lines are left as the
 * person chose them.
 */
export function connectionRoutes(
  graph: Graph,
  style: RouteStyle | "straight",
): Map<string, Lane[]> {
  if (style === "straight") return new Map();
  return routeConnections(canvasConnections(graph), canvasCards(graph), style);
}
