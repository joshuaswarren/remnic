/**
 * Recall navigation access wrapper (issue #1956 leftover slice).
 *
 * Validates the request, gates the budget, and delegates to the pure
 * helpers in recall-navigate.ts. Never calls orchestrator.recall — the
 * caller supplies the node for `nodeId`.
 */
import {
  expandRecallNode,
  traverseRecallLink,
  type RecallNavExpandResult,
  type RecallNavNode,
  type RecallNavTraverseResult,
} from "./recall-navigate.js";

export type RecallNavigateAccessAction = "expand" | "traverse";

export interface RecallNavigateAccessRequest {
  action: string;
  nodeId: string;
  budget: number;
  node?: RecallNavNode;
  linkType?: string;
}

export type RecallNavigateAccessResult =
  | { ok: true; result: RecallNavExpandResult | RecallNavTraverseResult }
  | { ok: false; error: "budget_exhausted" | "unknown_action" | "node_not_found" };

export function runRecallNavigateAccess(request: RecallNavigateAccessRequest): RecallNavigateAccessResult {
  if (request.action !== "expand" && request.action !== "traverse") {
    return { ok: false, error: "unknown_action" };
  }
  if (!Number.isFinite(request.budget) || request.budget <= 0) {
    return { ok: false, error: "budget_exhausted" };
  }
  const node = request.node;
  if (node === undefined || node.id !== request.nodeId) {
    return { ok: false, error: "node_not_found" };
  }
  if (request.action === "expand") {
    return { ok: true, result: expandRecallNode(node, { budget: request.budget }) };
  }
  return {
    ok: true,
    result: traverseRecallLink(node, request.linkType ?? "", { budget: request.budget }),
  };
}
