# Hash dedup guards duplicate shared-memory promotion

Status: accepted

## Context
A duplicate write wastes a fact slot and leaves two competing shared facts. Early-return dedup fixes that, but the naive version loses promotions when the lookup itself fails, and raw-body or order-sensitive hashing silently picks wrong candidates or misses duplicates. Normalization and enriched comparison make the hash a reliable identity for "the same fact".

## Decision
Before promoting a memory to shared, the orchestrator checks a content-hash index and returns early when an identical active shared fact already exists, instead of writing a second copy.

Rules:
- The dedup check runs before any write, and a positive hash match short-circuits the write entirely; the hash index is updated only after a successful write, so a failed lookup never suppresses promotion (the catch path falls through to the write).
- Dedup comparison uses the ENRICHED content (raw text plus structured attributes), not the raw body, so two facts with the same base text but different structuredAttributes resolve to distinct candidates; the normalized incoming string must be built from the sanitized content actually stored on disk, or the candidate lookup misses and stale facts stay active.
- Hashing canonicalizes content through a shared normalizer (trim, lowercase, collapse whitespace); structured attributes are serialized with sorted keys so identical content with different key order produces the same hash.
- Supersession key components share one `normalizeSupersessionKey` helper so comparisons cannot drift from the canonical key form used to build keys elsewhere.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/temporal-supersession.test.ts:2601` — "Simulate what promoteMemoryToShared now does: check before writing."
- `packages/remnic-core/src/temporal-supersession.test.ts:2602` — "If hasFactContentHash returns true, the orchestrator returns early WITHOUT"
- `packages/remnic-core/src/temporal-supersession.test.ts:2603` — "calling writeMemory again. A second writeMemory here represents the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2604` — "duplicate that the Fix #1 `return` prevents."
- `packages/remnic-core/src/temporal-supersession.test.ts:2626` — "If readAllMemories() throws, hashDedupLookupComplete remains false and"
- `packages/remnic-core/src/temporal-supersession.test.ts:2627` — "hashDedupMatchingFact remains undefined. The catch block must NOT return"
- `packages/remnic-core/src/temporal-supersession.test.ts:2628` — "early in this case — returning would permanently lose the shared promotion"
- `packages/remnic-core/src/temporal-supersession.test.ts:2629` — "because we don't actually know a duplicate exists. Instead it should fall"
- `packages/remnic-core/src/temporal-supersession.test.ts:2630` — "through to the write path. This test validates the invariant: after a failed"
- `packages/remnic-core/src/temporal-supersession.test.ts:2631` — "lookup the hash index should remain consistent with a completed write"
- `packages/remnic-core/src/temporal-supersession.test.ts:2632` — "(i.e., the enriched content ends up in the index after a successful write)."
- `packages/remnic-core/src/temporal-supersession.test.ts:2688` — "hasFactContentHash is called with dedupContent (enriched: raw + [Attributes:])."
- `packages/remnic-core/src/temporal-supersession.test.ts:2689` — "The matchingFact lookup must also compare against the enriched body, not the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2690` — "raw body. If two active shared facts share the same base text but differ in"
- `packages/remnic-core/src/temporal-supersession.test.ts:2691` — "structuredAttributes, the raw comparison selects the wrong candidate."
- `packages/remnic-core/src/temporal-supersession.test.ts:2744` — "Core invariant for Fix #2: hasFactContentHash(enrichedA) returns true and"
- `packages/remnic-core/src/temporal-supersession.test.ts:2745` — "only factA's stored content matches enrichedA. This proves that an"
- `packages/remnic-core/src/temporal-supersession.test.ts:2746` — "enriched-hash comparator (using the full stored content) correctly identifies"
- `packages/remnic-core/src/temporal-supersession.test.ts:2747` — "factA as the dedup candidate, not factB."
- `packages/remnic-core/src/temporal-supersession.test.ts:2817` — "Regression for P2 PRRT_kwDORJXyws56VHZc:"
- `packages/remnic-core/src/temporal-supersession.test.ts:2818` — "Two writes with identical content + same attributes but different key order"
- `packages/remnic-core/src/temporal-supersession.test.ts:2819` — "must produce the same hash so the second write is caught by hasFactContentHash."
- `packages/remnic-core/src/temporal-supersession.test.ts:2870` — "Regression for P2 PRRT_kwDORJXyws56VHZf (fix #2 / #4):"
- `packages/remnic-core/src/temporal-supersession.test.ts:2871` — "The orchestrator's candidate lookup uses ContentHashIndex.normalizeContent(dedupContent)"
- `packages/remnic-core/src/temporal-supersession.test.ts:2872` — "to find the stored fact. writeMemory stores the SANITIZED enriched content."
- `packages/remnic-core/src/temporal-supersession.test.ts:2873` — "If dedupContent is built from raw (injection-containing) content, the normalized"
- `packages/remnic-core/src/temporal-supersession.test.ts:2874` — "incoming string diverges from the stored content, causing the candidate lookup"
- `packages/remnic-core/src/temporal-supersession.test.ts:2875` — "to miss and leaving stale facts active."
- `packages/remnic-core/src/temporal-supersession.test.ts:2877` — "Fix: build dedupContent from sanitizedBase.text so normalizedIncoming matches"
- `packages/remnic-core/src/temporal-supersession.test.ts:2878` — "what is actually stored on disk."
- `packages/remnic-core/src/temporal-supersession.ts:62` — "/** * Shared normalization for supersession key components. * * Trims surrounding whitespace, lowercases, then collaps"
- `packages/remnic-core/src/temporal-supersession.ts:177` — "// Reuse the shared `normalizeSupersessionKey` helper so this comparison"
- `packages/remnic-core/src/temporal-supersession.ts:178` — "// cannot drift from the canonical form used to build supersession keys"
- `packages/remnic-core/src/temporal-supersession.ts:179` — "// elsewhere in this file."
- `packages/remnic-core/src/temporal-supersession.ts:195` — "// Use normalized key lookup so mixed-case or whitespace-padded keys"
- `packages/remnic-core/src/temporal-supersession.ts:196` — "// stored by the LLM are matched correctly (Finding 2 fix)."
