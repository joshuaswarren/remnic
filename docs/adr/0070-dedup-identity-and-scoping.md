# Dedup, temporal backfill, and identity lookups are namespace-scoped, tier-complete, and authoritative-index-first

Status: accepted

## Context
The same fact text can exist in two namespaces, hot and cold tiers hold different copies, promotions race the fact-dedup commit window, and several subsystems (verified recall, semantic dedup) each need the full memory list. Cross-tenant similarity hits, hot-tier-only lookups, and stale hash files each caused real suppression or resurrection bugs.

## Decision
- Semantic dedup and nearest-neighbor lookups are namespace-scoped (PR #399): a lookup miss in another namespace must never suppress a write. The write path throws on backend-unavailable so callers report backend_unavailable (the recall path stays fail-open); neighbor sourceConnector is attached when readable.
- Content-hash membership answers from a fact-ONLY set kept in lockstep with shared removal, and saves reconcile so removal never resurrects a hash or clobbers a concurrent extraction's append; deferred lock-timeout reconciles drain at lifecycle boundaries.
- Temporal-bound backfill on a promoted/deduped copy is best-effort fail-open, entity-guarded (reject only a DIFFERENT entity), connector-exact, scans hot+cold tiers, scans only when a recall-relevant bound exists, and no-clobbers by equality — never provenance inference.
- Temporal/tag indexes are built whenever EITHER consumer is enabled, checked-and-bootstrapped from a single corpus read spanning configured namespaces, cold-aware on missing ids, and a full rebuild always writes (possibly empty) indexes to mark bootstrap completion so later extractions skip the scan.
- Promotion writes inside the fact-dedup commit window suppress a raced twin via the authoritative index (miss answers without a corpus scan; scan error is fail-open and never suppresses), run post-write supersession against the winning copy so no conflicting fact stays active, are fact-only (other categories skip the window), and anchor ordering on the winner.
- getMemoryById is hot-tier only; merge survivors fall back to a cold-aware id lookup. Repeat full-list reads share one version-keyed hot-memories cache per storage instance; a write bumps the corpus version and forces exactly one rescan.
- Result identity is (namespace, path) so cross-namespace same-path hits don't collapse; catalog read touches are recorded only when retrieval actually runs; principal resolution honours the access-surface override so ACL decisions use the identity the transport authorized; historical asOf filtering uses one parse per recall and treats malformed input as "no pin".

## Consequences
A write is suppressed only by evidence from the same tenant and tier-complete corpus, and raced promotions converge to one winner with supersession applied. The cost is tier-aware lookups everywhere hot-only reads once sufficed, and index bookkeeping per write path.

## Origin comments

- `packages/remnic-core/src/orchestration/persistence-index.ts:93` — "PR #2016: hasFactContentHash answers from a fact-ONLY membership set; keep it in lockstep with shared removal"
- `packages/remnic-core/src/orchestration/persistence-index.ts:106` — "Issue #1671 — backfill bi-temporal bounds onto an existing promoted/deduped copy; best-effort fail-open"
- `packages/remnic-core/src/orchestration/persistence-index.ts:141` — "#1707 thread 2 — per-fact start bound (valid_at) carried for corrected per-fact anchoring"
- `packages/remnic-core/src/orchestration/persistence-index.ts:152` — "I/O gate: scan only when there is a recall-relevant bound to backfill; assumed validFrom scans for no benefit"
- `packages/remnic-core/src/orchestration/persistence-index.ts:167` — "Normalize the entity for same-entity scoping — two entities can share identical fact text"
- `packages/remnic-core/src/orchestration/persistence-index.ts:173` — "#2016 cold-tier finding: hash rebuild unions hot+cold tiers, so scan both or the corrected write is suppressed"
- `packages/remnic-core/src/orchestration/persistence-index.ts:186` — "Same-entity guard: reject only DIFFERENT entity; legacy no-entityRef facts stay eligible (cursor PRRT_OvKnV)"
- `packages/remnic-core/src/orchestration/persistence-index.ts:200` — "Connector identity guard: exact match incl. undefined; without it .find() selects first hash/entity match"
- `packages/remnic-core/src/orchestration/persistence-index.ts:213` — "Prefer the stored contentHash — computed from contentHashSource, matching dedupContent"
- `packages/remnic-core/src/orchestration/persistence-index.ts:219` — "Legacy facts without stored hash: strip citations then compare normalized bodies"
- `packages/remnic-core/src/orchestration/persistence-index.ts:244` — "No-clobber via equality, not provenance inference — the only no-clobber holding without a fragile heuristic"
- `packages/remnic-core/src/orchestration/persistence-index.ts:266` — "Mark the copy extracted-anchored in the SAME patch so provenance reflects the correction"
- `packages/remnic-core/src/orchestration/persistence-index.ts:289` — "Reconciling save: removal never resurrects a hash, never clobbers a concurrent extraction's append (#1909)"
- `packages/remnic-core/src/orchestration/persistence-index.ts:310` — "Drain deferred lock-timeout reconcile retries at lifecycle boundary; retries are unref'd (PR #2016 finding 3)"
- `packages/remnic-core/src/orchestration/persistence-index.ts:341` — "#2330: getMemoryById is HOT-tier only; fall back to cold-aware id lookup for merge survivors"
- `packages/remnic-core/src/orchestration/persistence-index.ts:453` — "Recognition-index write-path (issue #2975): independent of temporal capability gates; off-path is zero index I/O"
- `packages/remnic-core/src/orchestration/persistence-index.ts:457` — "Build temporal/tag indexes whenever either consumer is enabled; enabling only one silently yields an empty index"
- `packages/remnic-core/src/orchestration/persistence-index.ts:468` — "Check for missing indexes BEFORE the early-return so first-time enablement can bootstrap the full corpus"
- `packages/remnic-core/src/orchestration/persistence-index.ts:473` — "Read the corpus once to avoid N separate scans; on full rebuild span all configured namespaces"
- `packages/remnic-core/src/orchestration/persistence-index.ts:489` — "Bootstrap indexes active only; readAllMemories is HOT-tier only, so fetch missing ids cold-aware (PR #2771)"
- `packages/remnic-core/src/orchestration/persistence-index.ts:539` — "Always write empty indexes on full rebuild — marks bootstrap completion so later extractions skip the scan"
- `packages/remnic-core/src/orchestration/persistence-index.ts:558` — "Issue #373 nearest-neighbor lookup; fail-open; PR #399 P1 namespace scoping prevents cross-tenant suppression"
- `packages/remnic-core/src/orchestration/persistence-index.ts:578` — "Round 6 fix (Finding 3): backend-unavailable must THROW so decideSemanticDedup reports backend_unavailable"
- `packages/remnic-core/src/orchestration/persistence-index.ts:599` — "search() may throw — propagate; throwOnTimeout:true (Round 10, Ui1J+Ui1L) vs recall-path fail-open []"
- `packages/remnic-core/src/orchestration/persistence-index.ts:607` — "PR #1852 review: attach neighbor sourceConnector for the connector-aware skip gate; read failure leaves it absent"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:1` — "Promotion destination writes under the fact-dedup commit window (#3311): twin promotion suppressed, not duplicated"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:53` — "Promotion DESTINATION storage — the commit window is keyed on its dir."
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:75` — "Suppression path runs post-write supersession against the winning copy (PRRT_kwDORJXyws6z18qb)"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:80` — "Caller's lifecycleCaps.temporalSupsession required — without it the pass must not run even when the gate passes"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:105` — "Locate the active same-destination fact a raced promotion would duplicate; scan error = fail-open, never suppress"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:149` — "In-window race confirm: authoritative index + miss answers WITHOUT the corpus scan (window contract PRRT_…18qS)"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:178` — "Presence-iff-set extras, byte-equivalent to the conditional spreads the persist closure previously inlined"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:218` — "The recheck is fact-only; for other categories the window adds lock risk with no dedup value"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:267` — "Suppressed promotion must also run temporal supersession, or a raced promotion leaves a conflicting fact active"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:287` — "The winner ANCHORS the pass, so the lookup is always entity-guarded (PR #402 Uybg hazard)"
- `packages/remnic-core/src/orchestration/promotion-dedup-window.ts:299` — "Ordering anchor mirrors the gate's supersessionOrderingAt: event date orders the pass, wall clock otherwise"
- `packages/remnic-core/src/orchestration/recall-internal.ts:140` — "// Issue #680 — historical recall. Parse `options.asOf` once at the"
- `packages/remnic-core/src/orchestration/recall-internal.ts:141` — "// top of the recall so each boost-pass uses identical filter logic."
- `packages/remnic-core/src/orchestration/recall-internal.ts:142` — "// Invalid values are rejected at input boundaries (CLI / HTTP / MCP)"
- `packages/remnic-core/src/orchestration/recall-internal.ts:143` — "// per CLAUDE.md rule 51; if a malformed value sneaks through here,"
- `packages/remnic-core/src/orchestration/recall-internal.ts:144` — "// we treat it as "no historical pin" rather than throwing inside"
- `packages/remnic-core/src/orchestration/recall-internal.ts:145` — "// recall — the upstream surfaces are the source of truth."
- `packages/remnic-core/src/orchestration/recall-internal.ts:377` — "// Principal resolution honours the access-surface override (issue"
- `packages/remnic-core/src/orchestration/recall-internal.ts:378` — "// #570 PR 4). Access surfaces that have already authenticated the"
- `packages/remnic-core/src/orchestration/recall-internal.ts:379` — "// caller at the transport layer (HTTP / MCP) pass their resolved"
- `packages/remnic-core/src/orchestration/recall-internal.ts:380` — "// principal directly so namespace ACL decisions use the same"
- `packages/remnic-core/src/orchestration/recall-internal.ts:381` — "// identity the surface authorized, instead of re-running"
- `packages/remnic-core/src/orchestration/recall-internal.ts:382` — "// `resolvePrincipal(sessionKey)` which only maps raw session keys"
- `packages/remnic-core/src/orchestration/recall-internal.ts:383` — "// through configured rules and otherwise collapses to `"default"`."
- `packages/remnic-core/src/orchestration/recall-internal.ts:408` — "// Catalog read touch (issue #1499) is recorded LATER — after the Phase 1"
- `packages/remnic-core/src/orchestration/recall-internal.ts:409` — "// abort gate — so it fires only when retrieval actually runs, not for"
- `packages/remnic-core/src/orchestration/recall-internal.ts:410` — "// aborted / short-circuited recalls."
- `packages/remnic-core/src/orchestration/recall-internal.ts:663` — "// Catalog read touch (issue #1499): record reads against the recalled"
- `packages/remnic-core/src/orchestration/recall-internal.ts:664` — "// namespaces HERE — after the abort gate, immediately before retrieval"
- `packages/remnic-core/src/orchestration/recall-internal.ts:665` — "// actually runs — so `lastReadAt` reflects a real read, not a recall that was"
- `packages/remnic-core/src/orchestration/recall-internal.ts:666` — "// aborted/errored/short-circuited before reaching this point (round 3/4/6,"
- `packages/remnic-core/src/orchestration/recall-internal.ts:667` — "// codex/cursor — no_recall, zero-limit, aborted, and pre-read-error cases)."
- `packages/remnic-core/src/orchestration/recall-internal.ts:668` — "// `no_recall` already returned earlier, so it cannot reach here. Best-effort"
- `packages/remnic-core/src/orchestration/recall-internal.ts:669` — "// and failure-tolerant."
- `packages/remnic-core/src/orchestration/recall-internal.ts:1539` — "// Verified recall and semantic rules both need readAllMemories()."
- `packages/remnic-core/src/orchestration/recall-internal.ts:1540` — "// Instead of a shared preload (which has namespace/dir mismatch issues),"
- `packages/remnic-core/src/orchestration/recall-internal.ts:1541` — "// each subsystem calls readAllMemories() on its correct storage instance."
- `packages/remnic-core/src/orchestration/recall-internal.ts:1542` — "// The version-keyed hot-memories cache (keyed by baseDir + the corpus"
- `packages/remnic-core/src/orchestration/recall-internal.ts:1543` — "// version sentinel, issue #1902) serves repeat reads within a version epoch"
- `packages/remnic-core/src/orchestration/recall-internal.ts:1544` — "// from memory, so these subsystems share one disk scan; a memory write"
- `packages/remnic-core/src/orchestration/recall-internal.ts:1545` — "// between recalls bumps the corpus version and forces exactly one rescan."
- `packages/remnic-core/src/orchestration/recall-internal.ts:2168` — "// Derive agent-hit namespace so a same (namespace,path) memory merges once (#2020)."
- `packages/remnic-core/src/orchestration/recall-internal.ts:3852` — "// (namespace, path) id so cross-namespace same-path hits don't collapse; LLM-safe + cache-stable (#2020)."
