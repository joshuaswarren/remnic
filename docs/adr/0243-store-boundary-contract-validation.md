# Validate file and query contracts at the coding-graph store boundary, rejecting violations instead of normalizing them

Status: accepted

## Context
The graph store sits at a trust boundary. Its TypeScript types promise a canonical
FileIR shape, but runtime callers include JSON deserialization, MCP tool forwarding, and
external parser integrations that can violate the type contract: null where a field is
required, non-canonical path spellings, inverted byte spans, non-array attribute values,
bare strings where arrays are expected, and malformed read-query objects. Historically the
store was lenient: `?? []` fallbacks and silent normalization turned bad input into
destructive behavior — a missing `symbols` field silently wiped every node and edge
for a path while the batch still reported ok, and a malformed `exports` value wiped every
`is_exported`/`is_route_handler` flag, misclassifying live code as dead. Read APIs had the
mirror problem: a malformed query threw raw TypeErrors instead of returning the tagged
`invalid_query` failure the read contract advertises.

## Decision
The store validates every contract where data enters, and rejects violations with a
precise tagged failure instead of normalizing, defaulting, or guessing:

- Paths must be canonical, repo-relative, forward-slash paths. Dot-segment aliases
  (`./src/a.ts`, `src/../a.ts`) are rejected by a segment-based check (so names like
  `a..b.ts` are not false positives) because they would hash to duplicate rows the
  canonical ingest can never match or prune.
- `symbols` is a required field: a null or missing value is rejected, never treated as an
  empty array, so a malformed parse can never prune a file's existing graph rows.
- Symbol spans must be integers, non-negative, with `startByte <= endByte`, rejected
  before insertion so bad IR cannot corrupt span metadata that snippet and search
  consumers trust as half-open byte offsets.
- Optional `exports`/`routes` attributes, when present, MUST be arrays whose entries each
  carry a non-empty string `name`; a malformed value or entry rejects the whole batch
  before any flag rebuild runs.
- Read-query objects are validated before any dereference: `start` a non-empty string,
  `maxDepth`/`minHops`/`maxPaths`/numeric limits valid integers (malformed explicit values
  are rejected, not silently defaulted — only `undefined` defaults), `direction` checked
  against the allowed set with `null` rejected explicitly (null is a malformed value, not
  an absent one), `edgeTypes` an array of strings, string filters actually strings, and
  `contextLines` a non-negative integer (no coercion).
- Search limits are clamped only after type validation, to `[0, MAX_SEARCH_LIMIT]`, so a
  `limit: 0` returns an empty result rather than an unbounded one.

The rule a reader must follow: never repair bad input at the store; surface it. A caller
that passes garbage learns exactly what was wrong at the moment it passed it.

## Consequences
Malformed input fails loudly at ingest or query time instead of corrupting graph data
silently — silent wipes, dead-code misclassification, and contaminated spans are
structurally impossible. The cost is strictness: callers that relied on lenient coercion
(`"2"` for `contextLines`, `1.9` depths) must send well-typed values, and the store carries
runtime validation that duplicates part of the static type contract, because TypeScript
types alone cannot stop JSON-deserialization or MCP-boundary payloads.

Theme coverage: Records under coding-graph-boundary-validation (all in the graph store).

## Origin comments
- `packages/coding-graph/src/graph-store.ts:1270` — "repo-relative forward-slash paths; reject the violation at the"
- `packages/coding-graph/src/graph-store.ts:1271` — "store boundary rather than silently normalizing"
- `packages/coding-graph/src/graph-store.ts:1272` — "(chatgpt-codex-connector P2: 'Reject non-canonical file paths"
- `packages/coding-graph/src/graph-store.ts:1273` — "before persisting')."
- `packages/coding-graph/src/graph-store.ts:1281` — "`symbols` is a REQUIRED FileIR contract field (non-optional"
- `packages/coding-graph/src/graph-store.ts:1282` — "`readonly symbols: readonly SymbolIR[]`). Runtime null can"
- `packages/coding-graph/src/graph-store.ts:1283` — "still arrive via JSON deserialization or a malformed parser"
- `packages/coding-graph/src/graph-store.ts:1284` — "result; without this guard the `?? []` fallback made a"
- `packages/coding-graph/src/graph-store.ts:1285` — "missing/null field indistinguishable from an explicit empty"
- `packages/coding-graph/src/graph-store.ts:1286` — "array, so the prune step silently wiped every existing"
- `packages/coding-graph/src/graph-store.ts:1287` — "node/edge for the path while the batch returned ok. Reject"
- `packages/coding-graph/src/graph-store.ts:1288` — "the contract violation instead of clearing the file"
- `packages/coding-graph/src/graph-store.ts:1289` — "(chatgpt-codex-connector P2: 'Reject missing symbols instead"
- `packages/coding-graph/src/graph-store.ts:1290` — "of pruning the file')."
- `packages/coding-graph/src/graph-store.ts:1299` — "Span check: a malformed parser or JSON caller can emit"
- `packages/coding-graph/src/graph-store.ts:1300` — "startByte > endByte (or non-integer / negative spans); the"
- `packages/coding-graph/src/graph-store.ts:1301` — "values are bound directly into span_start/span_end and PR2"
- `packages/coding-graph/src/graph-store.ts:1302` — "snippet/search consumers will trust them as half-open byte"
- `packages/coding-graph/src/graph-store.ts:1303` — "offsets. Reject before insertion so bad IR cannot corrupt"
- `packages/coding-graph/src/graph-store.ts:1304` — "graph metadata (chatgpt-codex-connector P2: 'Reject invalid"
- `packages/coding-graph/src/graph-store.ts:1305` — "symbol spans before storing nodes')."
- `packages/coding-graph/src/graph-store.ts:1309` — "Attribute arrays: `exports` and `routes` are optional, but"
- `packages/coding-graph/src/graph-store.ts:1310` — "when present MUST be arrays. A malformed non-array (e.g. a"
- `packages/coding-graph/src/graph-store.ts:1311` — "JSON caller passing `exports: "publicApi"`) is iterable as"
- `packages/coding-graph/src/graph-store.ts:1312` — "characters whose entries have no `.name`, so the per-flag"
- `packages/coding-graph/src/graph-store.ts:1313` — "rebuild in upsertFileAttributes would compute an empty set"
- `packages/coding-graph/src/graph-store.ts:1314` — "and then WIPE every is_exported / is_route_handler flag for"
- `packages/coding-graph/src/graph-store.ts:1315` — "the file — turning a single bad re-ingest into silent"
- `packages/coding-graph/src/graph-store.ts:1316` — "dead-code misclassification. Reject at the boundary like the"
- `packages/coding-graph/src/graph-store.ts:1317` — "symbols check above (chatgpt-codex-connector P2: 'Validate"
- `packages/coding-graph/src/graph-store.ts:1318` — "attribute arrays before clearing flags')."
- `packages/coding-graph/src/graph-store.ts:1327` — "Each entry must carry a non-empty string `name`; a malformed"
- `packages/coding-graph/src/graph-store.ts:1328` — "entry (e.g. `{ name: 42 }`) is silently skipped by the"
- `packages/coding-graph/src/graph-store.ts:1329` — "per-flag rebuild, so it contributes nothing while the wipe"
- `packages/coding-graph/src/graph-store.ts:1330` — "still clears every is_exported flag. Reject the whole batch"
- `packages/coding-graph/src/graph-store.ts:1331` — "like the symbols check (chatgpt-codex-connector P2: 'Reject"
- `packages/coding-graph/src/graph-store.ts:1332` — "malformed attribute entries before clearing flags')."
- `packages/coding-graph/src/graph-store.ts:1860` — "Reject malformed edges up-front (rule 51: surface what is wrong)."
- `packages/coding-graph/src/graph-store.ts:2162` — "Guard the query object before any dereference: a null/undefined"
- `packages/coding-graph/src/graph-store.ts:2163` — "payload (e.g. malformed JSON forwarded at an MCP boundary) would"
- `packages/coding-graph/src/graph-store.ts:2164` — "throw on `query.maxDepth` below instead of returning the tagged"
- `packages/coding-graph/src/graph-store.ts:2165` — "invalid_query the read contract advertises"
- `packages/coding-graph/src/graph-store.ts:2166` — "(chatgpt-codex-connector P2: 'Validate read query objects before"
- `packages/coding-graph/src/graph-store.ts:2167` — "dereferencing')."
- `packages/coding-graph/src/graph-store.ts:2171` — "Validate maxDepth up-front (rule 51: surface what's wrong)."
- `packages/coding-graph/src/graph-store.ts:2182` — "Validate direction against the allowed set (rule 51 +"
- `packages/coding-graph/src/graph-store.ts:2183` — "chatgpt-codex-connector P2: 'Reject invalid traversal directions"
- `packages/coding-graph/src/graph-store.ts:2184` — "explicitly'). Default ONLY on `undefined` — a `null` from a"
- `packages/coding-graph/src/graph-store.ts:2185` — "JSON/tool caller is a malformed value, not an absent one, so the"
- `packages/coding-graph/src/graph-store.ts:2186` — "`??` operator (which treats null as nullish) would silently turn"
- `packages/coding-graph/src/graph-store.ts:2187` — "it into "outgoing" and mask the bad input. Reject null explicitly"
- `packages/coding-graph/src/graph-store.ts:2188` — "(chatgpt-codex-connector P2: 'Reject null traversal directions')."
- `packages/coding-graph/src/graph-store.ts:2198` — "Validate edgeTypes, if present, is an array of strings (rule 51 +"
- `packages/coding-graph/src/graph-store.ts:2199` — "chatgpt-codex-connector P2: 'Validate edgeTypes before building"
- `packages/coding-graph/src/graph-store.ts:2200` — "traversal SQL'). A malformed value like a bare string "CALLS""
- `packages/coding-graph/src/graph-store.ts:2201` — "would otherwise throw at .map() instead of returning the"
- `packages/coding-graph/src/graph-store.ts:2202` — "tagged invalid_query failure the contract advertises."
- `packages/coding-graph/src/graph-store.ts:2210` — "Validate `start` is a non-empty string before it reaches the"
- `packages/coding-graph/src/graph-store.ts:2211` — "SQLite bind (rule 51 + chatgpt-codex-connector P2: 'Validate"
- `packages/coding-graph/src/graph-store.ts:2212` — "traverse start before binding it'). A JS/JSON caller passing an"
- `packages/coding-graph/src/graph-store.ts:2213` — "object/array survives the regex `.test()` coercion but then"
- `packages/coding-graph/src/graph-store.ts:2214` — "throws a non-SQLite TypeError at bind time; surface that as the"
- `packages/coding-graph/src/graph-store.ts:2215` — "precise `invalid_query` rather than letting it fall through to"
- `packages/coding-graph/src/graph-store.ts:2216` — "the generic db_error catch-all."
- `packages/coding-graph/src/graph-store.ts:2398` — "Guard the query object before any dereference (mirrors traverse)."
- `packages/coding-graph/src/graph-store.ts:2434` — "minHops: validate only when explicitly provided; default 1. MUST be a"
- `packages/coding-graph/src/graph-store.ts:2435` — "positive integer -- the primitive never emits length-0 paths."
- `packages/coding-graph/src/graph-store.ts:2444` — "maxPaths: reject a malformed EXPLICIT value rather than silently"
- `packages/coding-graph/src/graph-store.ts:2445` — "defaulting (rule 51 -- surface what's wrong). Only `undefined` defaults"
- `packages/coding-graph/src/graph-store.ts:2446` — "(chatgpt-codex-connector P2: 'Reject malformed maxPaths instead of"
- `packages/coding-graph/src/graph-store.ts:2447` — "defaulting')."
- `packages/coding-graph/src/graph-store.ts:2641` — "Guard the query object before any dereference (see traverse)."
- `packages/coding-graph/src/graph-store.ts:2645` — "Validate numeric inputs (rule 51). NaN / negative / non-integer"
- `packages/coding-graph/src/graph-store.ts:2646` — "limits are rejected, not silently clamped, so callers learn what"
- `packages/coding-graph/src/graph-store.ts:2647` — "they passed."
- `packages/coding-graph/src/graph-store.ts:2675` — "Clamp to [0, MAX_SEARCH_LIMIT]. A `limit: 0` returns an empty"
- `packages/coding-graph/src/graph-store.ts:2676` — "hits array (rule 27 — guard the slice/LIMIT against zero)."
- `packages/coding-graph/src/graph-store.ts:2680` — "Validate string filters are strings when present (rule 51 +"
- `packages/coding-graph/src/graph-store.ts:2681` — "chatgpt-codex-connector P2: 'Reject non-string search patterns"
- `packages/coding-graph/src/graph-store.ts:2682` — "instead of dropping filters'). A non-string like namePattern: 42"
- `packages/coding-graph/src/graph-store.ts:2683` — "has undefined .length, so the guard below would silently drop"
- `packages/coding-graph/src/graph-store.ts:2684` — "the filter and return unrelated nodes. Reject up-front instead."
- `packages/coding-graph/src/graph-store.ts:3057` — "Validate contextLines is a non-negative integer when present,"
- `packages/coding-graph/src/graph-store.ts:3058` — "consistent with traverse's maxDepth and the other numeric read"
- `packages/coding-graph/src/graph-store.ts:3059` — "fields. The old path coerced (Math.floor), so `1.9` silently"
- `packages/coding-graph/src/graph-store.ts:3060` — "became 1 and `"2"` became 2 — reject malformed values up-front"
- `packages/coding-graph/src/graph-store.ts:3061` — "instead (chatgpt-codex-connector P2: 'Reject invalid context"
- `packages/coding-graph/src/graph-store.ts:3062` — "line counts')."
- `packages/coding-graph/src/graph-store.ts:3143` — "Optional context lines (line-aligned expansion). contextLines"
- `packages/coding-graph/src/graph-store.ts:3144` — "is bounded to a sane cap so a caller cannot ask for megabytes"
- `packages/coding-graph/src/graph-store.ts:3145` — "of surrounding code."
- `packages/coding-graph/src/graph-store.ts:3796` — "`.` / `..` segments alias a canonical path (`./src/a.ts` vs"
- `packages/coding-graph/src/graph-store.ts:3797` — "`src/a.ts`, or `src/../a.ts`) and would hash to a distinct files"
- `packages/coding-graph/src/graph-store.ts:3798` — "row + node id, leaving duplicates the canonical ingest cannot"
- `packages/coding-graph/src/graph-store.ts:3799` — "match or prune. Segment-based check avoids false positives on"
- `packages/coding-graph/src/graph-store.ts:3800` — "names like `a..b.ts`."
