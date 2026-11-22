
import { connectorMatchesScope, normalizeConnectorScope } from "./connector-scope.js";


export interface SemanticDedupHit {
  id: string;
  /** Cosine similarity score in [0, 1]. */
  score: number;
  path?: string;
  sourceConnector?: string;
}

/**
 * Lookup function passed by the caller. Must return an array of hits sorted
 * descending by score. Implementations must throw when the embedding backend
 * is unavailable or the provider call fails, and return an empty array only
 * when a reachable backend successfully reports no hits. The decision function
 * fail-opens on thrown lookup errors while preserving a distinct
 * "backend_unavailable" reason for telemetry.
 */
export type SemanticDedupLookup = (
  content: string,
  limit: number,
) => Promise<SemanticDedupHit[]>;

export interface SemanticDedupOptions {
  /** Master switch. When false, `decideSemanticDedup` always returns `keep`. */
  enabled: boolean;
  /** Cosine similarity threshold (0-1). ≥ threshold ⇒ treat as duplicate. */
  threshold: number;
  candidates: number;
  sourceConnector?: string;
}

export type SemanticDedupDecision =
  | {
      action: "keep";
      reason:
        | "disabled"
        | "backend_unavailable"
        | "no_candidates"
        | "no_near_duplicate"
        | "connector_mismatch";
      topScore?: number;
      topId?: string;
    }
  | {
      action: "skip";
      reason: "near_duplicate";
      topScore: number;
      topId: string;
      topPath?: string;
    };


const DEFAULT_SEMANTIC_THRESHOLD = 0.92;
const DEFAULT_SEMANTIC_CANDIDATES = 5;

function normalizeSemanticThreshold(value: number): number {
  return Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_SEMANTIC_THRESHOLD;
}

function normalizeSemanticCandidates(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_SEMANTIC_CANDIDATES;
  }
  const normalized = Math.floor(value);
  return value > 0 && normalized === 0 ? 1 : normalized;
}

/**
 * Pure decision function: given a lookup callback and options, decide whether
 * the candidate content should be written or skipped as a near-duplicate.
 *
 * Contract:
 *   - When `options.enabled` is false → always keep, reason="disabled".
 *   - When the lookup throws (provider down / network error) → keep,
 *     reason="backend_unavailable". Fail-open: a lookup failure must not block
 *     writes.
 *   - When the lookup succeeds but returns 0 hits (empty index or no
 *     neighbors above the score floor) → keep, reason="no_candidates".
 *     This is distinct from backend_unavailable so telemetry dashboards can
 *     correctly distinguish "provider is down" from "index is empty".
 *   - When the top hit's score ≥ threshold → skip with reason="near_duplicate".
 *   - Otherwise → keep with reason="no_near_duplicate".
 */
export async function decideSemanticDedup(
  content: string,
  lookup: SemanticDedupLookup,
  options: SemanticDedupOptions,
): Promise<SemanticDedupDecision> {
  if (!options.enabled) {
    return { action: "keep", reason: "disabled" };
  }
  const threshold = normalizeSemanticThreshold(options.threshold);
  const candidates = normalizeSemanticCandidates(options.candidates);
  if (candidates === 0) {
    return { action: "keep", reason: "disabled" };
  }
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) {
    return { action: "keep", reason: "no_near_duplicate" };
  }
  let hits: SemanticDedupHit[] = [];
  try {
    hits = await lookup(trimmed, candidates);
  } catch {
    return { action: "keep", reason: "backend_unavailable" };
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { action: "keep", reason: "no_candidates" };
  }

  // Resolve the candidate's provenance connector through the shared scope
  // contract (`connector-scope.ts`): an empty/whitespace value is treated as
  // absent (operator / unattributed).
  const candidateConnector = normalizeConnectorScope(options.sourceConnector);

  // Defensive: callers ought to return sorted, but don't trust it.
  let top: SemanticDedupHit | undefined;
  let sameConnectorTop: SemanticDedupHit | undefined;
  for (const hit of hits) {
    if (
      !hit ||
      typeof hit.id !== "string" ||
      hit.id.trim().length === 0 ||
      typeof hit.score !== "number" ||
      !Number.isFinite(hit.score)
    ) {
      continue;
    }
    if (!top || hit.score > top.score) {
      top = hit;
    }
    if (
      candidateConnector !== undefined &&
      connectorMatchesScope(hit.sourceConnector, candidateConnector) &&
      (!sameConnectorTop || hit.score > sameConnectorTop.score)
    ) {
      sameConnectorTop = hit;
    }
  }
  if (!top) {
    return { action: "keep", reason: "no_near_duplicate" };
  }

  if (top.score >= threshold) {
    if (candidateConnector !== undefined) {
      const match =
        sameConnectorTop !== undefined && sameConnectorTop.score >= threshold
          ? sameConnectorTop
          : undefined;
      if (match) {
        return {
          action: "skip",
          reason: "near_duplicate",
          topScore: match.score,
          topId: match.id,
          topPath: match.path,
        };
      }
      return {
        action: "keep",
        reason: "connector_mismatch",
        topScore: top.score,
        topId: top.id,
      };
    }
    return {
      action: "skip",
      reason: "near_duplicate",
      topScore: top.score,
      topId: top.id,
      topPath: top.path,
    };
  }

  return {
    action: "keep",
    reason: "no_near_duplicate",
    topScore: top.score,
    topId: top.id,
  };
}
