# Merge decisions fail closed to create, treat the judge verdict as untrusted, and compare canonicalized provenance

Status: accepted

## Context
Judge-mediated merge-on-write rewrites a neighbor memory's body, so a wrong merge destroys content. The judge is an LLM: it can fabricate target ids, echo stale data, or return unparseable config. Supporting heuristics (timestamp comparison, content sanitization, pattern caches, vocabulary-derived regexes) each had subtle correctness bugs.

## Decision
Merging fails closed to "create" on any uncertainty: similarity 0 disables merging entirely before any embedding backend call; a throwing (not merely empty) lookup is a backend failure distinct from an empty index; merge selection is stricter than the novelty and semantic-dedup gates because a merge REWRITES the neighbor's body. The parsed judge verdict is UNVALIDATED input — hard post-validation re-checks that the target id exists and is eligible; the persisted target body is compared against what the judge actually merged to catch staleness. semanticMerge config is parsed strictly: invalid input is rejected, never silently defaulted; an absent key is distinguished from a present-but-unparseable value; own-property presence checks avoid prototype-chain reads; a refused category configures a gate that can never fire. Candidate lookup overfetches maxCandidates by a fixed factor and truncates to ELIGIBLE neighbors only, so ineligible hits cannot crowd out a valid target; the eligible band is [minSimilarity, dedupThreshold), with the upper edge owned by the near-duplicate skip path. Candidate ordering is a total order: similarity descending, then memoryId ascending. Timestamp comparison classifies both sides as a pair when unparseable (NaN) so the comparator stays antisymmetric and the winner never depends on array order. Provenance timestamps require full ISO 8601 instants whose calendar components round-trip (Date.parse alone accepts "123" and rolls 2026-02-30 into March); provenance clones copy every canonical field including optional ones, or "append provenance" becomes "erase provenance". A merged body the content sanitizer would rewrite is refused BEFORE the length check — it can never round-trip through storage, and refusing makes the merge a create with no mutation. The merge snapshot trigger stays a literal union type; a widened type would let an unknown trigger compile and fail readManifest at runtime. The dedup pattern cache is invalidated by size-keyed content (a same-size swap must not serve the stale pattern), the negation strip pattern is derived from the NEGATION_WORDS vocabulary (keyed on alternation content so any vocabulary change rebuilds it), pairwise comparison is O(n^2) but bounded by maxLoad, and punctuation/positions are compared before normalization's exact/hash paths. Connector-aware scoping applies to the novelty and semantic gates themselves (see the write-gates decision).

## Consequences
Marginal merges become creates — the corpus keeps near-duplicates that a lenient judge would have merged. Strict config parsing surfaces operator mistakes as errors. The overfetch factor trades one larger query for judge-input correctness.

## Origin comments
- `packages/remnic-core/src/dedup/index.test.ts:204` — "// Same-size swap: the size-keyed cache would keep serving the stale pattern."
- `packages/remnic-core/src/dedup/index.ts:109` — "// Compare all pairs (O(n^2) but bounded by maxLoad)"
- `packages/remnic-core/src/dedup/index.ts:163` — "// Compare punctuation and positions before normalization's exact/hash paths."
- `packages/remnic-core/src/dedup/index.ts:324` — "// Single vocabulary source: the strip pattern is derived from NEGATION_WORDS,"
- `packages/remnic-core/src/dedup/index.ts:325` — "// never hand-maintained. Keyed on the alternation content so any vocabulary"
- `packages/remnic-core/src/dedup/index.ts:326` — "// change (not just a size change) rebuilds the pattern."
- `packages/remnic-core/src/dedup/merge-content.test.ts:34` — "// Storage persists sanitizeMemoryContent(text).text — an injection-pattern"
- `packages/remnic-core/src/dedup/merge-content.test.ts:35` — "// body would be rewritten to the redaction placeholder on write, so the"
- `packages/remnic-core/src/dedup/merge-content.test.ts:36` — "// merge that committed it could never verify its own rollback equality."
- `packages/remnic-core/src/dedup/merge-content.test.ts:37` — "// Unsafe outranks the length limit: the refusal names the safety problem"
- `packages/remnic-core/src/dedup/merge-content.test.ts:38` — "// even when the body is also oversized."
- `packages/remnic-core/src/dedup/merge-content.ts:38` — "// Storage persists `sanitizeMemoryContent(text).text`, so a merged body the"
- `packages/remnic-core/src/dedup/merge-content.ts:39` — "// sanitizer would rewrite can never round-trip: the persist-side CAS and"
- `packages/remnic-core/src/dedup/merge-content.ts:40` — "// provenance equality checks compare the RAW judge output, and a target"
- `packages/remnic-core/src/dedup/merge-content.ts:41` — "// holding the sanitization placeholder reads back as a concurrent"
- `packages/remnic-core/src/dedup/merge-content.ts:42` — "// replacement — the rollback then "succeeds" while the original body is"
- `packages/remnic-core/src/dedup/merge-content.ts:43` — "// lost and the caller also creates the fact. Refusing here means the merge"
- `packages/remnic-core/src/dedup/merge-content.ts:44` — "// decision becomes a create and no mutation ever runs. Checked before the"
- `packages/remnic-core/src/dedup/merge-content.ts:45` — "// length limit: an injection-pattern body is refused as unsafe whatever its"
- `packages/remnic-core/src/dedup/merge-content.ts:46` — "// length."
- `packages/remnic-core/src/dedup/merge-decision.test.ts:130` — "// Two unparseable timestamps must not make the comparator asymmetric: testing"
- `packages/remnic-core/src/dedup/merge-decision.test.ts:131` — "// each side against NaN independently returned 1 for both orderings, so the"
- `packages/remnic-core/src/dedup/merge-decision.test.ts:132` — "// winner depended on array order."
- `packages/remnic-core/src/dedup/merge-decision.ts:33` — "// Date.parse never throws; unparseable timestamps yield NaN and sort last."
- `packages/remnic-core/src/dedup/merge-decision.ts:34` — "// NaN !== NaN, so the two sides must be classified as a pair: testing each"
- `packages/remnic-core/src/dedup/merge-decision.ts:35` — "// independently returned 1 for BOTH orderings when both were unparseable,"
- `packages/remnic-core/src/dedup/merge-decision.ts:36` — "// which breaks antisymmetry and made the winner depend on array order."
- `packages/remnic-core/src/dedup/merge-provenance.test.ts:153` — "// Date.parse alone accepts "123" and rolls 2026-02-30 into March; the value is"
- `packages/remnic-core/src/dedup/merge-provenance.test.ts:154` — "// echoed verbatim into frontmatter, so the full ISO shape is required."
- `packages/remnic-core/src/dedup/merge-provenance.ts:41` — "/** * Require a full ISO 8601 instant whose calendar components round-trip. * `Date.parse` alone accepts `123` and rolls"
- `packages/remnic-core/src/dedup/merge-provenance.ts:54` — "// Reject a rolled-over calendar date (2026-02-30 -> 2026-03-02)."
- `packages/remnic-core/src/dedup/merge-provenance.ts:85` — "// Copy every canonical field, including the optional ones: dropping"
- `packages/remnic-core/src/dedup/merge-provenance.ts:86` — "// observedAt or the offsets here would make the serializer discard the"
- `packages/remnic-core/src/dedup/merge-provenance.ts:87` — "// clone, turning "append provenance" into "erase provenance"."
- `packages/remnic-core/src/dedup/merge.test.ts:54` — "// The merge snapshot trigger must stay a literal union: a widened"
- `packages/remnic-core/src/dedup/merge.test.ts:55` — "// `VersionTrigger` (e.g. annotated `readonly string[]`) would let an unknown"
- `packages/remnic-core/src/dedup/merge.test.ts:56` — "// trigger compile and then fail `readManifest` at runtime."
- `packages/remnic-core/src/dedup/merge.ts:1` — "Judge-mediated merge-on-write decision (issue #2330, harmonic 2/5)... fails closed to "create""
- `packages/remnic-core/src/dedup/merge.ts:38` — "Raw (parsed but UNVALIDATED) judge verdict... an LLM-fabricated targetId must never survive"
- `packages/remnic-core/src/dedup/merge.ts:78` — "The target body the judge actually merged. The persist side must compare it against the target..."
- `packages/remnic-core/src/dedup/merge.ts:111` — "Total order: similarity desc, then memoryId asc (checklist #12)."
- `packages/remnic-core/src/dedup/merge.ts:122` — "0 disables merging entirely — short-circuit BEFORE the lookup so no embedding backend call is made"
- `packages/remnic-core/src/dedup/merge.ts:131` — "Lookup throws = backend down (distinct from an empty index, #22)."
- `packages/remnic-core/src/dedup/merge.ts:132` — "Round N+17 (A): the fetch deliberately OVERSHOOTS maxCandidates... ineligible hits crowd out a valid target"
- `packages/remnic-core/src/dedup/merge.ts:168` — "Band: [minSimilarity, dedupThreshold). The upper edge is owned by the near-duplicate skip path"
- `packages/remnic-core/src/dedup/merge.ts:189` — "Eligible-first truncation (round N+17 A): the judge sees up to maxCandidates ELIGIBLE neighbors"
- `packages/remnic-core/src/dedup/merge.ts:209` — "Hard post-validation: never trust the model to echo ids."
- `packages/remnic-core/src/dedup/merge.ts:240` — "The categories semanticMerge.categories may name... refused category configures a gate that can never fire"
- `packages/remnic-core/src/dedup/merge.ts:254` — "Round N+17 (A): the neighbor fetch overshoots maxCandidates by this factor so eligibility filtering happens BEFORE truncation"
- `packages/remnic-core/src/dedup/merge.ts:272` — "Parse the semanticMerge block (issue #2330)... Invalid input is rejected, never silently defaulted"
- `packages/remnic-core/src/dedup/merge.ts:296` — "Own-property presence (checklist #46): a bracket read follows the prototype chain"
- `packages/remnic-core/src/dedup/merge.ts:330` — "Round N+2 (D) — distinguish an ABSENT key from a present-but-unparseable value (#1/#39/#45)..."
- `packages/remnic-core/src/dedup/semantic.test.ts:248` — "// ── Connector-aware semantic dedup (PR #1852 review finding on 7e0eb1a0) ──────"
- `packages/remnic-core/src/dedup/semantic.test.ts:249` — "//"
- `packages/remnic-core/src/dedup/semantic.test.ts:250` — "// A provenance-bearing candidate (sourceConnector present) may be suppressed"
- `packages/remnic-core/src/dedup/semantic.test.ts:251` — "// only by a near-duplicate from the SAME connector. A different or absent"
- `packages/remnic-core/src/dedup/semantic.test.ts:252` — "// neighbor connector must NOT suppress the write. Operator/unattributed"
- `packages/remnic-core/src/dedup/semantic.test.ts:253` — "// writes (no candidate connector) preserve the original behavior."
