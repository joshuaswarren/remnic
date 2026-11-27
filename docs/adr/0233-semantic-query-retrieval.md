# Semantic query degrades through tagged, distinct failure codes and hydrates hits by node id

Status: accepted

## Context
`semantic_query` is a natural-language retrieval surface over the symbol graph. Its
callers include MCP tool forwarding, so queries arrive as possibly-malformed JSON; the
embedding provider may be unknown or unavailable; the store may be closed or transiently
unreadable; and stored vectors may come from a different embedding model than the query.
Earlier behavior conflated these: a closed store reported `ok: true` with no vectors,
provider errors leaked raw messages, NaN limits produced empty or unbounded slices, and
snippets hydrated by qualified name went empty whenever the name was ambiguous across
files — even though the vector row had identified the precise node.

## Decision
Every query failure has a distinct tagged code, and every hit is hydrated through the
precise identity the vector row already carries:

- The query object is validated before dereference; the caller-supplied limit is coerced
  to a finite positive integer (NaN/Infinity/non-numeric fall back to the default, and
  sub-one limits clamp to at least 1) so a bad limit can neither return nothing nor every
  row.
- Only vectors whose dimensionality matches the query embedding are scored; mismatched-dims
  rows are excluded from ranking instead of receiving a misleading partial-overlap score.
- Hits hydrate by the exact node id from the vector row — never by qualified name — so a
  name duplicated across files still resolves the precise node's snippet, and `hit.kind`
  carries the node's label rather than being omitted.
- Snippet hydration honors a query-level repoRoot override, so a store opened without a
  repoRoot can still hydrate when the caller supplies one.
- An unknown provider error maps to a distinct unavailable degradation and never includes
  the raw error message; transient store read failures (SQLITE_BUSY/CORRUPT) map to tagged
  `db_error` instead of escaping as throws; a closed store is a distinct `store_closed`
  degradation — not an empty successful result — in both query and similarity entry
  points.

## Consequences
Callers can branch on failure codes instead of string-matching messages, raw provider
and SQLite text never leaks to tool surfaces, and ambiguous names stop producing empty
snippets. The costs: limits are coerced rather than rejected (deliberately softer than the
store's read validation, because this surface faces end-user tool input), and
dimension-mismatched vectors are invisible to queries until re-indexed under the current
model.

Theme coverage: Records under the semantic-query, snippet-hydration, closed-store, and tagged-db-error topics.

## Origin comments
- `packages/coding-graph/src/semantic/semantic-query.ts:1` — "semantic_query — natural-language retrieval over the symbol graph"
- `packages/coding-graph/src/semantic/semantic-query.ts:79` — "Unknown provider error → treat as unavailable"
- `packages/coding-graph/src/semantic/semantic-query.ts:80` — "Do NOT include the raw error message"
- `packages/coding-graph/src/semantic/semantic-query.ts:91` — "Wrap the store read so a transient SQLite error maps to a tagged db_error"
- `packages/coding-graph/src/semantic/semantic-query.ts:92` — "maps to a tagged db_error instead of escaping semanticQuery"
- `packages/coding-graph/src/semantic/semantic-query.ts:103` — "Validate limit: NaN/Infinity/non-numeric must not produce a NaN/Infinity slice"
- `packages/coding-graph/src/semantic/semantic-query.ts:104` — "NaN → slice returns no hits; Infinity → every row."
- `packages/coding-graph/src/semantic/semantic-query.ts:105` — "Coerce to a finite positive integer, falling back to the default."
- `packages/coding-graph/src/semantic/semantic-query.ts:110` — "Only score vectors whose dimensionality matches the query embedding."
- `packages/coding-graph/src/semantic/semantic-query.ts:111` — "cosineSimilarity compares over the SHORTER length"
- `packages/coding-graph/src/semantic/semantic-query.ts:112` — "different model size would otherwise get a misleading partial-overlap score"
- `packages/coding-graph/src/semantic/semantic-query.ts:113` — "score and rank incorrectly instead of being excluded"
- `packages/coding-graph/src/semantic/semantic-query.ts:114` — "Mismatched embedding lengths scored"
- `packages/coding-graph/src/semantic/semantic-query.ts:136` — "Hydrate by the exact node id from the vector row, not the qualified name"
- `packages/coding-graph/src/semantic/semantic-query.ts:137` — "a name duplicated across files would otherwise hit ambiguous_name"
- `packages/coding-graph/src/semantic/semantic-query.ts:138` — "hit ambiguous_name and leave the snippet empty"
- `packages/coding-graph/src/semantic/semantic-query.ts:139` — "vector row identified the precise node"
- `packages/coding-graph/src/semantic/semantic-query.ts:140` — "Hydrate snippets by node id as well"
- `packages/coding-graph/src/semantic/semantic.test.ts:571` — "// semantic_query: hit.kind is the node label, not empty (cursor Bugbot:"
- `packages/coding-graph/src/semantic/semantic.test.ts:572` — "// 'Query hits omit symbol kind')."
- `packages/coding-graph/src/semantic/semantic.test.ts:600` — "// semantic_query: snippet hydrates by node id, so a qualified name"
- `packages/coding-graph/src/semantic/semantic.test.ts:601` — "// duplicated across files still resolves the exact node's snippet"
- `packages/coding-graph/src/semantic/semantic.test.ts:602` — "// (chatgpt-codex-connector P2: 'Hydrate snippets by node id as well')."
- `packages/coding-graph/src/semantic/semantic.test.ts:623` — "// Both nodes share qname "mod.dup" but distinct node ids; hydrating"
- `packages/coding-graph/src/semantic/semantic.test.ts:624` — "// by node id must yield a real snippet for at least one hit (the old"
- `packages/coding-graph/src/semantic/semantic.test.ts:625` — "// qname path returned 'ambiguous_name' and left every snippet empty)."
- `packages/coding-graph/src/semantic/semantic.test.ts:720` — "// Closed store is a distinct degradation code (rule 34), not an empty"
- `packages/coding-graph/src/semantic/semantic.test.ts:721` — "// graph that returns ok:true / no_vectors (cursor Bugbot: 'Closed store"
- `packages/coding-graph/src/semantic/semantic.test.ts:722` — "// reports success')."
- `packages/coding-graph/src/semantic/semantic.test.ts:744` — "// computeSimilarTo honors the closed store (cursor Bugbot: 'SimilarTo"
- `packages/coding-graph/src/semantic/semantic.test.ts:745` — "// ignores closed store')."
- `packages/coding-graph/src/semantic/semantic.test.ts:881` — "// snippetFor honors a query-level repoRoot override, so a store opened"
- `packages/coding-graph/src/semantic/semantic.test.ts:882` — "// without repoRoot can still hydrate snippets when the caller supplies one"
- `packages/coding-graph/src/semantic/semantic.test.ts:883` — "// (chatgpt-codex-connector + cursor: 'Snippet hydration ignores query"
- `packages/coding-graph/src/semantic/semantic.test.ts:884` — "// repoRoot')."
- `packages/coding-graph/src/semantic/semantic.test.ts:1126` — "// semanticQuery: a transient store read failure (SQLITE_BUSY/CORRUPT) on"
- `packages/coding-graph/src/semantic/semantic.test.ts:1127` — "// readAllSymbolVectors maps to a tagged db_error instead of escaping as a"
- `packages/coding-graph/src/semantic/semantic.test.ts:1128` — "// throw (#1680)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1142` — "// indexSymbolVectors: a transient store read failure on readNodesForSemantic"
- `packages/coding-graph/src/semantic/semantic.test.ts:1143` — "// maps to a tagged db_error instead of rejecting the promise (#1680)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1157` — "// semanticQuery: a caller-supplied limit of NaN/Infinity must not produce a"
- `packages/coding-graph/src/semantic/semantic.test.ts:1158` — "// NaN/Infinity slice. slice(0, NaN) returns no hits; slice(0, Infinity)"
- `packages/coding-graph/src/semantic/semantic.test.ts:1159` — "// returns every scored vector. Both are wrong — coerce to the finite default"
- `packages/coding-graph/src/semantic/semantic.test.ts:1160` — "// (#1680)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1209` — "// Math.floor(0.5) === 0; without clamping, slice(0, 0) returns no hits"
- `packages/coding-graph/src/semantic/semantic.test.ts:1210` — "// even when matching vectors exist (#1680 review: 'Clamp sub-one query"
- `packages/coding-graph/src/semantic/semantic.test.ts:1211` — "// limits before slicing')."
- `packages/coding-graph/src/semantic/similarity.ts:107` — "// Closed store is a distinct degradation (rule 34) — readNodesForSemantic"
- `packages/coding-graph/src/semantic/similarity.ts:108` — "// would return [] and we would report { ok: true, edges: [] } instead of"
- `packages/coding-graph/src/semantic/similarity.ts:109` — "// the documented store_closed code used by the other entry points (cursor"
- `packages/coding-graph/src/semantic/similarity.ts:110` — "// Bugbot: 'SimilarTo ignores closed store')."
