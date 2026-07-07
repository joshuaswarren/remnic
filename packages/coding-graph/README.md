# @remnic/coding-graph

À-la-carte optional companion of `@remnic/core` that ships the codebase-graph
engine: web-tree-sitter grammars, per-language symbol extractors, and the
neutral `FileIR` intermediate representation that the graph store consumes.

> Part of #1548 (Track B, Phase 1). Package and core wiring for PR1 (#1551
> step 1 + step 2). The real backend lands in PR2 (#1551 step 3+).

## Install

```bash
npm install @remnic/coding-graph
# or
pnpm add @remnic/coding-graph
```

## Status (PR1)

This package's public surface is **scaffolded only**:

- `ENGINE_VERSION = "0.1.0-pr1"` constant
- `TIER_1_LANGUAGES` (15 languages)
- `CodingGraphError` tagged error class (`code: "not_implemented" | "module_load_failed"`)
- `CodingGraphEngine` interface — the full PR2 contract, no implementation
- `createCodingGraphEngine()` — throws `CodingGraphError("not_implemented", …)`

Calling `createCodingGraphEngine()` *always* throws a tagged error. There
is no silent stub and there is no half-working fallback. The runtime
contract is observable today; PR2 fills the implementation.

`web-tree-sitter` is declared as the parser engine; grammar `.wasm` assets
will ship in PR2 via the `grammars/` directory listed in the package's
`files` manifest.

## How `@remnic/core` loads this

`@remnic/core` does not import `@remnic/coding-graph` directly. It uses a
computed-specifier dynamic import:

```ts
import type { CodingGraphEngine, ... } from "@remnic/coding-graph"; // types only

const SPECIFIER = "@remnic/" + "coding-graph";
// await import(SPECIFIER) — see
// packages/remnic-core/src/coding/optional-coding-graph.ts
```

When the optional package is absent the loader throws a user-facing hint:

```
The `@remnic/coding-graph` engine is optional and not installed in this environment.

Install it alongside @remnic/core to enable codebase-graph features:
  npm install @remnic/coding-graph
```

## Standards reference

- CLAUDE.md rule 57 (à-la-carte) and AGENTS.md rule 44 (computed-specifier dynamic import)
- `web-tree-sitter` chosen to avoid the native-binding pain called out in
  #1518 / #1538 — see #1548 for the full design rationale

## Semantic layer (#1556)

The optional semantic layer adds symbol embeddings, `SIMILAR_TO` near-clone
edges, and `semantic_query` (natural-language retrieval over the symbol graph).

### Privacy posture

**Default configuration sends nothing anywhere.** The semantic layer is OFF by
default (`SemanticConfig.enabled = false`). When off, zero embedding provider
calls are made and zero rows are written to the `symbol_vectors` table — the
gate-off test (`semantic.test.ts: gate-off`) asserts this end to end.

When `enabled = true`:
- With **no embedding provider** configured: the feature degrades gracefully.
  `SIMILAR_TO` edges are still produced via local, deterministic MinHash/LSH
  (pure TypeScript, no network). `semantic_query` returns a tagged
  `{ ok: false, code: "provider_unavailable" }` — never an empty result
  masquerading as "no matches".
- With a **remote embedding provider** configured (e.g. OpenAI or an
  OpenAI-compatible endpoint via the host embedding provider registry):
  symbol text (canonical form: kind + qualified name + signature + body
  excerpt) leaves the machine to be embedded. This is the same path
  @remnic/core's `EmbeddingFallback` uses for conversation embeddings —
  no new network stack is introduced.

The canonical text that is embedded is the canonical text that is hashed for
the cache (rule 23): `signature + doc comment + first N tokens of body`,
whitespace- and punctuation-normalized so formatting variants hash
identically. Cached vectors are reused on re-index when the content hash is
unchanged (rule 37).

### API surface

```typescript
import {
  resolveSemanticConfig,
  indexSymbolVectors,
  computeSimilarTo,
  similarEdgesToEdgeIR,
  semanticQuery,
} from "@remnic/coding-graph";

const config = resolveSemanticConfig({ enabled: true });

// Index: embed symbols, cache by canonical-text hash
const indexResult = await indexSymbolVectors({ store, provider, repoRoot, config });

// SIMILAR_TO: MinHash/LSH candidates → cosine confirmation.
// repoRoot (or prebuilt bodies) is required so the pipeline hashes real
// symbol bodies, not qualified names.
// Compute-first-then-swap: computeSimilarTo is pure (it reads nodes +
// vectors but never mutates edges), so compute the candidate set BEFORE
// touching the table. Only on success do we clear + upsert — this
// preserves the existing SIMILAR_TO edges if the recompute fails (e.g. a
// closed store or a missing repoRoot), instead of leaving the graph with
// zero semantic edges. The clear is still required because upsertEdges
// does not delete absent rows — without it, two symbols that stop being
// similar would keep a stale edge (replace-not-append).
const similar = computeSimilarTo({ store, provider, repoRoot, config });
if (similar.ok) {
  await store.clearSemanticSimilarToEdges();
  await store.upsertEdges(similarEdgesToEdgeIR(similar.edges));
}

// semantic_query: embed query → top-k → hydrate with graph context
const query = await semanticQuery({ store, provider, repoRoot, config, query: "payment processing" });
```
