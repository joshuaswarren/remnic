/**
 * Recall navigation helpers (issue #1956 first slice).
 *
 * Pure expand/traverse over disclosure levels and typed links. No LLM, no IO.
 * Surfaces (MCP/HTTP/CLI) and parseConfig wiring wait for a later PR —
 * config.ts is at its fileSizeGrandfather ceiling.
 *
 * Budget 0 is off (unavailable). Empty means the step ran and found nothing.
 */
import {
  RECALL_DISCLOSURE_LEVELS,
  type RecallDisclosure,
} from "./types.js";

export const RECALL_NAV_LINK_TYPES = [
  "supports",
  "contradicts",
  "elaborates",
  "supersedes",
  "causes",
] as const;

export type RecallNavLinkType = (typeof RECALL_NAV_LINK_TYPES)[number];

export interface RecallNavBudget {
  budget: number;
}

export interface RecallNavEdge {
  targetId: string;
  linkType: string;
  preview?: string;
}

export interface RecallNavNode {
  id: string;
  disclosure: RecallDisclosure;
  payloads?: Partial<Record<RecallDisclosure, string>>;
  links?: readonly RecallNavEdge[];
}

export interface RecallNavNeighbor {
  id: string;
  linkType: RecallNavLinkType;
  preview?: string;
}

export type RecallNavExpandResult =
  | { status: "ok"; node: { id: string; disclosure: RecallDisclosure; text: string } }
  | { status: "empty" }
  | { status: "unavailable"; reason: "budget_off" };

export type RecallNavTraverseResult =
  | { status: "ok"; neighbors: readonly RecallNavNeighbor[] }
  | { status: "empty" }
  | { status: "unavailable"; reason: "budget_off" };

export function isRecallNavLinkType(value: unknown): value is RecallNavLinkType {
  return typeof value === "string" && (RECALL_NAV_LINK_TYPES as readonly string[]).includes(value);
}

export function expandRecallNode(
  node: RecallNavNode,
  options: RecallNavBudget,
): RecallNavExpandResult {
  if (!Number.isFinite(options.budget) || options.budget <= 0) {
    return { status: "unavailable", reason: "budget_off" };
  }
  const current = RECALL_DISCLOSURE_LEVELS.indexOf(node.disclosure);
  const next = current >= 0 ? RECALL_DISCLOSURE_LEVELS[current + 1] : undefined;
  if (next === undefined) return { status: "empty" };
  const text = node.payloads?.[next];
  if (typeof text !== "string") return { status: "empty" };
  return { status: "ok", node: { id: node.id, disclosure: next, text } };
}

export function traverseRecallLink(
  from: RecallNavNode,
  linkType: string,
  options: RecallNavBudget,
): RecallNavTraverseResult {
  if (!isRecallNavLinkType(linkType)) {
    throw new Error(
      `unknown recall nav linkType: ${JSON.stringify(linkType)}. Valid: ${RECALL_NAV_LINK_TYPES.join(", ")}`,
    );
  }
  if (!Number.isFinite(options.budget) || options.budget <= 0) {
    return { status: "unavailable", reason: "budget_off" };
  }
  const neighbors = (from.links ?? [])
    .filter((link) => link.linkType === linkType)
    .map((link) => {
      const neighbor: RecallNavNeighbor = { id: link.targetId, linkType };
      if (link.preview !== undefined) neighbor.preview = link.preview;
      return neighbor;
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (neighbors.length === 0) return { status: "empty" };
  return { status: "ok", neighbors };
}
