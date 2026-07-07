/**
 * Direct-answer wiring (issue #518 slice 3).
 *
 * Binds the pure eligibility decision (`direct-answer.ts`) to the data
 * sources needed to build candidates: storage, trust-zones, taxonomy,
 * and importance scoring.  Kept as a separate module so that:
 *
 * - The eligibility layer stays pure and unit-testable without stores.
 * - Each caller injects its own source accessors.  The orchestrator
 *   binding is a follow-on slice; tests here use mock sources.
 * - The wiring is safe to ship alone — nothing calls `tryDirectAnswer`
 *   yet, so enabling this module's presence does not change recall
 *   behavior.  The next slice adds exactly one call site before QMD.
 *
 * Short-circuit contract:
 *
 * - When the resolved gate (`input.enabled`, projected from
 *   `caps.recallDirectAnswer` at the recall-operation entry) is `false`, the
 *   function returns the
 *   eligibility verdict with reason `"disabled"` without touching any source
 *   accessor.  This is the documented default.
 * - When enabled, the wiring cheaply drops non-trusted-zone memories
 *   and ineligible taxonomy buckets before computing importance, so
 *   the eligibility module sees a pre-filtered candidate set.  The
 *   eligibility module still performs the same checks itself — this
 *   module is purely an I/O and prefiltering layer.
 */

import type { MemoryFile, PluginConfig } from "./types.js";
import type { TrustZoneName } from "./trust-zones.js";
import type { Taxonomy } from "./taxonomy/types.js";
import { resolveCategory } from "./taxonomy/resolver.js";
import { normalizeRecallTokens } from "./recall-tokenization.js";
import { throwIfAborted } from "./abort-error.js";
import {
  isDirectAnswerEligible,
  type DirectAnswerCandidate,
  type DirectAnswerConfig,
  type DirectAnswerResult,
} from "./direct-answer.js";

/**
 * Caller-provided accessors for candidate sourcing.  Decouples the
 * wiring from any specific storage / trust-zone / importance backend.
 */
export interface DirectAnswerSources {
  /**
   * List memories eligible to be considered for direct-answer.
   * Callers are expected to return only active, non-superseded memories
   * in the requested namespace; the wiring will cheaply re-filter on
   * trust zone and taxonomy bucket and hand the rest to the eligibility
   * module, which applies the full gate ladder.
   */
  listCandidateMemories(options: {
    namespace: string;
    abortSignal?: AbortSignal;
  }): Promise<MemoryFile[]>;
  /**
   * Resolve the trust-zone record for a memory.  Returns `null` when
   * the memory has no trust-zone record (treated as not trusted).
   */
  trustZoneFor(memoryId: string): Promise<TrustZoneName | null>;
  /**
   * Resolve a calibrated importance score in [0, 1] for a memory.
   */
  importanceFor(memory: MemoryFile): number;
  /**
   * Taxonomy used to classify memories into direct-answer buckets.
   */
  taxonomy: Taxonomy;
}

export interface DirectAnswerWiringInput {
  query: string;
  namespace: string;
  config: Pick<
    PluginConfig,
    | "recallDirectAnswerTokenOverlapFloor"
    | "recallDirectAnswerImportanceFloor"
    | "recallDirectAnswerAmbiguityMargin"
    | "recallDirectAnswerEligibleTaxonomyBuckets"
  >;
  /**
   * Direct-answer capability gate, resolved once at the recall-operation entry
   * via `resolveCapabilities(config).recallDirectAnswer` (issue #1523). This
   * is the sole gate — the function no longer reads the config flag directly.
   * Callers MUST pass the resolved capability so the whole operation agrees on
   * a single gate value.
   */
  enabled: boolean;
  sources: DirectAnswerSources;
  queryEntityRefs?: string[];
  abortSignal?: AbortSignal;
}

/**
 * Attempt direct-answer resolution.  Returns the eligibility verdict
 * produced by `isDirectAnswerEligible` with candidates materialized
 * from the caller-supplied sources.
 */
export async function tryDirectAnswer(
  input: DirectAnswerWiringInput,
): Promise<DirectAnswerResult> {
  const { query, namespace, config, enabled, sources, queryEntityRefs, abortSignal } = input;

  const eligibilityConfig: DirectAnswerConfig = {
    enabled,
    tokenOverlapFloor: config.recallDirectAnswerTokenOverlapFloor,
    importanceFloor: config.recallDirectAnswerImportanceFloor,
    ambiguityMargin: config.recallDirectAnswerAmbiguityMargin,
    eligibleTaxonomyBuckets: config.recallDirectAnswerEligibleTaxonomyBuckets,
  };

  // Short-circuit disabled case before touching any I/O.
  if (!eligibilityConfig.enabled) {
    return isDirectAnswerEligible({
      query,
      candidates: [],
      config: eligibilityConfig,
      queryEntityRefs,
    });
  }

  // Short-circuit empty-query case before any I/O.  isDirectAnswerEligible
  // deterministically returns reason "empty-query" when the query
  // normalizes to zero searchable tokens; there's no point materializing
  // candidates just to reach the same verdict, and doing so would
  // surface avoidable upstream errors for requests that should exit
  // immediately.
  if (normalizeRecallTokens(query).length === 0) {
    return isDirectAnswerEligible({
      query,
      candidates: [],
      config: eligibilityConfig,
      queryEntityRefs,
    });
  }

  throwIfAborted(abortSignal, "direct-answer wiring aborted");
  const memories = await sources.listCandidateMemories({ namespace, abortSignal });
  throwIfAborted(abortSignal, "direct-answer wiring aborted");
  const candidates: DirectAnswerCandidate[] = [];

  for (const memory of memories) {
    // Throw rather than returning a partial verdict — a mid-loop abort
    // that left competing candidates unprocessed could otherwise surface
    // a spurious "eligible" result that the ambiguity gate never got a
    // chance to reject.  The check repeats after every await so an
    // abort that lands during the in-flight I/O on the final memory
    // (after which no further iteration would exist) still stops us.
    throwIfAborted(abortSignal, "direct-answer wiring aborted");

    const trustZone = await sources.trustZoneFor(memory.frontmatter.id);
    throwIfAborted(abortSignal, "direct-answer wiring aborted");

    // Cheap pre-filter: non-trusted memories can't qualify, so skip
    // taxonomy and importance resolution for them.
    if (trustZone !== "trusted") continue;

    const decision = resolveCategory(
      memory.content,
      memory.frontmatter.category,
      sources.taxonomy,
    );
    const taxonomyBucket = decision.categoryId;
    if (!eligibilityConfig.eligibleTaxonomyBuckets.includes(taxonomyBucket)) continue;

    const importanceScore = sources.importanceFor(memory);

    candidates.push({
      memory,
      trustZone,
      taxonomyBucket,
      importanceScore,
    });
  }

  // Final check — if abort landed during the trust-zone await for the
  // last memory, the loop condition no longer fires.  Guard before we
  // hand candidates to the eligibility gate.
  throwIfAborted(abortSignal, "direct-answer wiring aborted");

  return isDirectAnswerEligible({
    query,
    candidates,
    config: eligibilityConfig,
    queryEntityRefs,
  });
}
