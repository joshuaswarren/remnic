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
import { MEMORY_CATEGORIES } from "../correction/correction-contract.js";
import type { SemanticMergeConfig } from "../types.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { semanticDedupThresholdFrom } from "./novelty-gate.js";
import { parseMinMergeScore } from "./merge-min-score.js";
import { REFUSED_MERGE_CATEGORIES } from "./merge-on-write.js";
import { checkMergedContent } from "./merge-content.js";
import type { SemanticDedupHit, SemanticDedupLookup } from "./semantic.js";
import { normalizeConnectorScope } from "./connector-scope.js";

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
   * Provenance connector of the INCOMING fact. Merge selection is stricter
   * than the novelty and semantic-dedup gates (`connector-scope.ts`): a merge
   * may only pair an unscoped fact with an unscoped target, or a
   * provenance-bearing fact with a neighbor from the same connector. A merge
   * rewrites the target's body, so any other pairing would relabel one side's
   * claims under the other's `sourceConnector` frontmatter (finding B).
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
  // Round N+17 (A): the fetch deliberately OVERSHOOTS maxCandidates. The
  // eligibility predicates below (band, connector scope, category, active
  // status) run after the lookup, so fetching exactly maxCandidates let
  // ineligible hits — a foreign connector or category, an inactive row —
  // occupy the whole fetch window and crowd out a valid target ranked
  // immediately beneath them; the write then created another fragment.
  // maxCandidates still bounds what reaches the JUDGE (the slice below is
  // the only truncation point).
  let hits: SemanticDedupHit[];
  try {
    hits = await options.lookup(trimmed, config.maxCandidates * CANDIDATE_OVERFETCH_FACTOR);
  } catch {
    return { action: "create", reason: "backend_unavailable" };
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { action: "create", reason: "no_candidates" };
  }

  // Connector scope (finding B): a merge REWRITES the neighbor's body, so it
  // is stricter than the shared dedup helper — both sides must be unscoped or
  // carry the identical connector. An unscoped merge into a connector-owned
  // target would rewrite A's memory while A's `sourceConnector` frontmatter
  // still identifies A, so recall and connector-aware dedup would label the
  // unscoped claims as A's.
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
    if (normalizeConnectorScope(hit.sourceConnector) !== scope) continue;
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
  // Eligible-first truncation (round N+17 A): the judge sees up to
  // maxCandidates ELIGIBLE neighbors — never the raw top-of-index hits.
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

/**
 * The categories `semanticMerge.categories` may name: every known memory
 * category except the episodic/immutable ones `REFUSED_MERGE_CATEGORIES`
 * excludes at runtime — listing a refused category configures a gate that
 * can never fire, and an unknown string (a typo like "facts") silently
 * disables merging for every category, so both are rejected at parse time.
 */
export const MERGEABLE_MEMORY_CATEGORIES: readonly string[] = MEMORY_CATEGORIES.filter(
  (category) => !(REFUSED_MERGE_CATEGORIES as readonly string[]).includes(category),
);

export const DEFAULT_SEMANTIC_MERGE_MIN = 0.8;
export const DEFAULT_SEMANTIC_MERGE_CANDIDATES = 3;

/**
 * Round N+17 (A): the neighbor fetch overshoots `maxCandidates` by this
 * factor so eligibility filtering happens BEFORE truncation. Bounded
 * ceiling: a corpus holding more than this many consecutive ineligible
 * neighbors above the valid target still crowds it out; raise only with
 * evidence of that corpus shape.
 */
const CANDIDATE_OVERFETCH_FACTOR = 4;

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
 * present block that is not an object, a present-but-`undefined` or
 * unparseable field (`enabled`, `shadowMode`, `minSimilarity`,
 * `maxCandidates` "abc"/an object/NaN/infinity, or a malformed `categories`
 * array) each throw. Presence is OWN-property presence (checklist #46): a
 * key inherited through the prototype chain never applies, and only a key
 * absent from `Object.getOwnPropertyNames` means "use the defaults".
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
  // Own-property presence (checklist #46): a bracket read follows the
  // prototype chain, and `=== undefined` folds present-but-invalid into
  // absent. Gate every presence question on Object.hasOwn.
  const blockPresent = Object.hasOwn(cfg, "semanticMerge");
  const block = blockPresent ? cfg.semanticMerge : undefined;
  if (
    block !== undefined &&
    (typeof block !== "object" || block === null || Array.isArray(block))
  ) {
    throw new Error(
      `semanticMerge must be an object when present (got ${describeValue(block)}). Remove the block to fall back to the defaults.`,
    );
  }
  if (blockPresent && block === undefined) {
    throw new Error(
      `semanticMerge must be an object when present (got ${describeValue(block)}). Remove the key to fall back to the defaults.`,
    );
  }
  const raw = (block ?? {}) as Record<string, unknown>;
  const parseGate = (key: string, fallback: boolean): boolean => {
    if (!Object.hasOwn(raw, key)) return fallback;
    const value = raw[key];
    const coerced = coerceBool(value, `semanticMerge.${key}`);
    if (coerced === undefined) {
      throw new Error(
        `semanticMerge.${key} must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${describeValue(value)}).`,
      );
    }
    return coerced;
  };
  const minSimilarityPresent = Object.hasOwn(raw, "minSimilarity");
  const minSimilarity = minSimilarityPresent
    ? parseMinMergeScore(raw.minSimilarity)
    : DEFAULT_SEMANTIC_MERGE_MIN;
  // Round N+2 (D) — distinguish an ABSENT key from a present-but-unparseable
  // value (#1/#39/#45): coerceNumber returns undefined for "abc", objects,
  // NaN, and ±Infinity, and an undefined result here must never fall back to
  // the default — that would silently enable judge lookups under an invalid
  // config. Only a key absent from the own-property set means "use the
  // default"; present-but-`undefined` is invalid like any other bad value.
  const maxCandidates = (() => {
    if (!Object.hasOwn(raw, "maxCandidates")) return DEFAULT_SEMANTIC_MERGE_CANDIDATES;
    const rawCandidatesValue = raw.maxCandidates;
    const rawCandidates = coerceNumber(rawCandidatesValue, "semanticMerge.maxCandidates");
    if (rawCandidates === undefined || !Number.isInteger(rawCandidates) || rawCandidates < 0) {
      throw new Error(
        `semanticMerge.maxCandidates must be an integer >= 0 (got ${describeValue(rawCandidatesValue)}). Remove the key to use the default (${DEFAULT_SEMANTIC_MERGE_CANDIDATES}) or set 0 to disable merging entirely.`,
      );
    }
    return rawCandidates;
  })();
  const categories = (() => {
    if (!Object.hasOwn(raw, "categories")) return [...DEFAULT_SEMANTIC_MERGE_CATEGORIES];
    const rawCategories = raw.categories;
    if (
      !Array.isArray(rawCategories) ||
      !rawCategories.every((c) => typeof c === "string" && c.length > 0)
    ) {
      throw new Error(
        `semanticMerge.categories must be an array of non-empty category names (got ${describeValue(rawCategories)}).`,
      );
    }
    const invalidCategory = rawCategories.find(
      (c) => !MERGEABLE_MEMORY_CATEGORIES.includes(c),
    );
    if (invalidCategory !== undefined) {
      throw new Error(
        `semanticMerge.categories contains an unknown or never-mergeable category: ${describeValue(invalidCategory)}. Valid categories: ${MERGEABLE_MEMORY_CATEGORIES.join(", ")}. The episodic and immutable categories (${REFUSED_MERGE_CATEGORIES.join(", ")}) never merge and cannot be listed.`,
      );
    }
    return [...rawCategories];
  })();
  const enabled = parseGate("enabled", false);
  const dedupThreshold = semanticDedupThresholdFrom(cfg);
  if ((enabled || minSimilarityPresent) && minSimilarity >= dedupThreshold) {
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
