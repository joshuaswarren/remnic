/**
 * Recall navigation node-id parse (issue #1956 leftover).
 *
 * Pure. Surfaces wait. Empty is missing_node. Newline is invalid_node.
 */

export type ParseNavigateNodeIdResult =
  | { ok: true; nodeId: string }
  | { ok: false; error: "missing_node" | "invalid_node" };

export function parseNavigateNodeId(value: string): ParseNavigateNodeIdResult {
  const nodeId = value.trim();
  if (nodeId.length === 0) return { ok: false, error: "missing_node" };
  if (nodeId.includes("\n")) return { ok: false, error: "invalid_node" };
  return { ok: true, nodeId };
}
