# Apply each ingest batch to the coding graph in one transaction with provenance-scoped stale-edge reconciliation

Status: accepted

## Context
Ingesting a batch of files mutates several interdependent row families: files, nodes,
edges, node attributes, and the FTS index. Partial application is catastrophic — a delete
that commits before its replacement upsert, or a prune that commits while ingest fails,
leaves a graph that lies. Two further forces shaped the design: (1) a batch re-asserts
edges of one derivation class (heuristic parse) while other provenances (trace, lsp) may
legitimately own edges on the same endpoints, so a naive "delete all stale edges" destroys
other analyses' work; (2) SQLite enforces a hard variable bind limit (~32766 in the bundled
build), so large prune and delete sets cannot be bound as a single IN list. Separately,
contentless FTS5 stores no column values, so search hits need an explicitly maintained
rowid-to-node mapping, and the reindex executor must not let its head marker advance ahead
of the data it describes.

## Decision
Every graph mutation is transactional, ordered, and scoped:

- The whole batch is applied in a single transaction (atomic and faster than per-file
  BEGIN/COMMIT); the coding graph is never partially written. The reindex executor hands
  its delete set (pruned paths) into the same store call, so prune + re-ingest commit or
  roll back together, and deleted-file rows are pruned in the same transaction as the
  upsert.
- The batch runs in ordered passes: pass 0 prunes deleted files; pass 1 upserts every
  file's nodes first (keeping FTS in sync and ensuring cross-file edge targets exist);
  pass 2 resolves and upserts edges against the full batch's node map and deletes prior
  src-owned edges that the current IR does not re-assert. This two-pass shape makes the
  pipeline order-independent for cross-file edges. Edges are re-resolved to their
  deterministic keys BEFORE the stale delete, so a re-asserted cross-file edge is never
  orphaned by delete-then-skip ordering.
- Stale-edge deletion is scoped by provenance: when the IR declares the provenances it
  asserts, only edges of those provenances are stale for this ingest; a fresh parse
  contradicts only its own derivation class. An EMPTY scope array is treated as absent
  (a truthy "[]" would otherwise protect every prior edge from deletion and updates,
  silently disabling cleanup). Within the scope, an lsp row is a strictly stronger
  derivation of the same source-derived edge: re-asserting the heuristic key keeps the
  row alive but must never downgrade it; lsp rows retire through the stale delete only
  when the call disappears from the parse.
- Duplicate `(src, dst, type)` keys in one FileIR are malformed input: first-edge metadata
  wins, later duplicates are skipped so they cannot inflate edge counts. Identical
  re-upserts are detected and skipped so the reported `changes` stays honest (idempotent
  re-ingest reports zero).
- Every IN-listed set (stale-edge deletes, prune sets, FTS rowid cleanup) is chunked under
  the SQLite variable bind limit; oversized unchunked deletes would throw and roll back
  the whole batch.
- The FTS reverse map (`fts_index`: FTS rowid to node id) is maintained on every upsert
  and delete: contentless FTS5 reads NULL for UNINDEXED columns on MATCH, so this table is
  the only way to join a search hit back to its node; stale rows are dropped before insert
  so a recycled rowid never points at the wrong node.
- Index head and pending-set metadata are persisted only AFTER the data transaction
  commits — never before, and only when the run actually rebuilt from an authoritative
  candidate set.

## Consequences
A crashed or failed ingest leaves the graph exactly as it was; re-running an identical
batch is a reported no-op; other provenances' edges survive a heuristic-only re-parse, and
upgraded lsp rows retire correctly when their call sites vanish. The costs: writes are
strictly serialized per store (concurrent writers queue), the pass structure makes large
ingests do two sweeps, and provenance scoping means a caller that forgets to declare its
scope gets legacy delete-all-stale behavior — the empty-array trap is deliberately
coalesced with "no scope" to keep cleanup from silently disabling itself.

Theme coverage: Records under coding-graph-write-pipeline, coding-graph-edge-provenance-scoping, heuristic-edge-provenance, coding-graph-sqlite-bind-limit-chunking, coding-graph-fts-contentless, and reindex-transaction-ordering.

## Origin comments
- `packages/coding-graph/src/graph-store.ts:1365` — "Single transaction for the whole batch — atomic, faster than"
- `packages/coding-graph/src/graph-store.ts:1366` — "per-file BEGIN/COMMIT, and rule 34 mandates "never partial-write"
- `packages/coding-graph/src/graph-store.ts:1367` — "a coding graph". Two passes: pass 1 upserts every file's nodes"
- `packages/coding-graph/src/graph-store.ts:1368` — "(so FTS stays in sync and cross-file edge targets exist by the"
- `packages/coding-graph/src/graph-store.ts:1369` — "time pass 2 runs), pass 2 resolves edges against the full"
- `packages/coding-graph/src/graph-store.ts:1370` — "batch's node map and deletes prior edges owned by these files"
- `packages/coding-graph/src/graph-store.ts:1371` — "so changed confidence/provenance values overwrite. The two"
- `packages/coding-graph/src/graph-store.ts:1372` — "passes together make the write pipeline order-independent for"
- `packages/coding-graph/src/graph-store.ts:1373` — "cross-file edges (chatgpt-codex-connector P1/P2)."
- `packages/coding-graph/src/graph-store.ts:1375` — "Pass 0 (issue #1553): prune deleted-file rows in the SAME"
- `packages/coding-graph/src/graph-store.ts:1376` — "transaction as the upsert so a failure rolls both back"
- `packages/coding-graph/src/graph-store.ts:1377` — "atomically (cursor Bugbot: 'Deletes commit before ingest"
- `packages/coding-graph/src/graph-store.ts:1378` — "fails'). Cascades to nodes + edges + node_attributes."
- `packages/coding-graph/src/graph-store.ts:1400` — "Pass 1b: count + delete dangling edges per file. The src"
- `packages/coding-graph/src/graph-store.ts:1401` — "exclusion uses the BATCH-WIDE pruned set, not just this"
- `packages/coding-graph/src/graph-store.ts:1402` — "file's, so an edge whose both ends are pruned in different"
- `packages/coding-graph/src/graph-store.ts:1403` — "files is never reported as "dangling" — it is"
- `packages/coding-graph/src/graph-store.ts:1404` — "cascade-deleted, and the reported loss no longer depends on"
- `packages/coding-graph/src/graph-store.ts:1405` — "which file the loop visits first"
- `packages/coding-graph/src/graph-store.ts:1406` — "(chatgpt-codex-connector P2: 'Count dangling edges against"
- `packages/coding-graph/src/graph-store.ts:1407` — "the whole batch')."
- `packages/coding-graph/src/graph-store.ts:1423` — "Pass 3 (PR2): every file's node_attributes rows"
- `packages/coding-graph/src/graph-store.ts:1424` — "(`is_exported`, `is_route_handler`). Derived from the IR's"
- `packages/coding-graph/src/graph-store.ts:1425` — "optional `exports` and `routes` arrays. Runs after the prune"
- `packages/coding-graph/src/graph-store.ts:1426` — "so attribute rows for nodes that survived into this batch"
- `packages/coding-graph/src/graph-store.ts:1427` — "are written against the final node set. Cascade-delete on"
- `packages/coding-graph/src/graph-store.ts:1428` — "`nodes(id)` already cleaned up rows for pruned nodes during"
- `packages/coding-graph/src/graph-store.ts:1429` — "pass 1b; this pass only inserts new / updates existing rows"
- `packages/coding-graph/src/graph-store.ts:1430` — "for surviving nodes."
- `packages/coding-graph/src/graph-store.ts:1572` — "Snapshot the prior nodes owned by this file so we can (a) skip"
- `packages/coding-graph/src/graph-store.ts:1573` — "true no-op UPSERTs to keep `changes` honest, and (b) count"
- `packages/coding-graph/src/graph-store.ts:1574` — "dangling edges the prune step will cascade."
- `packages/coding-graph/src/graph-store.ts:1616` — "fts_index: maps FTS rowid → node id so PR2's search can JOIN"
- `packages/coding-graph/src/graph-store.ts:1617` — "hits back to `nodes`. Contentless FTS5 does NOT store column"
- `packages/coding-graph/src/graph-store.ts:1618` — "values, so the `id UNINDEXED` column reads NULL on every"
- `packages/coding-graph/src/graph-store.ts:1619` — "MATCH — this table is the only reverse-mapping the read path"
- `packages/coding-graph/src/graph-store.ts:1620` — "has (chatgpt-codex-connector P2: 'Preserve a node key for"
- `packages/coding-graph/src/graph-store.ts:1621` — "FTS hits'). UNIQUE(node_id) lets the upsert use INSERT OR"
- `packages/coding-graph/src/graph-store.ts:1622` — "REPLACE so a same-node re-upsert (the common no-op path)"
- `packages/coding-graph/src/graph-store.ts:1623` — "keeps a single mapping row."
- `packages/coding-graph/src/graph-store.ts:1648` — "Drop any prior FTS row for this id before the new INSERT."
- `packages/coding-graph/src/graph-store.ts:1649` — "Contentless FTS5 (`content=''`) does NOT store UNINDEXED"
- `packages/coding-graph/src/graph-store.ts:1650` — "column values, so the only reliable key is the deterministic"
- `packages/coding-graph/src/graph-store.ts:1651` — "rowid we derive from the node id hash (chatgpt-codex-connector"
- `packages/coding-graph/src/graph-store.ts:1652` — "P2: `WHERE id = ?` matches zero rows in contentless mode)."
- `packages/coding-graph/src/graph-store.ts:1655` — "Mirror the delete into the FTS → node id reverse map so a"
- `packages/coding-graph/src/graph-store.ts:1656` — "re-upsert does not collide on the UNIQUE(fts_rowid) PK when"
- `packages/coding-graph/src/graph-store.ts:1657` — "the same rowid previously pointed at a different node id"
- `packages/coding-graph/src/graph-store.ts:1658` — "(chatgpt-codex-connector P2: 'Preserve a node key for"
- `packages/coding-graph/src/graph-store.ts:1659` — "FTS hits')."
- `packages/coding-graph/src/graph-store.ts:1719` — "Two temp tables keep the IN / NOT IN queries under SQLite's"
- `packages/coding-graph/src/graph-store.ts:1720` — "~32766 variable bind limit for large prune sets (cursor Bugbot:"
- `packages/coding-graph/src/graph-store.ts:1721` — "'Prune path exceeds SQL variable limit'). Each insert binds 1"
- `packages/coding-graph/src/graph-store.ts:1722` — "param; the subquery-based count/delete bind zero."
- `packages/coding-graph/src/graph-store.ts:1754` — "Count dangling edges BEFORE the cascade: dst is a node pruned by"
- `packages/coding-graph/src/graph-store.ts:1755` — "THIS file AND src is NOT pruned anywhere in the batch (edges"
- `packages/coding-graph/src/graph-store.ts:1756` — "between two batch-pruned nodes are cascade-deleted, not"
- `packages/coding-graph/src/graph-store.ts:1757` — ""dangling", and must not be attributed to either file)."
- `packages/coding-graph/src/graph-store.ts:1774` — "FTS + fts_index cleanup: rowids are derived in JS (not SQL),"
- `packages/coding-graph/src/graph-store.ts:1775` — "so chunk the IN list to stay under the bind limit."
- `packages/coding-graph/src/graph-store.ts:1796` — "If edges are not provided (undefined or null — e.g. from JSON"
- `packages/coding-graph/src/graph-store.ts:1797` — "deserialization), preserve prior edges rather than treating a"
- `packages/coding-graph/src/graph-store.ts:1798` — "missing field as an empty assertion set. A bare core"
- `packages/coding-graph/src/graph-store.ts:1799` — "ParseResult.ir (which has no edges field) re-upsert must NOT"
- `packages/coding-graph/src/graph-store.ts:1800` — "wipe previously stored edges. An explicit empty array [] DOES"
- `packages/coding-graph/src/graph-store.ts:1801` — "assert "no edges" and deletes all prior src-owned edges"
- `packages/coding-graph/src/graph-store.ts:1802` — "(cursor Bugbot: 'Omitted edges field wipes stored edges' /"
- `packages/coding-graph/src/graph-store.ts:1803` — "'Null edges wipe stored edges')."
- `packages/coding-graph/src/graph-store.ts:1843` — "Re-resolve each edge in the IR to its deterministic key so the"
- `packages/coding-graph/src/graph-store.ts:1844` — "delete below only drops edges that are NOT being re-asserted."
- `packages/coding-graph/src/graph-store.ts:1845` — "Doing this BEFORE the delete is critical: deleting first then"
- `packages/coding-graph/src/graph-store.ts:1846` — "checking the no-op skip leaves cross-file edges (whose src is"
- `packages/coding-graph/src/graph-store.ts:1847` — "owned here but whose dst lives elsewhere) orphaned when the"
- `packages/coding-graph/src/graph-store.ts:1848` — "IR re-asserts them — the prior-edge snapshot matches, the"
- `packages/coding-graph/src/graph-store.ts:1849` — "insert is skipped, and the row is gone (cursor Bugbot #6a78cd0a)."
- `packages/coding-graph/src/graph-store.ts:1851` — "Map each resolved key to its first edge so the insertion pass"
- `packages/coding-graph/src/graph-store.ts:1852` — "can look up metadata in O(1) instead of rescanning ir.edges"
- `packages/coding-graph/src/graph-store.ts:1853` — "and re-running resolveNodeId (with DB lookups) per key"
- `packages/coding-graph/src/graph-store.ts:1854` — "(chatgpt-codex-connector P2: 'Preserve resolved edge metadata"
- `packages/coding-graph/src/graph-store.ts:1855` — "instead of rescanning'). First-edge-wins dedupe policy"
- `packages/coding-graph/src/graph-store.ts:1856` — "(cursor Bugbot #28876d4c) is preserved by only setting on"
- `packages/coding-graph/src/graph-store.ts:1857` — "first occurrence."
- `packages/coding-graph/src/graph-store.ts:1902` — "Pre-fetch the prior edges owned by this file (src in this file's"
- `packages/coding-graph/src/graph-store.ts:1903` — "nodes) so we can (a) skip the no-op re-upsert when confidence +"
- `packages/coding-graph/src/graph-store.ts:1904` — "provenance match exactly, and (b) compute the stale-edge delete"
- `packages/coding-graph/src/graph-store.ts:1905` — "set: prior src-owned edges that are NOT in the current IR's"
- `packages/coding-graph/src/graph-store.ts:1906` — "asserted keys."
- `packages/coding-graph/src/graph-store.ts:1923` — "Provenance scoping (issue #1891): when the IR declares which"
- `packages/coding-graph/src/graph-store.ts:1924` — "provenances it asserts, stale edges of OTHER provenances are not"
- `packages/coding-graph/src/graph-store.ts:1925` — "this ingest's to delete — a fresh parse contradicts only its own"
- `packages/coding-graph/src/graph-store.ts:1926` — "derivation class (rule 25). Absent = legacy delete-all-stale."
- `packages/coding-graph/src/graph-store.ts:1927` — "An EMPTY scope array is treated as absent (cursor review round 9):"
- `packages/coding-graph/src/graph-store.ts:1928` — ""[]" would otherwise be truthy, protect every prior edge from"
- `packages/coding-graph/src/graph-store.ts:1929` — "deletion AND from updates, and silently disable cleanup — an"
- `packages/coding-graph/src/graph-store.ts:1930` — "assertion that scopes nothing scopes nothing."
- `packages/coding-graph/src/graph-store.ts:1943` — "Delete only the stale src-owned edges (prior-but-not-asserted)."
- `packages/coding-graph/src/graph-store.ts:1944` — "This preserves any cross-file edge that the current IR"
- `packages/coding-graph/src/graph-store.ts:1945` — "re-asserts, even when its dst lives in a file NOT in this"
- `packages/coding-graph/src/graph-store.ts:1946` — "batch — the row survives the delete and the no-op skip below"
- `packages/coding-graph/src/graph-store.ts:1947` — "keeps `changes` honest."
- `packages/coding-graph/src/graph-store.ts:1949` — "Chunk the deletes: each tuple binds 3 parameters and SQLite"
- `packages/coding-graph/src/graph-store.ts:1950` — "enforces a variable limit (32766 in the bundled build). An"
- `packages/coding-graph/src/graph-store.ts:1951` — "unbounded IN list would throw `too many SQL variables` for a"
- `packages/coding-graph/src/graph-store.ts:1952` — "file with >10,922 stale edges, rolling back the whole batch"
- `packages/coding-graph/src/graph-store.ts:1953` — "(chatgpt-codex-connector P2: 'Chunk stale-edge deletes before"
- `packages/coding-graph/src/graph-store.ts:1954` — "binding them')."
- `packages/coding-graph/src/graph-store.ts:1974` — "Dedupe keys: a FileIR with two edges sharing `(src, dst, type)`"
- `packages/coding-graph/src/graph-store.ts:1975` — "(but differing confidence/provenance) is malformed input. First-edge"
- `packages/coding-graph/src/graph-store.ts:1976` — "metadata wins; later duplicates are skipped so they cannot inflate"
- `packages/coding-graph/src/graph-store.ts:1977` — "edgeCount via redundant re-upserts (cursor Bugbot #28876d4c)."
- `packages/coding-graph/src/graph-store.ts:1993` — "Identical to the prior row — no INSERT/UPDATE needed, so"
- `packages/coding-graph/src/graph-store.ts:1994` — "`changes` stays 0 and the idempotency contract holds. The"
- `packages/coding-graph/src/graph-store.ts:1995` — "row still exists because the delete above only removed"
- `packages/coding-graph/src/graph-store.ts:1996` — "stale keys."
- `packages/coding-graph/src/graph-store.ts:1999` — "Two update-path protections under provenance scoping (issue"
- `packages/coding-graph/src/graph-store.ts:2000` — "#1891 + #1894 review rounds):"
- `packages/coding-graph/src/graph-store.ts:2001` — "1. a prior row whose provenance is OUTSIDE the asserted scope"
- `packages/coding-graph/src/graph-store.ts:2002` — "is not this assertion's to modify (defense in depth — in"
- `packages/coding-graph/src/graph-store.ts:2003` — "practice cross-provenance key collisions are heuristic/lsp"
- `packages/coding-graph/src/graph-store.ts:2004` — "only, handled by 2);"
- `packages/coding-graph/src/graph-store.ts:2005` — "2. an lsp row is a strictly stronger derivation of the SAME"
- `packages/coding-graph/src/graph-store.ts:2006` — "source-derived edge: re-asserting the heuristic key keeps"
- `packages/coding-graph/src/graph-store.ts:2007` — "the row alive (it is not stale) but must never downgrade it."
- `packages/coding-graph/src/graph-store.ts:2008` — "Retirement of lsp rows happens through the stale-delete when"
- `packages/coding-graph/src/graph-store.ts:2009` — "the call disappears from the parse — lsp IS in the reindex"
- `packages/coding-graph/src/graph-store.ts:2010` — "assertion scope precisely so vanished calls retire their"
- `packages/coding-graph/src/graph-store.ts:2011` — "upgraded rows too."
- `packages/coding-graph/src/reindex.ts:510` — "Persist the updated pending set BEFORE any head write"
- `packages/coding-graph/src/reindex.ts:511` — "meta updates after the data transaction commits"
- `packages/coding-graph/src/reindex.ts:585` — "persist head ONLY after data + pending-set commit"
- `packages/coding-graph/src/reindex.ts:586` — "when candidates were authoritative"
- `packages/coding-graph/src/reindex.ts:640` — "Pass toDelete into upsertFileBatch so the prune + re-ingest land in ONE transaction"
- `packages/coding-graph/src/reindex.ts:641` — "a mid-batch failure rolls both back"
- `packages/coding-graph/src/reindex.ts:642` — "Deletes commit before ingest fails"
- `packages/coding-graph/src/reindex.ts:664` — "persist head ONLY after data commits."
- `packages/coding-graph/src/reindex.ts:897` — "Phase A heuristic resolution: derive CALLS edge assertions from the fresh parse"
- `packages/coding-graph/src/reindex.ts:898` — "assertions from the fresh parse before ingest."
- `packages/coding-graph/src/reindex.ts:899` — "explicit edges array plus a provenance scope of heuristic"
- `packages/coding-graph/src/reindex.ts:900` — "stale heuristic edges from a prior version are cleaned up"
- `packages/coding-graph/src/reindex.ts:901` — "trace/lsp edges owned by the file survive"
- `packages/coding-graph/src/reindex.ts:907` — "Even when batch is empty we must run the upsert so deletePaths are pruned atomically"
- `packages/coding-graph/src/reindex.ts:908` — "pruned atomically (the store's transaction wraps both)."
- `packages/coding-graph/src/reindex.ts:909` — "zero-delete call is a cheap no-op."
