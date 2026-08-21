/**
 * Issue #1539 PR2 — the staged recall pipeline spine.
 *
 * The four recall pipelines (`targeted-fact-recall.ts`, `response-guidance-
 * recall.ts`, `explicit-cue-recall.ts`, `event-order-recall.ts`) implement
 * the same stage sequence — intent → candidate collection → dedup → rank →
 * filter → slice → metadata insertion → token budgeting — with ~70%
 * near-duplicate code. The most dangerous divergence is the sort
 * comparator: guidance/targeted-fact sort `turnIndex` DESC (recency) while
 * event-order sorts `turnIndex` ASC (chronological). The comparators are
 * byte-identical except for this direction — copy-pasting into a new
 * chronological pipeline silently inverts the ordering.
 *
 * This module centralizes the **dedup + score + threshold-filter + sort**
 * stages behind one declared config object. Per-tier divergence (threshold
 * value, sort direction, content transformation) becomes a declared config
 * field instead of embedded code.
 *
 * **PR 2 scope:** extract the module with NO pipeline changes. PRs 3–6
 * migrate each pipeline to call `unifiedDedupeAndRank` one at a time,
 * re-running the characterization snapshots
 * (`tests/recall-pipeline-unified.test.ts`) to verify byte-for-byte parity.
 *
 * Future PRs will add the remaining stages from the issue's Solution
 * (`mergeAcrossLcmKeys`, `insertMetadata`) once the per-tier hooks are
 * factored out of each pipeline.
 *
 * @see https://github.com/joshuaswarren/remnic/issues/1539
 */

import type { EvidencePackItem } from "./evidence-pack.js";

/** A ranked evidence item: an `EvidencePackItem` with a computed `rank`. */
export interface RankedEvidenceItem extends EvidencePackItem {
  rank: number;
}

/**
 * Sort direction for the turn-index secondary key. This is the divergence
 * issue #1539 identifies: relevance-ranked pipelines (targeted-fact,
 * response-guidance) sort `turnIndex` DESC (recency — latest first); the
 * chronological pipeline (event-order) sorts `turnIndex` ASC (earliest
 * first). The rank primary key is ALWAYS DESC (higher rank first); only
 * the `turnIndex` tiebreaker flips direction.
 */
export type TurnIndexSortDirection = "desc" | "asc";

/**
 * Configuration for the unified dedup + score + threshold-filter + sort
 * pass. Each pipeline declares its divergences as fields here instead of
 * embedding them in pipeline-specific code.
 *
 * The issue's Solution defines the intended full config object
 * (`RecallPipelineConfig`); this interface is extracted incrementally:
 *   - PR 2 (this PR): dedup/score/threshold/sort only
 *   - PRs 3–6: migrate each pipeline to consume the spine
 *   - future: add `mergeAcrossLcmKeys`, `insertMetadata` once the per-tier
 *     hooks are factored out of each pipeline
 */
export interface UnifiedRankConfig<TIntent> {
  /** The user query — passed to the scorer. */
  query: string;
  /**
   * Per-tier intent classification result (already computed by the caller;
   * intent classification stays per-tier because it is genuinely
   * per-tier per issue #1539 Pitfall 1).
   */
  intents: TIntent[];
  /**
   * Score an item using its ORIGINAL (pre-transform) content. Higher = more
   * relevant. The return value becomes the item's `rank`. For pipelines
   * that don't score (explicit-cue), pass a constant scorer — the config
   * makes the no-scoring policy explicit.
   */
  scoreEvidence: (
    item: EvidencePackItem,
    query: string,
    intents: TIntent[],
  ) => number;
  /**
   * Optional content transformation applied to each surviving item's
   * OUTPUT content (NOT to the content the scorer sees). Per-tier
   * cue-appenders go here:
   *   - targeted-fact: `appendNormalizedNumericCues`
   *   - response-guidance: `appendGuidanceCues`
   *   - event-order: `appendChronologicalCues`
   *
   * The dedup key uses the TRANSFORMED content. This is equivalent to
   * deduping on original content for all existing pipelines because every
   * transform is a deterministic append (same original → same transformed →
   * same key; different originals → different transformed → different key).
   */
  transformContent?: (content: string, intents: TIntent[]) => string;
  /**
   * Whether to deduplicate by normalized (transformed) content in addition to
   * id. Default `true` — matches targeted-fact, response-guidance, and
   * explicit-cue, which all collapse later items sharing a normalized content
   * key. Event-order sets this to `false`: its rank pass
   * (`rankAndSelectEventOrderItems`) deduplicates by turn id only and keeps
   * distinct turns even when two turns share the same cue-appended body
   * (legitimate repeated turns in a chronological transcript). Making this a
   * declared field prevents PR 6's migration from silently dropping valid
   * turns (cursor bugbot a4299851).
   */
  dedupByContent?: boolean;
  /**
   * Items with `rank` below this threshold are dropped. `undefined` = no
   * filter. Event-order declares `rankThreshold: 6` here instead of
   * inlining an undocumented `.filter((item) => item.rank >= 6)` (the
   * "hardcoded rank threshold that exists in no config and no other
   * pipeline" from issue #1539's audit).
   */
  rankThreshold?: number;
  /**
   * Sort direction for the `turnIndex` secondary key.
   *
   * - `"desc"` (default): relevance-ranked pipelines (targeted-fact,
   *   response-guidance) sort `turnIndex` DESC. Undefined `turnIndex`
   *   falls to `-1` (bottom of a DESC list). Tertiary tiebreaker:
   *   `score DESC`.
   * - `"asc"`: the chronological pipeline (event-order) sorts `turnIndex`
   *   ASC. Undefined `turnIndex` falls to `Number.MAX_SAFE_INTEGER`
   *   (bottom of an ASC list). Tertiary tiebreaker: `content.localeCompare`.
   *
   * The rank primary key is ALWAYS DESC regardless of this setting.
   */
  turnIndexSortDirection?: TurnIndexSortDirection;
  /**
   * When `true`, skip the sort stage entirely and return items in their
   * post-dedup insertion order (first-seen first). Used by explicit-cue,
   * whose deliberate value ordering — turn references → content cues →
   * lexical cues, gathered by evidence TYPE then read-key priority — is the
   * pipeline's highest-value design choice. A rank-based sort would invert
   * it (turn references are deliberately UNSCORED while lexical hits carry
   * numeric scores; sorting by score would demote turn references below
   * weak lexical hits — cursor[bot] / codex P2 on #1505).
   *
   * Score and threshold-filter still apply when declared; only the sort is
   * skipped. The constant scorer (`scoreEvidence: () => 0`) makes the
   * no-scoring policy explicit alongside this flag.
   */
  preserveInsertionOrder?: boolean;
}

/**
 * Sentinel for undefined `turnIndex` when sorting DESC. `-1` sorts below
 * every real turn index (which are `>= 0`), so missing `turn_index` always
 * lands at the bottom of a DESC-ordered list — never wins ordering over a
 * real turn.
 */
const UNDEFINED_TURN_INDEX_DESC_SENTINEL = -1;

/**
 * Sentinel for undefined `turnIndex` when sorting ASC.
 * `Number.MAX_SAFE_INTEGER` sorts above every real turn index, so missing
 * `turn_index` always lands at the bottom of an ASC-ordered list.
 */
const UNDEFINED_TURN_INDEX_ASC_SENTINEL = Number.MAX_SAFE_INTEGER;

/**
 * Deduplicate, score, threshold-filter, and sort evidence items under one
 * unified policy.
 *
 * **Stage order** (matches every existing pipeline's rank/dedupe function):
 *   1. **dedup** by `id` + normalized content (first-seen wins). The dedup
 *      key uses transformed content if `transformContent` is declared.
 *   2. **score** each surviving item on its ORIGINAL content (the transform
 *      does not influence the score).
 *   3. **threshold-filter**: drop items with `rank < rankThreshold` (if
 *      declared).
 *   4. **sort**: `rank DESC` → `turnIndex` (direction-configurable) →
 *      tertiary tiebreaker (`score DESC` for relevance pipelines,
 *      `content.localeCompare` for chronological pipelines).
 *
 * This function does NOT slice (`maxResults`), budget, or format — those
 * stages remain per-tier because they interact with per-tier metadata
 * insertion. The issue's Solution describes a future `insertMetadata` hook
 * that will make budget-adjustment uniform; that lands in the per-tier
 * migration PRs.
 *
 * @example
 * // Relevance-ranked pipeline (targeted-fact shape):
 * unifiedDedupeAndRank(items, {
 *   query,
 *   intents: [],
 *   scoreEvidence: (item, q) => scoreTargetedFact(item, q),
 *   transformContent: (content) => appendNormalizedNumericCues(content),
 *   // turnIndexSortDirection defaults to "desc"
 * });
 *
 * @example
 * // Chronological pipeline (event-order shape):
 * unifiedDedupeAndRank(items, {
 *   query,
 *   intents: [],
 *   scoreEvidence: (item, q) => scoreEventOrder(item, q),
 *   transformContent: (content) => appendChronologicalCues(content, query),
 *   rankThreshold: 6,           // declared, not inlined
 *   turnIndexSortDirection: "asc",
 * });
 */
export function unifiedDedupeAndRank<TIntent>(
  items: readonly EvidencePackItem[],
  config: UnifiedRankConfig<TIntent>,
): RankedEvidenceItem[] {
  const transformContent = config.transformContent ?? ((content: string) => content);
  const direction: TurnIndexSortDirection = config.turnIndexSortDirection ?? "desc";
  const dedupByContent = config.dedupByContent !== false;

  // Stage 1: dedup by id (+ normalized transformed content when enabled).
  // First-seen wins, matching every existing pipeline. Event-order opts out
  // of content dedup (dedupByContent: false) because it keeps distinct turns
  // even when two turns share the same cue-appended body.
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const survivors: Array<{ original: EvidencePackItem; transformedContent: string }> = [];

  for (const item of items) {
    const id = resolveItemId(item);
    if (id && seenIds.has(id)) continue;

    const transformedContent = transformContent(item.content, config.intents);
    if (dedupByContent) {
      const contentKey = transformedContent.toLowerCase().replace(/\s+/g, " ").trim();
      if (seenContent.has(contentKey)) continue;
      seenContent.add(contentKey);
    }
    if (id) seenIds.add(id);
    survivors.push({ original: item, transformedContent });
  }

  // Stage 2: score on ORIGINAL content (transforms don't influence the score).
  const scored: RankedEvidenceItem[] = survivors.map(({ original, transformedContent }) => ({
    ...original,
    content: transformedContent,
    rank: config.scoreEvidence(original, config.query, config.intents),
  }));

  // Stage 3: threshold-filter (declared, not inlined).
  const filtered =
    typeof config.rankThreshold === "number"
      ? scored.filter((item) => item.rank >= (config.rankThreshold as number))
      : scored;

  // Stage 4: sort.
  // rank is ALWAYS DESC (higher rank first).
  // turnIndex direction is configurable: DESC (relevance) or ASC (chronology).
  // The tertiary tiebreaker follows the direction:
  //   DESC → score DESC; ASC → content.localeCompare.
  //
  // explicit-cue opts out of sorting entirely (preserveInsertionOrder) — its
  // deliberate value ordering is the collection order (turn references →
  // content cues → lexical cues), and a rank-based sort would invert it.
  if (config.preserveInsertionOrder) {
    return filtered;
  }
  return filtered.sort(makeComparator(direction));
}

/**
 * Build the sort comparator for the configured direction. Extracted so the
 * comparator's two shapes (DESC / ASC) can be tested independently and so
 * the direction divergence is visible in ONE place.
 */
function makeComparator(
  direction: TurnIndexSortDirection,
): (left: RankedEvidenceItem, right: RankedEvidenceItem) => number {
  if (direction === "asc") {
    // Chronological (event-order): rank DESC → turnIndex ASC → content localeCompare.
    // Matches event-order-recall.ts:159-164 (rankedByScore sort) byte-for-byte.
    return (left, right) => {
      if (right.rank !== left.rank) return right.rank - left.rank;
      const leftTurn =
        typeof left.turnIndex === "number"
          ? left.turnIndex
          : UNDEFINED_TURN_INDEX_ASC_SENTINEL;
      const rightTurn =
        typeof right.turnIndex === "number"
          ? right.turnIndex
          : UNDEFINED_TURN_INDEX_ASC_SENTINEL;
      if (leftTurn !== rightTurn) return leftTurn - rightTurn;
      return left.content.localeCompare(right.content);
    };
  }
  // Relevance-ranked (targeted-fact, response-guidance):
  // rank DESC → turnIndex DESC → score DESC.
  // Matches targeted-fact-recall.ts:239-245 and response-guidance-recall.ts:374-380
  // byte-for-byte.
  return (left, right) => {
    if (right.rank !== left.rank) return right.rank - left.rank;
    const leftTurn =
      typeof left.turnIndex === "number"
        ? left.turnIndex
        : UNDEFINED_TURN_INDEX_DESC_SENTINEL;
    const rightTurn =
      typeof right.turnIndex === "number"
        ? right.turnIndex
        : UNDEFINED_TURN_INDEX_DESC_SENTINEL;
    if (rightTurn !== leftTurn) return rightTurn - leftTurn;
    return (right.score ?? 0) - (left.score ?? 0);
  };
}


/**
 * Resolve an evidence item's id. Falls back to `sessionId:turnIndex` when
 * `id` is absent — mirrors every existing pipeline's fallback and
 * `evidence-pack.ts`'s `evidenceItemFallbackId`.
 */
function resolveItemId(item: EvidencePackItem): string | undefined {
  if (item.id) return item.id;
  if (item.sessionId && typeof item.turnIndex === "number") {
    return `${item.sessionId}:${item.turnIndex}`;
  }
  return undefined;
}
