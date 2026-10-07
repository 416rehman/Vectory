import type { PatternInput } from "./inputPatterns";

type FlowEdge = { id: string; source: string; target: string };
export type FlowPath = { nodes: Set<string>; edges: Set<string> };

/** Configured downstream reachability, not a claim about actual event delivery. */
export function downstreamFlowPath(
  source: string,
  nodes: readonly { id: string }[],
  edges: readonly FlowEdge[],
  patterns: readonly PatternInput[] = [],
): FlowPath {
  const present = new Set(nodes.map((node) => node.id));
  const path: FlowPath = { nodes: new Set(), edges: new Set() };
  if (!present.has(source)) return path;
  const outgoing = new Map<string, { target: string; edge?: string }[]>();
  function add(from: string, target: string, edge?: string) {
    if (!present.has(from) || !present.has(target)) return;
    const connections = outgoing.get(from) ?? [];
    connections.push({ target, edge });
    outgoing.set(from, connections);
  }
  for (const edge of edges) add(edge.source, edge.target, edge.id);
  // Use every current match, including matches beyond the canvas drawing cap.
  for (const input of patterns)
    for (const match of input.matches) add(match.id, input.target);
  const pending = [source];
  path.nodes.add(source);
  for (let at = 0; at < pending.length; at++) {
    for (const connection of outgoing.get(pending[at]) ?? []) {
      if (connection.edge !== undefined) path.edges.add(connection.edge);
      if (path.nodes.has(connection.target)) continue;
      path.nodes.add(connection.target);
      pending.push(connection.target);
    }
  }
  return path;
}
