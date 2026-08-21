import type { GraphEdge } from "./graph.js";

export function graphEdgeKey(edge: GraphEdge): string {
  return `${edge.type}|${edge.from}|${edge.to}|${edge.label}|${edge.ts}`;
}
