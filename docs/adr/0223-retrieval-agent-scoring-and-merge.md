# Specialized retrieval agents must keep globally unique absolute paths and complementary scoring signals

Status: accepted

## Context

Recall merges results from several specialized agents (direct entity lookup, temporal, tag/contextual) on top of a recency-ordered base. The agents index disjoint sets of files (entity pages never appear in the temporal or tag indexes), and their scores are computed by different mechanisms, so a naive merge either drops whole result classes or biases scores. Agent identities must also survive namespace merges without re-derivation.

## Decision

Agent result paths are kept absolute; only the owning namespace is stamped on fanout hits, so the namespace carries through merge and tracking without re-deriving it. A namespace stamp is a no-op without a resolver.

Both edges of the recency window are derived from one function so fromDate/toDate always use consistent pattern-matching and priority ordering.

Query tokenization strips purely temporal words and common stopwords before tag-based relevance boosting, so the topical signal reflects the subject asked about, not the time window itself. First-seen tokens win, keeping query expansion deterministic.

The tag index is loaded fail-open: if unavailable, topicBoost is 0 and ordering degrades gracefully to recency-only.

Direct agent results (entities/*.md) intentionally bypass the candidatePaths prefilter: that filter is built from temporal + tag indexes, which never include entity files, so applying it would silently drop all direct-agent results on scoped queries. Entity files are already query-scoped by filename matching, and temporal results are scoped inside the temporal agent before its top-K cap.

Contextual results are NOT capped before the merge: the contextual fetch over-fetches so downstream phases (graph expansion, lifecycle filtering, reranking) can drop candidates; capping earlier removes that headroom.

If no specialized agent contributed anything, reweighting is skipped entirely — applying the contextual weight penalty with zero benefit would silently reduce every score by ~30% versus the non-augmented path.

In the three-way merge, contextual results go first so their snippets survive when a higher-scoring direct/temporal result overrides the same path.

## Consequences

Fail-open paths can silently degrade relevance without signalling; the bypass rules mean adding a new index type requires revisiting which agents may filter through candidatePaths. Query expansion is order-dependent on first-seen tokens by design.

## Origin comments

- `packages/remnic-core/src/retrieval-agents.ts:127` — "// fanout hits are also absolute (globally-unique identity), so we keep the"
- `packages/remnic-core/src/retrieval-agents.ts:128` — "// agent path absolute and only stamp the owning namespace here — that carries"
- `packages/remnic-core/src/retrieval-agents.ts:129` — "// the namespace through merge/tracking without re-deriving it (#2020). No-op"
- `packages/remnic-core/src/retrieval-agents.ts:130` — "// without a resolver."
- `packages/remnic-core/src/retrieval-agents.ts:246` — "// Derive both window edges from the same function so fromDate/toDate always use"
- `packages/remnic-core/src/retrieval-agents.ts:247` — "// consistent pattern-matching and priority ordering."
- `packages/remnic-core/src/retrieval-agents.ts:270` — "// Extract non-temporal topic tokens for tag-based relevance boost."
- `packages/remnic-core/src/retrieval-agents.ts:271` — "// Purely temporal words (dates, relative time) and common stopwords are stripped"
- `packages/remnic-core/src/retrieval-agents.ts:272` — "// so the signal reflects the subject the user is asking about (e.g. \"auth\" in"
- `packages/remnic-core/src/retrieval-agents.ts:273` — "// \"what changed in auth last week\"), not the time window itself."
- `packages/remnic-core/src/retrieval-agents.ts:288` — "// Load tag index for topical scoring, in parallel with existence checks."
- `packages/remnic-core/src/retrieval-agents.ts:289` — "// Fail-open: if the tag index is unavailable, topicBoost = 0 and scores"
- `packages/remnic-core/src/retrieval-agents.ts:290` — "// degrade gracefully to recency-only ordering (existing behaviour)."
- `packages/remnic-core/src/retrieval-agents.ts:601` — "// Direct agent results (entities/) intentionally bypass candidatePaths."
- `packages/remnic-core/src/retrieval-agents.ts:602` — "//"
- `packages/remnic-core/src/retrieval-agents.ts:603` — "// Why: candidatePaths is built from temporal + tag indexes, which never include"
- `packages/remnic-core/src/retrieval-agents.ts:604` — "// entity files (entities/*.md). Applying the filter here would silently drop ALL"
- `packages/remnic-core/src/retrieval-agents.ts:605` — "// direct-agent results for any scoped query, making the direct agent a no-op."
- `packages/remnic-core/src/retrieval-agents.ts:606` — "// Entity files are identified by filename matching (query tokens vs. entity name),"
- `packages/remnic-core/src/retrieval-agents.ts:607` — "// so they are already query-scoped independently of the time/tag prefilter."
- `packages/remnic-core/src/retrieval-agents.ts:608` — "// Temporal results are scoped inside runTemporalAgent() before the top-K cap."
- `packages/remnic-core/src/retrieval-agents.ts:611` — "// Tag contextual results with their source so they can participate in weighted merge."
- `packages/remnic-core/src/retrieval-agents.ts:612` — "// We do NOT cap contextual here: contextualResults comes from fetchQmdMemoryResultsWithArtifactTopUp"
- `packages/remnic-core/src/retrieval-agents.ts:613` — "// which intentionally over-fetches so downstream phases (graph expansion, lifecycle filtering,"
- `packages/remnic-core/src/retrieval-agents.ts:614` — "// reranking) can drop candidates. Capping before the merge would remove that headroom."
- `packages/remnic-core/src/retrieval-agents.ts:624` — "// If no specialized agents contributed anything (e.g. fresh setup without entities/ or temporal"
- `packages/remnic-core/src/retrieval-agents.ts:625` — "// index), skip reweighting entirely — applying the contextual weight penalty with zero benefit"
- `packages/remnic-core/src/retrieval-agents.ts:626` — "// would silently reduce every result score by ~30% compared to the non-augmented path."
- `packages/remnic-core/src/retrieval-agents.ts:631` — "// Merge all three; contextual first so its snippets are preserved when a higher-scoring"
- `packages/remnic-core/src/retrieval-agents.ts:632` — "// direct/temporal result overrides the same path (see mergeAgentResults snippet logic)."
- `packages/remnic-core/src/retrieval-agents.ts:633` — "// Note: maxPerAgent=0 is handled by the early-return guard above; we never reach here with 0."
- `packages/remnic-core/src/retrieval-agents.ts:716` — "// Contextual results go first so their snippets are preserved when a higher-scoring"
- `packages/remnic-core/src/retrieval-agents.ts:717` — "// direct/temporal result overrides the same path in mergeAgentResults."
- `packages/remnic-core/src/retrieval.ts:76` — "// Keep deterministic ordering: first-seen tokens win."
