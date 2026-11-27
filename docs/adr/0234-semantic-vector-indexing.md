# Semantic indexing embeds one canonical body-bounded text and treats similarity as compute-first, replace-on-success

Status: accepted

## Context
The semantic layer (symbol vectors plus SIMILAR_TO edges) spends real money — remote
embedding provider calls — and writes derived data that must stay consistent with the
graph it annotates. Several forces constrain it: the embedded text must be exactly the
text the cache hash describes, or cache hits serve vectors for content that was never
embedded; cost and privacy demand a bound on how much source text reaches a remote
provider; host configuration arrives as untyped strings that, if trusted naively, could
silently enable remote embedding or disable the cost cap; MinHash similarity computed over
names instead of bodies produces plausible-looking but wrong clone candidates; and a
recompute that clears old edges before its own computation succeeds can leave the graph
with no similarity edges at all.

## Decision
Indexing embeds one canonical form under explicit caps, and similarity recomputation
never destroys the old edges before its replacement is in hand:

- There is exactly one canonical text per symbol, produced by a normalization whose
  documented quirks (punctuation spacing, braceless arrow handling) are load-bearing: the
  embedded string MUST equal the string whose hash is stored as `content_hash` (the cache
  invalidation key), so vectors always correspond to cache hits.
- The provider embeds the canonical text — never the raw span — which also enforces the
  `canonicalBodyLines` cost/privacy bound. That bound is validated: a zero or negative
  config value falls back to the documented default (it must NOT clamp to 0, which the
  body extractor treats as unlimited, sending full bodies to the remote embedder).
- Host configuration is coerced fail-closed: unrecognized `enabled` strings are an opt-out,
  and malformed numeric config falls back to the documented default — a malformed string
  must never become NaN and silently remove the budget or the cosine gate.
- The embed budget bounds provider CALLS, not successful writes: failed attempts count
  against the cap so a degraded provider cannot loop over every node; cached symbols are
  skipped before budget accounting and selection makes progress across runs (never
  re-slicing the same alphabetical prefix and embedding zero new symbols). A cache hit is
  valid even when the provider declares no dimensions. `writeSymbolVector` reports whether
  the write persisted, so dropped writes (closed store) are not counted as embedded.
- MinHash similarity runs over the extracted BODY only — never canonical text, whose
  KIND/QNAME/SIG metadata would let empty stubs emit name-driven candidate pairs; bodyless
  symbols yield no candidates. If there are neither pre-built bodies nor a repoRoot to read
  them from, the pipeline refuses to guess rather than MinHash qualified names.
- MinHash-only edges are the documented fallback for the NO-PROVIDER (local,
  deterministic) mode, gated by a Jaccard floor well below the cosine threshold. When a
  provider IS configured, a pair missing a vector is skipped (awaiting cosine
  confirmation), never bypassed with a MinHash-only edge.
- Cosine confirmation requires matching vector dimensionality; mismatched-dims pairs fall
  through to the no-provider branch or are skipped — cosine over the shorter length would
  produce misleading partial-overlap scores.
- SIMILAR_TO recompute is compute-first-then-swap and replace-not-append: candidates are
  computed purely BEFORE `clearSemanticSimilarToEdges` runs, old semantic edges are
  removed only to be replaced by the recomputed set (non-semantic edges survive), and a
  failed or disabled recompute preserves the existing edges instead of clearing them.
- Vector writes honor the store's closing flag and go through the write queue like every
  other graph mutation, so a vector upsert cannot interleave with a transactional node
  delete; and when a prior vector exists under a different `content_hash` and cannot be
  re-embedded, the stale row is deleted so queries never serve it.

## Consequences
Vectors are always faithful to the text they claim to represent; provider spend is
capped per run even under provider failure; local-only mode still produces usable
clone-detection edges; and a failed similarity recompute costs nothing. The costs:
normalization quirks are contract (changing whitespace handling silently invalidates every
cache hash), MinHash-only mode is unavailable whenever a provider is configured even for
not-yet-indexed pairs, and strict config coercion rejects values a lenient parser would
have accepted.

Theme coverage: Records under the canonical-text, vector-discipline, embed-budget, MinHash, similarity, and host-config topics.

## Origin comments
- `packages/coding-graph/src/graph-store.ts:3215` — "Semantic layer (issue #1556): symbol_vectors table read/write."
- `packages/coding-graph/src/graph-store.ts:3216` — "The db is private; these methods are the ONLY surface the semantic"
- `packages/coding-graph/src/graph-store.ts:3217` — "indexer/query path uses. Vectors are float32 BLOBs; content_hash is"
- `packages/coding-graph/src/graph-store.ts:3218` — "the canonical-text hash (rule 37 — the cache invalidation key)."
- `packages/coding-graph/src/graph-store.ts:3233` — "Honor the closing flag (not just closed) and serialize via the write"
- `packages/coding-graph/src/graph-store.ts:3234` — "queue, matching upsertFileBatch / upsertEdges / clearSemanticSimilarToEdges"
- `packages/coding-graph/src/graph-store.ts:3235` — "— otherwise concurrent graph ingestion can interleave a vector upsert"
- `packages/coding-graph/src/graph-store.ts:3236` — "with a transactional node delete (cursor Bugbot: 'Vector writes ignore"
- `packages/coding-graph/src/graph-store.ts:3237` — "closing flag' + 'Vector writes bypass write queue')."
- `packages/coding-graph/src/graph-store.ts:3339` — "Same closing-flag + write-queue discipline as writeSymbolVector"
- `packages/coding-graph/src/graph-store.ts:3340` — "(cursor Bugbot: 'Vector writes ignore closing flag' + 'Vector writes"
- `packages/coding-graph/src/graph-store.ts:3341` — "bypass write queue')."
- `packages/coding-graph/src/semantic/canonical-text.ts:40` — "When there is no { we fall back to the arrow form"
- `packages/coding-graph/src/semantic/canonical-text.ts:41` — "form so braceless arrow functions split at the arrow"
- `packages/coding-graph/src/semantic/canonical-text.ts:42` — "at the arrow instead of collapsing to an empty body."
- `packages/coding-graph/src/semantic/canonical-text.ts:43` — ""
- `packages/coding-graph/src/semantic/canonical-text.ts:44` — "collapseWhitespace's punctuation-spacer turns => into = >"
- `packages/coding-graph/src/semantic/canonical-text.ts:45` — "the raw => marker NEVER appears in the normalized text"
- `packages/coding-graph/src/semantic/canonical-text.ts:46` — "the normalized form or this whole branch is dead"
- `packages/coding-graph/src/semantic/canonical-text.ts:47` — "braceless arrows lose their body"
- `packages/coding-graph/src/semantic/canonical-text.ts:48` — "Embeddings, cache hashes, and MinHash inputs"
- `packages/coding-graph/src/semantic/canonical-text.ts:49` — "then omitted arrow-function logic."
- `packages/coding-graph/src/semantic/semantic.test.ts:463` — "// Budget applies to embed WORK, not the candidate list — a bounded run"
- `packages/coding-graph/src/semantic/semantic.test.ts:464` — "// must make progress across runs (cursor Bugbot + chatgpt-codex-connector"
- `packages/coding-graph/src/semantic/semantic.test.ts:465` — "// P2: bounded index could remain permanently incomplete)."
- `packages/coding-graph/src/semantic/semantic.test.ts:490` — "// Run 2: a, b are cached (no embed); c, d are now embedded. Before the"
- `packages/coding-graph/src/semantic/semantic.test.ts:491` — "// fix this re-sliced the same alphabetical prefix and embedded 0 new"
- `packages/coding-graph/src/semantic/semantic.test.ts:492` — "// symbols every run."
- `packages/coding-graph/src/semantic/semantic.test.ts:512` — "// computeSimilarTo refuses to guess when it has neither bodies nor a"
- `packages/coding-graph/src/semantic/semantic.test.ts:513` — "// repoRoot — silent qname-MinHashing would miss real clones (chatgpt-"
- `packages/coding-graph/src/semantic/semantic.test.ts:514` — "// codex-connector P2: 'Require source bodies before MinHashing')."
- `packages/coding-graph/src/semantic/semantic.test.ts:524` — "// clearSemanticSimilarToEdges: recompute replace semantics — stale"
- `packages/coding-graph/src/semantic/semantic.test.ts:525` — "// SIMILAR_TO edges are removed while non-semantic edges survive"
- `packages/coding-graph/src/semantic/semantic.test.ts:526` — "// (chatgpt-codex-connector P2: 'Replace old SIMILAR_TO edges on recompute')."
- `packages/coding-graph/src/semantic/semantic.test.ts:636` — "// MinHash-only edges are the documented NO-PROVIDER fallback. When a"
- `packages/coding-graph/src/semantic/semantic.test.ts:637` — "// provider IS configured, a pair missing a vector is skipped (await"
- `packages/coding-graph/src/semantic/semantic.test.ts:638` — "// cosine confirmation) instead of bypassing it with a MinHash-only edge"
- `packages/coding-graph/src/semantic/semantic.test.ts:639` — "// (cursor Bugbot: 'MinHash edges with provider set')."
- `packages/coding-graph/src/semantic/semantic.test.ts:682` — "// Mismatched-dimensionality vectors are excluded from ranking. cosine over"
- `packages/coding-graph/src/semantic/semantic.test.ts:683` — "// the shorter length would otherwise give a misleading partial score to a"
- `packages/coding-graph/src/semantic/semantic.test.ts:684` — "// row from a different model size (cursor Bugbot: 'Mismatched embedding"
- `packages/coding-graph/src/semantic/semantic.test.ts:685` — "// lengths scored')."
- `packages/coding-graph/src/semantic/semantic.test.ts:764` — "// Cosine confirmation requires matching dims (cursor Bugbot: 'SimilarTo"
- `packages/coding-graph/src/semantic/semantic.test.ts:765` — "// skips embedding length check')."
- `packages/coding-graph/src/semantic/semantic.test.ts:797` — "// Budget bounds provider CALLS, not successful writes — a degraded provider"
- `packages/coding-graph/src/semantic/semantic.test.ts:798` — "// must not bypass the cost cap (chatgpt-codex-connector: 'Count failed embed"
- `packages/coding-graph/src/semantic/semantic.test.ts:799` — "// attempts against the vector budget')."
- `packages/coding-graph/src/semantic/semantic.test.ts:819` — "// Every embed throws → zero successes, but the provider must NOT be"
- `packages/coding-graph/src/semantic/semantic.test.ts:820` — "// called for all four nodes. Before the fix, `embedded` never reached"
- `packages/coding-graph/src/semantic/semantic.test.ts:821` — "// the limit (all throws) so the loop called the provider for every"
- `packages/coding-graph/src/semantic/semantic.test.ts:822` — "// remaining node, bypassing the per-run cost cap."
- `packages/coding-graph/src/semantic/semantic.test.ts:833` — "// MinHash runs over the extracted BODY only — bodyless declarations"
- `packages/coding-graph/src/semantic/semantic.test.ts:834` — "// (stubs/types with no body) yield no candidates instead of name-driven"
- `packages/coding-graph/src/semantic/semantic.test.ts:835` — "// spurious pairs (chatgpt-codex-connector: 'MinHash only the extracted"
- `packages/coding-graph/src/semantic/semantic.test.ts:836` — "// body text')."
- `packages/coding-graph/src/semantic/semantic.test.ts:863` — "// Host-provided enabled is coerced — "false"/"0" must not become truthy"
- `packages/coding-graph/src/semantic/semantic.test.ts:864` — "// and silently enable vector indexing (chatgpt-codex-connector: 'Coerce"
- `packages/coding-graph/src/semantic/semantic.test.ts:865` — "// host enabled before trusting it')."
- `packages/coding-graph/src/semantic/semantic.test.ts:916` — "// writeSymbolVector reports whether it persisted (returns false on a"
- `packages/coding-graph/src/semantic/semantic.test.ts:917` — "// closed store) so the indexer does not count dropped writes as embedded"
- `packages/coding-graph/src/semantic/semantic.test.ts:918` — "// (cursor Bugbot: 'Embedded count after dropped writes')."
- `packages/coding-graph/src/semantic/semantic.test.ts:937` — "// coerceHostBool fails CLOSED: unrecognized enabled strings are an opt-out,"
- `packages/coding-graph/src/semantic/semantic.test.ts:938` — "// not an opt-in, so a malformed host value can never silently enable remote"
- `packages/coding-graph/src/semantic/semantic.test.ts:939` — "// embedding (cursor Bugbot: 'Unknown enabled strings enable semantic')."
- `packages/coding-graph/src/semantic/semantic.test.ts:955` — "// Host numeric config is coerced: a malformed string ("abc") must not become"
- `packages/coding-graph/src/semantic/semantic.test.ts:956` — "// NaN and silently disable the vector budget (NaN > 0 is false → unlimited)"
- `packages/coding-graph/src/semantic/semantic.test.ts:957` — "// or the cosine gate. It falls through to the documented default instead"
- `packages/coding-graph/src/semantic/semantic.test.ts:958` — "// (chatgpt-codex-connector: 'Validate host numeric config before clamping')."
- `packages/coding-graph/src/semantic/semantic.test.ts:978` — "// Cache hits still work when the provider does not declare dimensions"
- `packages/coding-graph/src/semantic/semantic.test.ts:979` — "// (optional). The dims gate is skipped, so re-indexing an unchanged symbol"
- `packages/coding-graph/src/semantic/semantic.test.ts:980` — "// uses the cache instead of re-embedding every run (cursor Bugbot: 'Cache"
- `packages/coding-graph/src/semantic/semantic.test.ts:981` — "// misses without provider dimensions')."
- `packages/coding-graph/src/semantic/semantic.test.ts:1108` — "// config: a negative/zero canonicalBodyLines must NOT clamp to 0 (which"
- `packages/coding-graph/src/semantic/semantic.test.ts:1109` — "// extractBodyText treats as unlimited, sending full symbol bodies to the"
- `packages/coding-graph/src/semantic/semantic.test.ts:1110` — "// remote embedder and defeating the cost/privacy cap). It falls back to the"
- `packages/coding-graph/src/semantic/semantic.test.ts:1111` — "// documented default instead (#1680)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1240` — "// SIMILAR_TO recompute is replace-not-append: the README example clears"
- `packages/coding-graph/src/semantic/semantic.test.ts:1241` — "// semantic SIMILAR_TO edges before upserting so two symbols that STOP being"
- `packages/coding-graph/src/semantic/semantic.test.ts:1242` — "// similar do not leave a stale edge (upsertEdges does not delete absent rows)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1243` — "// This test exercises the documented README flow end to end (#1680)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1273` — "// README flow: compute-first-then-swap. computeSimilarTo is pure (no"
- `packages/coding-graph/src/semantic/semantic.test.ts:1274` — "// edge mutation), so compute candidates BEFORE clearing — if the"
- `packages/coding-graph/src/semantic/semantic.test.ts:1275` — "// recompute fails, existing SIMILAR_TO edges are preserved instead of"
- `packages/coding-graph/src/semantic/semantic.test.ts:1276` — "// leaving the graph empty (chatgpt-codex-connector P2: "Preserve"
- `packages/coding-graph/src/semantic/semantic.test.ts:1277` — "// existing edges until recompute succeeds")."
- `packages/coding-graph/src/semantic/semantic.test.ts:1302` — "// Preserve-on-failure: a recompute that returns { ok: false } must NOT"
- `packages/coding-graph/src/semantic/semantic.test.ts:1303` — "// clear — the existing edge survives. semantic_disabled short-circuits"
- `packages/coding-graph/src/semantic/semantic.test.ts:1304` — "// before any table work, so no clear runs and mod.b stays reachable."
- `packages/coding-graph/src/semantic/similarity.ts:94` — "// Without pre-built bodies AND without a repoRoot, the only available"
- `packages/coding-graph/src/semantic/similarity.ts:95` — "// text is the qualified name, which MinHashes name similarity rather"
- `packages/coding-graph/src/semantic/similarity.ts:96` — "// than body similarity — real copy-paste clones with different names"
- `packages/coding-graph/src/semantic/similarity.ts:97` — "// are silently missed. Refuse to guess: require one of the two so the"
- `packages/coding-graph/src/semantic/similarity.ts:98` — "// pipeline always MinHashes actual symbol bodies (chatgpt-codex-"
- `packages/coding-graph/src/semantic/similarity.ts:99` — "// connector P2: 'Require source bodies before MinHashing')."
- `packages/coding-graph/src/semantic/similarity.ts:133` — "// Require matching dimensionality — cosineSimilarity compares over the"
- `packages/coding-graph/src/semantic/similarity.ts:134` — "// shorter length, so mismatched-dims rows would get a misleading"
- `packages/coding-graph/src/semantic/similarity.ts:135` — "// partial-overlap score (cursor Bugbot: 'SimilarTo skips embedding"
- `packages/coding-graph/src/semantic/similarity.ts:136` — "// length check'). Pairs that fail this fall through to the no-provider"
- `packages/coding-graph/src/semantic/similarity.ts:137` — "// MinHash-only branch or are skipped."
- `packages/coding-graph/src/semantic/similarity.ts:152` — "// MinHash-only is the documented fallback for the NO-PROVIDER"
- `packages/coding-graph/src/semantic/similarity.ts:153` — "// (local, deterministic) mode. When a provider IS configured we do"
- `packages/coding-graph/src/semantic/similarity.ts:154` — "// NOT emit MinHash-only edges for pairs missing a vector — that"
- `packages/coding-graph/src/semantic/similarity.ts:155` — "// would bypass the cosine confirmation path during partial / not-"
- `packages/coding-graph/src/semantic/similarity.ts:156` — "// yet-indexed state. Such pairs are simply skipped; they will be"
- `packages/coding-graph/src/semantic/similarity.ts:157` — "// cosine-confirmed once indexing completes (cursor Bugbot: 'MinHash"
- `packages/coding-graph/src/semantic/similarity.ts:158` — "// edges with provider set'). Use a Jaccard gate well below the"
- `packages/coding-graph/src/semantic/similarity.ts:159` — "// cosine threshold — MinHash Jaccard for near-clones is typically"
- `packages/coding-graph/src/semantic/similarity.ts:160` — "// 0.3-0.8; the MINHASH_JACCARD_GATE is the documented floor."
- `packages/coding-graph/src/semantic/similarity.ts:232` — "// MinHash the extracted BODY only, not the full canonical text. The"
- `packages/coding-graph/src/semantic/similarity.ts:233` — "// canonical form includes KIND/QNAME/SIG metadata; tokenizing it would"
- `packages/coding-graph/src/semantic/similarity.ts:234` — "// let empty-body stubs/declarations emit name-driven candidates among"
- `packages/coding-graph/src/semantic/similarity.ts:235` — "// unrelated symbols. extractBodyText returns "" for a bodyless symbol,"
- `packages/coding-graph/src/semantic/similarity.ts:236` — "// and the hasher skips empty bodies entirely (chatgpt-codex-connector:"
- `packages/coding-graph/src/semantic/similarity.ts:237` — "// 'MinHash only the extracted body text')."
- `packages/coding-graph/src/semantic/vectors.ts:128` — "// Canonical text + hash (rule 23/37). The embedded string MUST equal"
- `packages/coding-graph/src/semantic/vectors.ts:129` — "// the hashed string (rule 23 — one form everywhere)."
- `packages/coding-graph/src/semantic/vectors.ts:152` — "// Embed the CANONICAL text (not the raw span) so the vector"
- `packages/coding-graph/src/semantic/vectors.ts:153` — "// corresponds to the content_hash that gates cache hits (rule 23)."
- `packages/coding-graph/src/semantic/vectors.ts:154` — "// This also respects canonicalBodyLines as a cost/privacy bound."
- `packages/coding-graph/src/semantic/vectors.ts:162` — "// Stale vector cleanup (rule 37): if a prior vector exists with a"
- `packages/coding-graph/src/semantic/vectors.ts:163` — "// different content_hash and we cannot re-embed, delete the stale"
- `packages/coding-graph/src/semantic/vectors.ts:164` — "// row so semantic_query/cosine confirmation do not serve it."
