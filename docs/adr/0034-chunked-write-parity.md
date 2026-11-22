# Chunked Write Parity and Envelope Inheritance

Status: accepted

## Context
Long facts are split into child chunks under a parent memory. Recall can
surface a single chunk in isolation (memory_get, x-ray), so every piece of
parent metadata that matters for trust — entity identity, tags, confidence,
bi-temporal bounds, provenance spans, faithfulness verdict, citation — must
be consistent between parent and chunks, or a surfaced chunk misrepresents
the memory. Chunks are internal decomposition, not logical memories: they
must not leak into caller-facing ID lists, and the chunked path must apply
the same gates (dedup, supersession, faithfulness, hash registration) as the
normal path.

## Decision
Rules:

- Chunks inherit the PARENT ENVELOPE's surviving tags (minus the parent-only
  "chunked" marker), entityRef, confidence, bi-temporal bounds, ingestion
  provenance, claim-level provenance spans, and the faithfulness verdict /
  enforce status — never the raw fact fields, which can disagree with the
  sealed parent or exceed per-memory limits.
- The parent carries supersedes/links from contradiction detection; child
  chunks never do — the parent represents the logical memory unit.
- Each chunk carries its own inline citation (same computed citation
  timestamp as the parent's artifact write) so provenance survives when a
  chunk is quoted alone.
- Chunk IDs stay out of persistedIds / onExtraction / thread processing,
  which expect canonical parent IDs only; sync each chunk document into the
  embedding-fallback index directly via indexPersistedMemory.
- The chunked path mirrors the non-chunked path for: dedup hash
  canonicalization and index registration (inside the commit window),
  source-namespace temporal supersession, faithfulness/tombstone pending
  gates (no chunk lands active under a blocked parent, and pending ids stay
  out of graph threading), and promotion eligibility (no shared/profile
  promotion of a pending_review parent).
- When semantic chunking is enabled, prefer the embedding-based chunker and
  honor the fallbackToRecursive contract: when the user disables fallback,
  re-throw so extraction fails fast instead of silently using the recursive
  chunker.

## Consequences
Inheriting the parent envelope means a chunk cannot carry chunk-local
corrections to tags or confidence. The parity requirement doubles the gate
surface the chunked path must maintain.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2105` — "// When semanticChunkingEnabled is true, prefer the embedding-based"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2106` — "// semantic chunker which produces more coherent topic-aligned segments."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2107` — "// Falls back to the recursive sentence-boundary chunker on failure."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2121` — "// Honor the fallbackToRecursive contract: when the user explicitly"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2122` — "// disables fallback, re-throw so extraction fails fast instead of"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2123` — "// silently using the recursive chunker. semanticChunkContent already"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2124` — "// throws when fallback is disabled, but this outer catch swallowed"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2125` — "// that signal. (PR #439 post-merge Finding 1.)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2144` — "// Write the parent memory first (with full content for reference). // // Compute the cited content once so that writeM…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2146` — "// Compute the cited content once so that writeMemory and writeArtifact"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2147` — "// (when verbatim artifacts are enabled) share the same citation timestamp."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2148` — "// See the normal write path comment for the full dedup rationale."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2150` — "// Propagate supersedes/links from contradiction detection (round 6"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2151` — "// fix): contradiction detection now runs BEFORE this branch so the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2152` — "// parent must carry the supersession relationship — without it the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2153` — "// old memory is deindexed but the new chunked parent has no link"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2154` — "// back, leaving a dangling deindex with no replacement reference."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2155` — "// Child chunks intentionally do NOT carry supersedes; only the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2156` — "// parent represents the logical memory unit."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2157` — "// Canonicalize contentHashSource before writing (Thread 3 — Codex P2,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2158` — "// issue #369). If fact.content already carries an inline citation"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2159` — "// (e.g. re-processed or relayed fact), strip it so contentHashSource"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2160` — "// records the raw un-cited body — matching what the dedup check hashes"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2161` — "// via stripCitationForTemplate before calling hasFactContentHash."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2250` — "// #2014 round 3: chunks inherit the PARENT ENVELOPE's surviving // tags (minus the parent-only \"chunked\" marker) and e…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2251` — "// tags (minus the parent-only \"chunked\" marker) and entityRef —"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2252` — "// passing raw fact.tags let chunk frontmatter disagree with the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2253` — "// sealed parent and retain tags past the per-memory limits."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2273` — "// Each chunk carries its own inline citation so provenance // survives when a single chunk is quoted in isolation."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2274` — "// survives when a single chunk is quoted in isolation."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2277` — "// #2014 round 4: sealed parent's confidence — raw // fact.confidence would let parent and chunk disagree."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2278` — "// fact.confidence would let parent and chunk disagree."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2289` — "// #1578: propagate end bound + provenance to chunks (cursor bugbot)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2311` — "// parent's spans onto each chunk so a chunk surfaced"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2312` — "// independently (memory_get/x-ray on a chunk ID) preserves"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2313` — "// the verified span (chatgpt-codex-connector thread Ocvmo)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2355` — "// #2014 round 2: same envelope-surviving key rule as the // non-chunked path."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2437` — "// Do NOT push chunkId into persistedIds — chunk IDs must not leak // into boxBuilder.onExtraction() or threading.proce…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2438` — "// into boxBuilder.onExtraction() or threading.processTurn(), which"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2439` — "// only expect canonical parent memory IDs. Call indexPersistedMemory"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2440` — "// directly for embedding-fallback sync of each chunk document."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2454` — "// Reuse citedChunkedContent so the artifact carries the same citation // timestamp as the parent memory write above (F…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2473` — "// #2014 round 4: graph identity must match the PERSISTED // memory — the envelope's surviving entityRef."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2474` — "// memory — the envelope's surviving entityRef."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2768` — "// #2014 round 4: envelope-surviving entityRef (see chunked path)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2809` — "// Reuse citedFactContent so the artifact carries the same citation // timestamp as the memory write above (Fix #3 — du…"
