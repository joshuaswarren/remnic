# Graph read APIs return tagged results with fixed traversal, dead-code, and snippet semantics

Status: accepted

## Context
Read APIs (traverse, bounded paths, search, snippets, dead-code) serve callers that
cannot distinguish "no result" from "the store broke". Before this decision, SQLite errors
escaped read APIs as raw throws, a node vanishing mid-read crashed callers, and several
semantic traps produced wrong answers instead of errors: a mistyped start id silently
matching an unrelated qualified name, self-loop edges double-counted under bidirectional
traversal, a path cap consumed by sub-minimum prefixes, a private recursive helper counted
as externally used, and a stale snippet span throwing after a file edit.

## Decision
Read contracts are total (tagged result, never a raw throw) and their semantics are
fixed:

- Every read API wraps DB access in a guard that maps SQLITE_BUSY / SQLITE_CORRUPT into
  the tagged failure shape (same across schemaStats, deadCode, traverse, search, snippet).
  Non-SQLite errors are NOT tagged as disk corruption — they are validation or programming
  errors and are re-thrown so the caller sees the real failure. A node that vanishes
  between resolution and read is treated as unknown rather than crashing.
- Traverse start resolution splits by shape: a 64-char lowercase hex string resolves ONLY
  by node id; anything else resolves ONLY by qualified name. The two paths never mix, so a
  mistyped id cannot silently match an unrelated name and a unique id cannot be reported
  ambiguous. A qualified name declared in multiple files rejects with a request for an
  explicit id.
- Traverse is a BFS with edge-type filtering bound as parameters (empty list means all
  types; user input can never inject SQL). The visited set handles cycles and self-edges:
  a self-loop on the start never re-expands.
- Bounded-path search is a recursive DFS that rejects depths which would overflow it, emits
  only paths of at least `minHops` (the `maxPaths` cap protects the in-range result set,
  not discarded shorter prefixes), dedupes relationships by the canonical
  `(src, dst, type)` key so outgoing-then-incoming re-walks of one edge and
  both-direction self-loops emit once, and explores while below `maxHops`.
- Dead-code reachability counts inbound usage from an explicit, auditable named constant
  of edge types (bound as a parameterized IN list); self-edges are excluded from inbound
  usage so a symbol whose only edge is to itself stays correctly reportable as dead; path
  exclusions run in JS against a named constant because SQLite regex support is opt-in and
  build-dependent.
- Snippets read half-open `[startByte, endByte)`; `endByte` is clamped to the buffer
  length so a stale span after a file edit returns an empty snippet for the caller to
  judge (re-ingest), rather than throwing. Context lines expand by full line-aligned lines
  (walking newline boundaries, counting the span line's own terminator separately) and are
  capped so a caller cannot request megabytes of context.

## Consequences
Callers program against one tagged result shape instead of try/catch around every
read, and traversal results are deterministic and duplicate-free under cycles, self-loops,
and bidirectional walks. The costs: id-vs-name start resolution is shape-sniffing (a
caller holding an unusual qualified name that looks like hex must pass it as an explicit
id), dead-code edge types live in a named constant that must be extended when a new
provenance adds usage edges, and stale spans degrade to empty snippets rather than
surfacing the staleness directly.

Theme coverage: Records under coding-graph-traverse-semantics, coding-graph-read-tagged-failures, coding-graph-deadcode-exclusions, coding-graph-context-lines-alignment, and coding-graph-stale-span-guard.

## Origin comments
- `packages/coding-graph/src/graph-store.ts:2223` — "Wrap DB operations in try/catch so lock/corrupt errors return a"
- `packages/coding-graph/src/graph-store.ts:2224` — "tagged failure instead of throwing (cursor Bugbot: 'SQLite errors"
- `packages/coding-graph/src/graph-store.ts:2225` — "escape read APIs'). Same shape as schemaStats/deadCode."
- `packages/coding-graph/src/graph-store.ts:2227` — "Resolve the start node. If `start` is a 64-char lowercase hex"
- `packages/coding-graph/src/graph-store.ts:2228` — "string (the nodeIdFor sha256 format), resolve ONLY by id — this"
- `packages/coding-graph/src/graph-store.ts:2229` — "is the unambiguous path a caller uses after seeing an ambiguous"
- `packages/coding-graph/src/graph-store.ts:2230` — "qualified_name rejection. Otherwise resolve ONLY by qualified_name."
- `packages/coding-graph/src/graph-store.ts:2231` — "Splitting the two paths (cursor Bugbot: 'Traverse start conflates id"
- `packages/coding-graph/src/graph-store.ts:2232` — "and name') prevents a mistyped id from silently matching an"
- `packages/coding-graph/src/graph-store.ts:2233` — "unrelated qualified_name, and prevents a unique id from being"
- `packages/coding-graph/src/graph-store.ts:2234` — "reported as ambiguous just because some other node shares the id"
- `packages/coding-graph/src/graph-store.ts:2235` — "string as a qualified_name."
- `packages/coding-graph/src/graph-store.ts:2252` — "Multiple rows mean the start resolved to more than one node —"
- `packages/coding-graph/src/graph-store.ts:2253` — "either the same id matching twice (impossible — PRIMARY KEY)"
- `packages/coding-graph/src/graph-store.ts:2254` — "or a qualified_name declared in multiple files. Reject so the"
- `packages/coding-graph/src/graph-store.ts:2255` — "caller passes an explicit node id."
- `packages/coding-graph/src/graph-store.ts:2260` — "BFS. Edge-type filter is bound into the prepared statement via"
- `packages/coding-graph/src/graph-store.ts:2261` — "IN (?, ?, ...) — empty list means "all types" (no WHERE clause"
- `packages/coding-graph/src/graph-store.ts:2262` — "on type). The edge-type list is small (≤ ~25) so chunking is"
- `packages/coding-graph/src/graph-store.ts:2263` — "unnecessary here, but we still parameterize so user input"
- `packages/coding-graph/src/graph-store.ts:2264` — "cannot inject SQL."
- `packages/coding-graph/src/graph-store.ts:2294` — "Race: the node vanished between the resolve and the read."
- `packages/coding-graph/src/graph-store.ts:2295` — "Treat as unknown rather than crash."
- `packages/coding-graph/src/graph-store.ts:2334` — "Cycle safety: a node already in `visited` is not re-added."
- `packages/coding-graph/src/graph-store.ts:2335` — "This also handles self-edges (src == dst): the start is in"
- `packages/coding-graph/src/graph-store.ts:2336` — "visited, so a self-loop on it never re-expands the frontier."
- `packages/coding-graph/src/graph-store.ts:2409` — "Reject depths that would overflow the recursive DFS before maxPaths"
- `packages/coding-graph/src/graph-store.ts:2410` — "can bind it (chatgpt-codex-connector P2: 'Avoid recursive DFS for deep"
- `packages/coding-graph/src/graph-store.ts:2411` — "bounded paths')."
- `packages/coding-graph/src/graph-store.ts:2462` — "Resolve the start node — same split id/qualified_name policy as"
- `packages/coding-graph/src/graph-store.ts:2463` — "traverse (cursor Bugbot: 'Traverse start conflates id and name')."
- `packages/coding-graph/src/graph-store.ts:2489` — "Return the canonical (src, dst, type) so relationship-uniqueness keys"
- `packages/coding-graph/src/graph-store.ts:2490` — "are direction-independent: traversing edge A->B outgoing then B->A"
- `packages/coding-graph/src/graph-store.ts:2491` — "incoming reuses the SAME relationship and is blocked."
- `packages/coding-graph/src/graph-store.ts:2551` — "Dedupe by the canonical (src, dst, type) key. Under"
- `packages/coding-graph/src/graph-store.ts:2552` — "direction "both" a SELF-LOOP (src == dst) is matched by BOTH"
- `packages/coding-graph/src/graph-store.ts:2553` — "the outgoing and incoming SELECTs, and because usedEdges is"
- `packages/coding-graph/src/graph-store.ts:2554` — "cleared after each branch the same relationship-simple path"
- `packages/coding-graph/src/graph-store.ts:2555` — "would otherwise be emitted twice -- violating the one-hit-per-"
- `packages/coding-graph/src/graph-store.ts:2556` — "distinct-path contract and double-consuming the maxPaths cap"
- `packages/coding-graph/src/graph-store.ts:2557` — "(chatgpt-codex-connector P2: 'Deduplicate self-loop edges for"
- `packages/coding-graph/src/graph-store.ts:2558` — "both-direction traversal'). The UNIQUE(src,dst,type) table"
- `packages/coding-graph/src/graph-store.ts:2559` — "constraint guarantees no dup within a single direction, so this"
- `packages/coding-graph/src/graph-store.ts:2560` — "only ever collapses the both-direction self-loop overlap."
- `packages/coding-graph/src/graph-store.ts:2579` — "Recursive DFS. `length` is the current path's hop count (edges taken)."
- `packages/coding-graph/src/graph-store.ts:2580` — "We EXPLORE while length < maxHops (shorter prefixes must be walked to"
- `packages/coding-graph/src/graph-store.ts:2581` — "reach longer paths) but EMIT only when newLength >= minHops, so the"
- `packages/coding-graph/src/graph-store.ts:2582` — "maxPaths cap protects the in-range result set instead of being"
- `packages/coding-graph/src/graph-store.ts:2583` — "consumed by discarded shorter prefixes (cursor Bugbot: 'Path cap"
- `packages/coding-graph/src/graph-store.ts:2584` — "ignores hop minimum')."
- `packages/coding-graph/src/graph-store.ts:2695` — "Wrap DB operations in try/catch (cursor Bugbot: 'SQLite errors"
- `packages/coding-graph/src/graph-store.ts:2696` — "escape read APIs'). Same shape as schemaStats/deadCode/traverse."
- `packages/coding-graph/src/graph-store.ts:2846` — "The inbound-usage edge-type list comes from the named"
- `packages/coding-graph/src/graph-store.ts:2847` — "constant; bind it as a parameterized IN (...) so the criteria"
- `packages/coding-graph/src/graph-store.ts:2848` — "are auditable in one place and a future edge-type add is a"
- `packages/coding-graph/src/graph-store.ts:2849` — "one-line constant extension."
- `packages/coding-graph/src/graph-store.ts:2856` — "Self-edges (e.src <> n.id) are excluded from inbound usage: a"
- `packages/coding-graph/src/graph-store.ts:2857` — "private recursive helper whose only edge is `fn → fn` is"
- `packages/coding-graph/src/graph-store.ts:2858` — "unreachable from the rest of the program, so the self-call"
- `packages/coding-graph/src/graph-store.ts:2859` — "must not count as external usage — otherwise deadCode() omits"
- `packages/coding-graph/src/graph-store.ts:2860` — "it and the unreferenced symbol stays invisible"
- `packages/coding-graph/src/graph-store.ts:2861` — "(chatgpt-codex-connector P2: 'Ignore self-edges in dead-code"
- `packages/coding-graph/src/graph-store.ts:2862` — "reachability')."
- `packages/coding-graph/src/graph-store.ts:2890` — "Apply path-based exclusions in JS — SQLite's regex support is"
- `packages/coding-graph/src/graph-store.ts:2891` — "opt-in and inconsistent across builds; doing it here keeps the"
- `packages/coding-graph/src/graph-store.ts:2892` — "exclusion logic entirely in the named constant."
- `packages/coding-graph/src/graph-store.ts:3077` — "Wrap the DB lookup in try/catch (cursor Bugbot: 'SQLite errors"
- `packages/coding-graph/src/graph-store.ts:3078` — "escape read APIs'). The file read below has its own catch."
- `packages/coding-graph/src/graph-store.ts:3124` — "Half-open [startByte, endByte). Guard endByte ≤ buffer.length"
- `packages/coding-graph/src/graph-store.ts:3125` — "so a stale span after a file edit does not throw OutOfRange."
- `packages/coding-graph/src/graph-store.ts:3129` — "The file shrank below the span — return an empty snippet"
- `packages/coding-graph/src/graph-store.ts:3130` — "rather than throw; the caller can decide whether to re-ingest."
- `packages/coding-graph/src/graph-store.ts:3151` — "Line-aligned expansion. For contextLines=N we include the N"
- `packages/coding-graph/src/graph-store.ts:3152` — "full lines preceding the span's line and the N full lines"
- `packages/coding-graph/src/graph-store.ts:3153` — "following the span's line. Walk backward from `start`,"
- `packages/coding-graph/src/graph-store.ts:3154` — "skipping (contextLines) line-end newlines, then walk to the"
- `packages/coding-graph/src/graph-store.ts:3155` — "start of the (contextLines+1)th line back; walk forward"
- `packages/coding-graph/src/graph-store.ts:3156` — "from `end` symmetrically."
- `packages/coding-graph/src/graph-store.ts:3157` — ""
- `packages/coding-graph/src/graph-store.ts:3158` — "The first newline we hit going backward is the END of the"
- `packages/coding-graph/src/graph-store.ts:3159` — "span's own line, NOT a context line — so we need to count"
- `packages/coding-graph/src/graph-store.ts:3160` — "`contextLines` newlines after that boundary to find where"
- `packages/coding-graph/src/graph-store.ts:3161` — "the context region begins. Concrete example for N=1:"
- `packages/coding-graph/src/graph-store.ts:3162` — ""...line one\nline two\n..."  with span starting at "line two""
- `packages/coding-graph/src/graph-store.ts:3163` — "walking back from start of "line two", we hit \n (end of"
- `packages/coding-graph/src/graph-store.ts:3164` — ""line one"). The line "line one" IS the context. Its start"
- `packages/coding-graph/src/graph-store.ts:3165` — "is one further newline back (or buffer start)."
- `packages/coding-graph/src/graph-store.ts:3694` — "Error classification — tag SQLITE_BUSY / SQLITE_CORRUPT into the failure"
- `packages/coding-graph/src/graph-store.ts:3695` — "shape (rule 34). better-sqlite3 surfaces them as `SqliteError` with `.code`."
- `packages/coding-graph/src/graph-store.ts:3711` — "Non-SQLite errors are NOT disk corruption — they are validation"
- `packages/coding-graph/src/graph-store.ts:3712` — "failures (e.g. invalid edge provenance) or programming errors."
- `packages/coding-graph/src/graph-store.ts:3713` — "Conflating them with `db_corrupt` would tell the caller to stop"
- `packages/coding-graph/src/graph-store.ts:3714` — "trusting the store for the wrong reason; re-throw so the caller"
- `packages/coding-graph/src/graph-store.ts:3715` — "sees the real error (chatgpt-codex-connector P2)."
