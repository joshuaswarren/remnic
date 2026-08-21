/**
 * Judge-mediated merge-on-write decision (issue #2330, harmonic 2/5).
 *
 * A new candidate fact that is semantically close — but NOT near-duplicate
 * close — to an existing active memory is offered to an LLM merge judge.
 * On a "merge" verdict the caller updates the existing entry in place
 * instead of writing a new fragment. Every failure mode fails closed to
 * "create": the unsafe default is always the unchanged write path.
 *
 * The near-duplicate skip path (similarity >= the semantic dedup
 * threshold) is untouched — this module only sees the band
 * `[minSimilarity, dedupThreshold)`.
 */

import { coerceBool, coerceNumber } from "../connectors/coerce.js";
import type { SemanticMergeConfig } from "../types.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { semanticDedupThresholdFrom } from "./novelty-gate.js";
import { parseMinMergeScore } from "./merge-min-score.js";
import { checkMergedContent } from "./merge-content.js";
import type { SemanticDedupHit, SemanticDedupLookup } from "./semantic.js";
import { connectorMatchesScope, normalizeConnectorScope } from "./connector-scope.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** An existing memory considered as a merge target. */
export interface MergeCandidate {
  memoryId: string;
  content: string;
  category: string;
  similarity: number;
  /** Frontmatter status; only `active` (or absent) memories are eligible. */
  status: string;
}

/**
 * Raw (parsed but UNVALIDATED) judge verdict. `decideSemanticMerge`
 * hard-validates before trusting any field — an LLM-fabricated targetId
 * must never survive (issue #2330 step 2).
 */
export interface MergeJudgeRawVerdict {
  decision: "merge" | "create" | "contradicts";
  targetId?: string | null;
  mergedContent?: string | null;
  reason?: string | null;
}

/** The judge call injected by the caller (LLM-backed in production). */
export type MergeJudge = (input: {
  content: string;
  category: string;
  candidates: readonly MergeCandidate[];
}) => Promise<MergeJudgeRawVerdict>;

/** Resolves candidate metadata for a lookup hit id; null = unknown memory. */
export type MergeCandidateResolver = (
  memoryId: string,
) => Promise<{ content: string; category: string; status: string } | null>;

/** Why a candidate fell through to the unchanged create path. */
export type MergeCreateReason =
  | "disabled"
  | "no_candidates"
  | "judge_create"
  | "judge_contradicts"
  | "judge_invalid"
  | "judge_error"
  | "backend_unavailable";

export type MergeDecision =
  | { action: "create"; reason: MergeCreateReason }
  | {
      action: "merge";
      targetId: string;
      mergedContent: string;
      /**
       * The target body the judge actually merged. The persist side must
       * compare it against the target it is about to write and fall back to
       * create when it differs: in a multi-writer deployment another
       * extraction can update the target between this decision and the write,
       * and `mergedContent` was computed from the older body.
       */
      targetContent: string;
      reason: "judge_merge";
    };

export interface DecideSemanticMergeOptions {
  content: string;
  category: string;
  lookup: SemanticDedupLookup;
  judge: MergeJudge;
  config: SemanticMergeConfig;
  /** Upper bound of the merge band: the semantic-dedup threshold. */
  dedupThreshold: number;
  resolveCandidate: MergeCandidateResolver;
  /**
   * Provenance connector of the INCOMING fact. A provenance-bearing fact may
   * only merge into a neighbor from the same connector — otherwise the merge
   * rewrites another connector's memory while its `sourceConnector`
   * frontmatter still identifies that connector. Same shared scope contract
   * the novelty and semantic-dedup gates apply (`connector-scope.ts`).
   */
  sourceConnector?: string;
}

// ── Decision function ─────────────────────────────────────────────────────────

/** Total order: similarity desc, then memoryId asc (checklist #12). */
function compareMergeCandidates(a: MergeCandidate, b: MergeCandidate): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity;
  return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
}

export async function decideSemanticMerge(
  options: DecideSemanticMergeOptions,
): Promise<MergeDecision> {
  const { config } = options;
  if (config.enabled !== true) return { action: "create", reason: "disabled" };
  // 0 disables merging entirely — short-circuit BEFORE the lookup so no
  // embedding backend call is made (config is runtime API; never coerce 0).
  if (!(config.maxCandidates > 0)) return { action: "create", reason: "disabled" };
  if (!(config.categories as readonly string[]).includes(options.category)) {
    return { action: "create", reason: "disabled" };
  }
  const trimmed = typeof options.content === "string" ? options.content.trim() : "";
  if (!trimmed) return { action: "create", reason: "no_candidates" };

  // Lookup throws = backend down (distinct from an empty index, #22).
  let hits: SemanticDedupHit[];
  try {
    hits = await options.lookup(trimmed, config.maxCandidates);
  } catch {
    return { action: "create", reason: "backend_unavailable" };
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { action: "create", reason: "no_candidates" };
  }

  // Shared connector scope (`connector-scope.ts`): a provenance-bearing fact
  // may only merge into a neighbor from the SAME connector. Without this the
  // judge can rewrite connector A's memory with connector B's claim while A's
  // `sourceConnector` frontmatter still identifies A — the same provenance
  // corruption the novelty and semantic-dedup gates already refuse.
  const scope = normalizeConnectorScope(options.sourceConnector);
  const candidates: MergeCandidate[] = [];
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
    // Band: [minSimilarity, dedupThreshold). The upper edge is owned by the
    // near-duplicate skip path and must stay excluded.
    if (!(hit.score >= config.minSimilarity && hit.score < options.dedupThreshold)) {
      continue;
    }
    if (!connectorMatchesScope(hit.sourceConnector, scope)) continue;
    const meta = await options.resolveCandidate(hit.id);
    if (!meta) continue;
    if (meta.category !== options.category) continue;
    if (!isActiveMemoryStatus(meta.status)) continue;
    candidates.push({
      memoryId: hit.id,
      content: meta.content,
      category: meta.category,
      similarity: hit.score,
      status: meta.status,
    });
  }
  if (candidates.length === 0) return { action: "create", reason: "no_candidates" };

  candidates.sort(compareMergeCandidates);
  const limited = candidates.slice(0, config.maxCandidates);

  let verdict: MergeJudgeRawVerdict;
  try {
    verdict = await options.judge({
      content: trimmed,
      category: options.category,
      candidates: limited,
    });
  } catch {
    return { action: "create", reason: "judge_error" };
  }
  if (!verdict || typeof verdict !== "object") {
    return { action: "create", reason: "judge_invalid" };
  }
  if (verdict.decision === "create") return { action: "create", reason: "judge_create" };
  if (verdict.decision === "contradicts") return { action: "create", reason: "judge_contradicts" };

  // Hard post-validation: never trust the model to echo ids.
  const target =
    typeof verdict.targetId === "string"
      ? limited.find((c) => c.memoryId === verdict.targetId)
      : undefined;
  if (!target) return { action: "create", reason: "judge_invalid" };
  const content = checkMergedContent({
    mergedContent: verdict.mergedContent,
    incomingContent: trimmed,
    targetContent: target.content,
  });
  if (!content.ok) return { action: "create", reason: "judge_invalid" };
  return {
    action: "merge",
    targetId: target.memoryId,
    mergedContent: content.content,
    targetContent: target.content,
    reason: "judge_merge",
  };
}

// ── Config parsing ────────────────────────────────────────────────────────────

export const DEFAULT_SEMANTIC_MERGE_CATEGORIES = [
  "fact",
  "preference",
  "decision",
  "relationship",
  "skill",
] as const;

export const DEFAULT_SEMANTIC_MERGE_MIN = 0.8;
export const DEFAULT_SEMANTIC_MERGE_CANDIDATES = 3;

function describeValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

/**
 * Parse the `semanticMerge` block (issue #2330). Follows the `procedural.*`
 * worked example: strict booleans that reject unrecognized values, CLI
 * string coercion for numbers ("0" is zero, never coerced upward), and
 * parse-time rejection of an empty merge band (`minSimilarity` must be
 * strictly below the semantic-dedup threshold that owns the band's top).
 * Invalid input is rejected, never silently defaulted or reinterpreted: a
 * present block that is not an object, a non-integer `maxCandidates`, or a
 * malformed `categories` array each throw (only an absent block means
 * "use the defaults").
 *
 * The band check applies only when it can describe a real misconfiguration:
 * merging is enabled, or `minSimilarity` was set explicitly. A deployment
 * that predates this block and lowered `semanticDedupThreshold` to <= the
 * default merge minimum must keep starting — the disabled feature performs
 * no band lookup at all, so rejecting that config would be a gratuitous
 * backward-compatibility break.
 */
export function parseSemanticMergeConfig(
  cfg: Record<string, unknown>,
): { semanticMerge: SemanticMergeConfig } {
  const block = cfg.semanticMerge;
  if (
    block !== undefined &&
    (typeof block !== "object" || block === null || Array.isArray(block))
  ) {
    throw new Error(
      `semanticMerge must be an object when present (got ${describeValue(block)}). Remove the block to fall back to the defaults.`,
    );
  }
  const raw = (block ?? {}) as Record<string, unknown>;
  const parseGate = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === undefined) return fallback;
    const coerced = coerceBool(value, `semanticMerge.${key}`);
    if (coerced === undefined) {
      throw new Error(
        `semanticMerge.${key} must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${describeValue(value)}).`,
      );
    }
    return coerced;
  };
  const minSimilarity =
    raw.minSimilarity === undefined
      ? DEFAULT_SEMANTIC_MERGE_MIN
      : parseMinMergeScore(raw.minSimilarity);
  const rawCandidates = coerceNumber(raw.maxCandidates, "semanticMerge.maxCandidates");
  if (rawCandidates !== undefined && (!Number.isInteger(rawCandidates) || rawCandidates < 0)) {
    throw new Error(
      `semanticMerge.maxCandidates must be an integer >= 0 (got ${describeValue(raw.maxCandidates)}). Set 0 to disable merging entirely.`,
    );
  }
  const maxCandidates =
    rawCandidates === undefined ? DEFAULT_SEMANTIC_MERGE_CANDIDATES : rawCandidates;
  const rawCategories = raw.categories;
  if (
    rawCategories !== undefined &&
    (!Array.isArray(rawCategories) ||
      !rawCategories.every((c) => typeof c === "string" && c.length > 0))
  ) {
    throw new Error(
      `semanticMerge.categories must be an array of non-empty category names (got ${describeValue(rawCategories)}).`,
    );
  }
  const categories =
    rawCategories === undefined
      ? [...DEFAULT_SEMANTIC_MERGE_CATEGORIES]
      : [...(rawCategories as string[])];
  const enabled = parseGate("enabled", false);
  const dedupThreshold = semanticDedupThresholdFrom(cfg);
  if ((enabled || raw.minSimilarity !== undefined) && minSimilarity >= dedupThreshold) {
    throw new Error(
      `semanticMerge.minSimilarity (${minSimilarity}) must be strictly below semanticDedupThreshold (${dedupThreshold}) — the near-duplicate skip path owns similarities at or above it.`,
    );
  }
  return {
    semanticMerge: {
      enabled,
      minSimilarity,
      maxCandidates,
      categories,
      shadowMode: parseGate("shadowMode", false),
    },
  };
}
