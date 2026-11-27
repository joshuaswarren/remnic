# Exporter lifecycle, OKF bundle, and test-fixture conventions

Status: accepted

## Context

Opik trace export hooks are chained onto a shared global; a naive detach restoring a saved handler drops subscribers that chained after us, and a stale instance could evict a newer exporter. OKF bundle export races crashes between renames and user-created directories occupying fixed backup paths, and secure-store files are binary envelopes that must not be detected by substring search. Test fixtures for wide interfaces would otherwise drown in full literals.

## Decision

Opik detach marks its own config disabled rather than restoring a prior handler, so later subscribers are never dropped; the cost (one disabled no-op wrapper per stop/start cycle) is accepted because restarts are rare, and a stale instance never evicts a newer exporter that already took over. Span ids derive from Engram's `evt.traceId` (deterministic, stable across retries) with a per-call trace id so each LLM call maps to its own trace. Enabling auto-detects from opik-openclaw plugin config when `opikTraceEnabled` is unset (avoiding schema-invalid extra config fields), warns only on an explicit opt-in missing its URL, and stays silent for non-Opik users. OKF rendering emits a deterministic frontmatter block (canonical key order first) from a flat field map and never writes bundle-reserved `index.md`/`log.md`; the `type` mapping is the single source of truth for inert type metadata. `--force` export takes a fresh per-attempt backup name (removed on success and rollback) instead of a fixed reusable one; `--out` paths with a symlink anywhere in the component chain are rejected; the secure-store envelope is detected by MAGIC_BYTES at fixed offset 0, never a substring. Test fixtures may cast partial stubs/fixtures only when the test provably touches just those members, with a SAFETY/justification comment at each site documenting exactly which surface is exercised.

## Consequences

Observability restarts lose nothing; bundle exports survive crashes and hostile paths; envelope detection cannot false-positive on content. Cost: leftover no-op wrappers accumulate in the handler chain (bounded, documented), and partial test casts depend on their per-site justification comments staying true.

## Origin comments
This theme also absorbs smaller neighbouring records that did not justify their own ADR: justified narrow-cast conventions in test fixtures (fixture and stub casts documented at each site).
- `packages/remnic-core/src/okf/lint.ts:20` — "// secure-store writes a binary envelope starting with MAGIC_BYTES at offset"
- `packages/remnic-core/src/okf/lint.ts:21` — "// 0 — match that fixed position, never a substring anywhere in the file."
- `packages/remnic-core/src/okf/render.ts:19` — "/** * Render a YAML frontmatter block from a flat field map. * * Key order: the canonical OKF keys first (`type`, `ti..."
- `packages/remnic-core/src/okf/render.ts:92` — "// A fixed backup name is not reusable: an earlier crash between the two"
- `packages/remnic-core/src/okf/render.ts:93` — "// renames, or an unrelated directory a user created, leaves the path"
- `packages/remnic-core/src/okf/render.ts:94` — "// occupied and every later --force export fails on the rename. Each"
- `packages/remnic-core/src/okf/render.ts:95` — "// attempt takes its own name and removes it on both the success and the"
- `packages/remnic-core/src/okf/render.ts:96` — "// rollback path."
- `packages/remnic-core/src/okf/render.ts:122` — "/** * Reject a --out path with a symlink anywhere in its component chain * (pattern 42 + hermes-shim precedent): a sy..."
- `packages/remnic-core/src/okf/type-mapping.ts:1` — "/** * OKF v0.1 `type` mapping (issue #1946) — the single source of truth for * the inert `type` metadata emitted alon..."
- `packages/remnic-core/src/okf/type-mapping.ts:63` — "/** * OKF §6/§7 reserve `index.md` and `log.md` for bundle-level files with a * different contract. Remnic never writ..."
- `packages/remnic-core/src/opik-exporter.ts:255` — "// Chain: call existing subscribers first, then ours."
- `packages/remnic-core/src/opik-exporter.ts:256` — "// NOTE: when _detach() is later called, it marks this.cfg.enabled = false"
- `packages/remnic-core/src/opik-exporter.ts:257` — "// rather than restoring the chain, so that any subscriber that chained"
- `packages/remnic-core/src/opik-exporter.ts:258` — "// *after* us is not dropped. The cost is one disabled no-op wrapper"
- `packages/remnic-core/src/opik-exporter.ts:259` — "// remaining in the chain per stop/start cycle. In practice, Engram"
- `packages/remnic-core/src/opik-exporter.ts:260` — "// restarts Opik only a handful of times per process lifetime, so the"
- `packages/remnic-core/src/opik-exporter.ts:261` — "// overhead is negligible (one boolean check per leftover closure)."
- `packages/remnic-core/src/opik-exporter.ts:275` — "/** Deactivate this exporter instance. * * We intentionally do NOT restore __openclawEngramTrace to a prior handler *..."
- `packages/remnic-core/src/opik-exporter.ts:287` — "// A stale instance must not evict a newer exporter that already took over."
- `packages/remnic-core/src/opik-exporter.ts:386` — "// Use evt.traceId (Engram's correlation key) as the Opik spanId so spans"
- `packages/remnic-core/src/opik-exporter.ts:387` — "// are deterministic and stable across retries. Derive a per-call Opik"
- `packages/remnic-core/src/opik-exporter.ts:388` — "// trace_id from the same key so each LLM call maps to its own trace."
- `packages/remnic-core/src/opik-exporter.ts:557` — "// Auto-detect from opik-openclaw plugin config."
- `packages/remnic-core/src/opik-exporter.ts:558` — "// If opikTraceEnabled is not set (undefined), we enable automatically"
- `packages/remnic-core/src/opik-exporter.ts:559` — "// whenever opik-openclaw is configured — avoids needing extra fields in"
- `packages/remnic-core/src/opik-exporter.ts:560` — "// Engram's openclaw.json config section (which would fail schema validation)."
- `packages/remnic-core/src/opik-exporter.ts:565` — "// Only warn when the user explicitly opted in but forgot to set the URL."
- `packages/remnic-core/src/opik-exporter.ts:566` — "// When auto-detecting (opikTraceEnabled not set), return silently so non-Opik"
- `packages/remnic-core/src/opik-exporter.ts:567` — "// users see no log noise on every startup."
- `packages/remnic-core/src/orchestration/batch-deindex-flush.test.ts:36` — "// Test fixture: MemoryFile carries many optional fields the archival loop"
- `packages/remnic-core/src/orchestration/batch-deindex-flush.test.ts:37` — "// never reads; a full literal would be noise. Narrow, deliberate cast."
- `packages/remnic-core/src/orchestration/batch-deindex-flush.test.ts:74` — "// runFactArchival only calls archiveMemory on the storage; the rest of the"
- `packages/remnic-core/src/orchestration/batch-deindex-flush.test.ts:75` — "// StorageManager surface is unused here."
- `packages/remnic-core/src/orchestration/batch-deindex-flush.test.ts:82` — "// Minimal config: the archival loop reads only these fields plus the"
- `packages/remnic-core/src/orchestration/batch-deindex-flush.test.ts:83` — "// queryAwareIndexing capability flag. A full PluginConfig literal is noise."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:12` — "// SAFETY: the coordinator reads only the three members raceConfig sets."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:33` — "// SAFETY: records nothing in this test."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:37` — "// SAFETY: propagation is disabled in this config; the port is never used."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:45` — "// SAFETY: index removal unused in this test."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:47` — "// SAFETY: node rebuild unused in this test."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:51` — "// SAFETY: unused passes in this config."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:57` — "// SAFETY: unused pass in this config."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:65` — "// SAFETY: profile entry only."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:84` — "// SAFETY: the stub implements exactly the two members the profile branch"
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:85` — "// calls; the tests assert their effects instead of the stub's other surface."
- `packages/remnic-core/src/orchestration/consolidation-profile-race.test.ts:89` — "// SAFETY: callers stub only the members this Pick names."
- `packages/remnic-core/src/orchestration/drain-extraction.test.ts:41` — "// SAFETY: the client only calls fetch(url, init); the stub keeps that call shape and returns a Response."
- `packages/remnic-core/src/orchestration/drain-extraction.test.ts:65` — "// Real 30 ms attempt timer: the abort under test is the client's own wall-clock timeout."
- `packages/remnic-core/src/orchestration/drain-extraction.test.ts:113` — "// The extraction field is orchestrator-private: read the own property and narrow it by class, with no cast."
- `packages/remnic-core/src/orchestration/drain-extraction.test.ts:136` — "// The held live request ends at the client's own timeout, or at destroy() below. Retries are off"
- `packages/remnic-core/src/orchestration/drain-extraction.test.ts:137` — "// so a drain engine that shared the live client would still pass the one-attempt test."
- `packages/remnic-core/src/orchestration/extraction-drain-dedupe.test.ts:85` — "A real buffer on real storage, drained with a stub runExtraction that clears like the coordinator does: by identity."
- `packages/remnic-core/src/orchestration/extraction-drain-dedupe.test.ts:387` — "/** Seeded PRNG so the property run is reproducible. */"
- `packages/remnic-core/src/orchestration/extraction-drain-parts.test.ts:45` — "A real buffer on real storage, drained with a stub runExtraction that clears like the coordinator does."
