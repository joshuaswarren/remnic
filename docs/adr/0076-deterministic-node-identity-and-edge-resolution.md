# Resolve graph edges against deterministic, content-derived node ids with conservative ambiguity handling

Status: accepted

## Context
Edges reference endpoints by qualified name in most IRs, but qualified names are not
unique: two symbols in the same file can share one (a TS type and value both named `Foo`,
with different labels producing different node ids), and common names like
`main`/`handler`/`init` recur across files. Writing an edge against the wrong node
silently corrupts every downstream analysis, and pruning by qualified name would leave
dead rows behind whenever a symbol's kind changed (same name, new id). The store therefore
needs one canonical identity that is stable across re-parses yet precise to the individual
symbol, and resolution rules that prefer dropping an unresolvable edge over guessing its
endpoint.

## Decision
Node identity is content-derived and deterministic; edge resolution is conservative:

- The node id is the deterministic `nodeIdFor` form (sha256-based, 64-char lowercase
  hex). The seen-id set is built BEFORE any prune step, so pruning is order-stable and
  never deletes an id the same batch is about to (re)insert.
- Prune by id, never by qualified name: a kind change keeps the qualifiedName but yields a
  new id, and only deleting the old id keeps the file's symbol set honest. Prune happens
  after upserts, and the shared batch-wide delete is deferred so cascades see every pruned
  node at once.
- An edge's SRC must belong to the file being ingested and is resolved ONLY from that
  file's qualified-name map (no DB fallback). A FileIR asserting a src that lives in
  another file is malformed; the edge is dropped rather than silently cross-owned. The DST
  may be cross-file and may use the batch map plus full-DB fallback; a path-hinted edge
  (relative import) resolves ONLY within its declared target file — never via the global
  bare-name fallback — and a bare hint without an extension cannot match a file family
  outside the importer's language.
- Ambiguous names resolve to nothing: the per-file map excludes qualified names occurring
  more than once (since identity is `(qualifiedName, filePath, label)`), so edges to them
  drop instead of binding to an arbitrary winner. In the full-DB fallback the same policy
  applies: ambiguous names drop the edge rather than attach it to the wrong node.
- When the caller supplies a content-derived node id, it wins over name resolution, and the
  id's row's `qualified_name` MUST match the edge's declared endpoint name — a stale or
  mismatched id+name pair is skipped (counted as skipped), never written from the wrong
  node.
- Producers that already hold precise identities (SIMILAR_TO candidates, LSP upgrades)
  persist edges by node id so duplicate qualified names across files stop dropping edges.
- The coding-graph package is the single owner of these identity types and of the
  graph store itself; callers construct identity through it rather than redefining it.

## Consequences
Same-name symbols keep distinct, stable identities across re-ingests; pruning stays
exact; and no edge is ever written to a guessed endpoint — ambiguity costs dropped edges
(a visible skip count), not corruption. Callers that need disambiguation must supply ids
or include the target file in the same batch; extending EdgeIR with file identity material
is the documented escape hatch. Name-only resolution is intentionally unusable as a
universal key.

Theme coverage: Records under coding-graph-node-id-resolution, coding-graph-node-id-determinism, similar-to-edge-node-ids, and coding-graph-type-ownership.

Merge note: One record (the package header comment establishing coding-graph as the graph store owner) was merged into this theme as its nearest neighbour; the chunk's ten themes were already at the file limit.

## Origin comments
- `packages/coding-graph/src/graph-store.ts:1464` — "node-id resolution (issue #1677). `nodes.id` is the PRIMARY KEY, so"
- `packages/coding-graph/src/graph-store.ts:1465` — "this is a unique, unambiguous lookup — a SIMILAR_TO edge between two"
- `packages/coding-graph/src/graph-store.ts:1466` — "same-qualified-name symbols resolves here instead of being dropped by"
- `packages/coding-graph/src/graph-store.ts:1467` — "the ambiguous qualified-name fallback. The row's qualified_name is"
- `packages/coding-graph/src/graph-store.ts:1468` — "returned so the caller's (src|dst)QualifiedName can be matched against"
- `packages/coding-graph/src/graph-store.ts:1469` — "it: a stale or mismatched id+qname pair is skipped (counted in"
- `packages/coding-graph/src/graph-store.ts:1470` — "`skipped`) rather than silently writing an edge from the wrong node"
- `packages/coding-graph/src/graph-store.ts:1471` — "(chatgpt-codex-connector P2 — id/qname consistency at the boundary)."
- `packages/coding-graph/src/graph-store.ts:1494` — "Prefer the content-derived node id when the caller supplied one"
- `packages/coding-graph/src/graph-store.ts:1495` — "(issue #1677). Only fall through to qualified-name resolution"
- `packages/coding-graph/src/graph-store.ts:1496` — "when no id is present, preserving the existing trace/HTTP_CALLS"
- `packages/coding-graph/src/graph-store.ts:1497` — "path verbatim. When an id IS supplied, its row's qualified_name"
- `packages/coding-graph/src/graph-store.ts:1498` — "MUST match the edge's (src|dst)QualifiedName — a mismatched pair"
- `packages/coding-graph/src/graph-store.ts:1499` — "(stale body map, custom integration) is skipped like a dangling"
- `packages/coding-graph/src/graph-store.ts:1500` — "edge instead of corrupting the graph (chatgpt-codex-connector P2)."
- `packages/coding-graph/src/graph-store.ts:1556` — "Build the seen id set FIRST (every symbol → its deterministic id)"
- `packages/coding-graph/src/graph-store.ts:1557` — "so the prune step is order-stable and never deletes an id we"
- `packages/coding-graph/src/graph-store.ts:1558` — "are about to (re)insert. Determinism is non-negotiable — see"
- `packages/coding-graph/src/graph-store.ts:1559` — "nodeIdFor for the canonical form."
- `packages/coding-graph/src/graph-store.ts:1676` — "Prune by id (NOT qualified_name). A symbol whose kind changed"
- `packages/coding-graph/src/graph-store.ts:1677` — "keeps the same qualifiedName but has a new node id; the old"
- `packages/coding-graph/src/graph-store.ts:1678` — "id's row must be deleted to keep the file's symbol set honest."
- `packages/coding-graph/src/graph-store.ts:1679` — "We do this AFTER the upserts so any same-id re-upsert above is"
- `packages/coding-graph/src/graph-store.ts:1680` — "preserved. The actual delete (and the dangling-edge count) is"
- `packages/coding-graph/src/graph-store.ts:1681` — "deferred to pruneFileNodes so the batch can share one batch-wide"
- `packages/coding-graph/src/graph-store.ts:1682` — "view of every pruned node before any cascade runs."
- `packages/coding-graph/src/graph-store.ts:1807` — "Build the set of edges the IR is asserting for this file. The"
- `packages/coding-graph/src/graph-store.ts:1808` — "SRC of each edge MUST belong to this file (it is resolved from"
- `packages/coding-graph/src/graph-store.ts:1809` — "the per-file `qualifiedNameToId` map only — no DB fallback);"
- `packages/coding-graph/src/graph-store.ts:1810` — "a FileIR that asserts an edge whose src is absent from this"
- `packages/coding-graph/src/graph-store.ts:1811` — "file but present elsewhere is malformed and the edge is dropped"
- `packages/coding-graph/src/graph-store.ts:1812` — "so it cannot be silently cross-owned. The DST may be cross-file"
- `packages/coding-graph/src/graph-store.ts:1813` — "and uses the full-DB fallback (chatgpt-codex-connector P2:"
- `packages/coding-graph/src/graph-store.ts:1814` — "'Require edge sources to belong to the ingested file'). Edges"
- `packages/coding-graph/src/graph-store.ts:1815` — "whose dst cannot resolve are also dropped — the caller is"
- `packages/coding-graph/src/graph-store.ts:1816` — "responsible for the batch's canonical file set (rule 40)."
- `packages/coding-graph/src/graph-store.ts:1824` — "Count qualified_name occurrences so ambiguous names are excluded."
- `packages/coding-graph/src/graph-store.ts:1825` — "Node identity is (qualifiedName, filePath, label) — two symbols in"
- `packages/coding-graph/src/graph-store.ts:1826` — "the same file CAN share a qualified_name (e.g. a TS type + value"
- `packages/coding-graph/src/graph-store.ts:1827` — "both named Foo, with different labels → different node ids). A"
- `packages/coding-graph/src/graph-store.ts:1828` — "qualified_name-only map would silently keep just one; instead,"
- `packages/coding-graph/src/graph-store.ts:1829` — "ambiguous names are left out so edges to them resolve to undefined"
- `packages/coding-graph/src/graph-store.ts:1830` — "and are dropped — matching the DST conservative-drop policy"
- `packages/coding-graph/src/graph-store.ts:1831` — "(chatgpt-codex-connector P2: 'Reject ambiguous local qualified names')."
- `packages/coding-graph/src/graph-store.ts:1875` — "SRC must be a symbol in THIS file — resolve from the per-file"
- `packages/coding-graph/src/graph-store.ts:1876` — "map only. A FileIR whose edge src lives in another file is"
- `packages/coding-graph/src/graph-store.ts:1877` — "malformed; dropping it prevents cross-owned edges that survive"
- `packages/coding-graph/src/graph-store.ts:1878` — "re-ingest (chatgpt-codex-connector P2)."
- `packages/coding-graph/src/graph-store.ts:1881` — "DST may be cross-file. A path-hinted edge (relative import,"
- `packages/coding-graph/src/graph-store.ts:1882` — "issue #1894 review) resolves ONLY within its declared target"
- `packages/coding-graph/src/graph-store.ts:1883` — "file — never via the global bare-name fallback; unhinted edges"
- `packages/coding-graph/src/graph-store.ts:1884` — "keep the batch-map + full-DB fallback."
- `packages/coding-graph/src/graph-store.ts:3047` — "Prefer a deterministic node id when supplied — it is unique, so it"
- `packages/coding-graph/src/graph-store.ts:3048` — "never hits the qualified-name ambiguity path."
- `packages/coding-graph/src/graph-store.ts:3570` — "Ambiguous — drop the edge rather than attach it to the wrong"
- `packages/coding-graph/src/graph-store.ts:3571` — "node. Callers needing disambiguation should include the target"
- `packages/coding-graph/src/graph-store.ts:3572` — "file in the same batch (the per-file map then wins) or extend"
- `packages/coding-graph/src/graph-store.ts:3573` — "EdgeIR with file identity material."
- `packages/coding-graph/src/graph-store.ts:3649` — "Language filter still applies on exact match: a TS import whose"
- `packages/coding-graph/src/graph-store.ts:3650` — "normalized hint happens to equal a bare directory name must not"
- `packages/coding-graph/src/graph-store.ts:3651` — "bind a same-named .py file (codex review round 15)."
- `packages/coding-graph/src/graph-store.ts:3653` — "return false; // bare hint with no extension cannot match a family"
- `packages/coding-graph/src/graph-store.ts:3662` — "When the importer's language family is known, only that family's"
- `packages/coding-graph/src/graph-store.ts:3663` — "extensions may satisfy the hint; otherwise any single extension."
- `packages/coding-graph/src/index.ts:1` — "/** * @remnic/coding-graph — symbol-extraction engine + SQLite knowledge-graph * store for codebase memory. * "
- `packages/coding-graph/src/semantic/semantic.test.ts:380` — "// Node ids are carried through so the store resolves endpoints by id"
- `packages/coding-graph/src/semantic/semantic.test.ts:381` — "// (issue #1677 — duplicate qualified-name support)."
- `packages/coding-graph/src/semantic/semantic.test.ts:1027` — "// SIMILAR_TO end-to-end: two symbols that share a qualified name across two"
- `packages/coding-graph/src/semantic/semantic.test.ts:1028` — "// files are persisted as a SIMILAR_TO edge by node id (issue #1677). Before"
- `packages/coding-graph/src/semantic/semantic.test.ts:1029` — "// the fix the edge was dropped because resolveNodeId returns undefined for an"
- `packages/coding-graph/src/semantic/semantic.test.ts:1030` — "// ambiguous qualified name."
