# LSP-derived call edges are reconciled only from exhaustive, atomic per-file batches

Status: accepted

## Context
The LSP resolution pass upgrades heuristic CALLS edges with language-server-grounded
definitions. Reconciliation — deleting lsp edges the server no longer asserts — is only
safe if the server actually answered for every call site: a timeout or server crash
mid-batch would otherwise make the asserted set incomplete and retire valid edges for
call sites that were never asked. tsserver adds a second trap: before project load it
answers definition requests with `[]` instead of an error, so a naive "empty means gone"
policy deletes real edges on first run. And because resolution ultimately writes graph
edges keyed by qualified name, a server answer pointing at a name shared across files can
bind an edge to the wrong node.

## Decision
LSP batches are all-or-nothing, exhaustiveness-gated, and name-conservative:

- Definition requests are grouped per file and sent as one batch. The batch is marked
  exhaustive only when EVERY request reached a definitive result (resolved or
  definitively-not-found). A timeout, request error, or server crash makes the batch
  non-exhaustive: reconciliation for that file is suppressed and collected upgrades are
  NOT committed — a partial batch's asserted set would retire valid edges for unprocessed
  call sites.
- Each file batch applies in its own transaction (per-batch atomicity): a failed apply
  degrades the run without crashing, loses only that batch's upgrades (counted as
  unresolved for honest reporting), and leaves earlier batches' committed edges intact.
- "Server problem" (stop the whole pass) is distinguished from "this definition returned
  nothing" (continue per site).
- Warm-up retry (once): an empty definition result before the server has proven warm is
  retried a single time; the retry's answer is final. Warmth is proven by the first
  non-empty definition or by paying the retry — without this, every first-run resolution
  silently deletes lsp edges.
- The node-locator is an injected seam (the caller's store-backed executor implements it)
  so the planner stays pure and testable without a database. Resolution picks the
  INNERMOST containing span (nested containment is normal); a tie at the smallest size
  returns null — the offset cannot be attributed to exactly one node, and a wrong winner
  would persist incorrect CALLS edges.
- Name-based upgrades stay conservative: the span lookup is scoped to the caller file (two
  files defining the same top-level qualified name must not leak each other's
  resolutions), and when the resolved qualified name is ambiguous across files the
  upgrade is skipped rather than written against a possibly-wrong node. When a
  deterministic node id is supplied it is preferred, since it never hits the ambiguity
  path.
- Supporting discipline: line-offset maps are computed once per unique file; cross-file
  lookups without a resolver fall back to a best-effort byte offset in caller content
  (tolerated by half-open containment); the package carries only the minimal local LSP
  protocol type subset it needs; and the test suite drives a checked-in fake JSON-RPC
  server rather than a real language server.

## Consequences
LSP edges can only improve the graph, never silently shrink it: a degraded server
costs a skipped reconciliation, not deleted edges, and per-file isolation bounds blast
radius to one batch. The costs: a single ambiguous name blocks its upgrade until id-carrying
upgrades land, the warm-up retry adds one round-trip on cold servers, and
non-exhaustiveness discards already-collected upgrades for that file (reported, not
hidden).

Theme coverage: Records under the LSP resolution, warm-up, reconciliation, locator, and cross-file-offset topics.

## Origin comments
- `packages/coding-graph/src/graph-store.ts:2921` — "Fetch the two smallest containing spans: nested containment is"
- `packages/coding-graph/src/graph-store.ts:2922` — "normal (a method inside a class both contain the offset) and the"
- `packages/coding-graph/src/graph-store.ts:2923` — "INNERMOST (smallest) wins — but a TIE at the smallest size means"
- `packages/coding-graph/src/graph-store.ts:2924` — "the offset cannot be attributed to exactly one node, and the"
- `packages/coding-graph/src/graph-store.ts:2925` — "NodeLocator contract requires null over an arbitrary pick"
- `packages/coding-graph/src/graph-store.ts:2926` — "(review thread: a wrong winner persists incorrect CALLS edges)."
- `packages/coding-graph/src/graph-store.ts:2942` — "The span lookup disambiguated by file, but the returned QUALIFIED"
- `packages/coding-graph/src/graph-store.ts:2943` — "NAME is the edge key downstream (upsertEdges resolves names, not"
- `packages/coding-graph/src/graph-store.ts:2944` — "ids). If another file defines the same qualified name (common for"
- `packages/coding-graph/src/graph-store.ts:2945` — "top-level `main`/`handler`/`init`), an edge written against the"
- `packages/coding-graph/src/graph-store.ts:2946` — "name could bind to the wrong node — return null and skip the"
- `packages/coding-graph/src/graph-store.ts:2947` — "upgrade instead (conservative; id-carrying upgrades are the"
- `packages/coding-graph/src/graph-store.ts:2948` — "follow-up, review thread on #1923)."
- `packages/coding-graph/src/graph-store.ts:2972` — "Scoped to the caller FILE when provided: two files defining the"
- `packages/coding-graph/src/graph-store.ts:2973` — "same top-level qualified name (main/handler/init) must not leak"
- `packages/coding-graph/src/graph-store.ts:2974` — "each other's resolutions (#1923 review thread)."
- `packages/coding-graph/src/lsp/resolution.test.ts:298` — "// Warm-up retry (issue #1933) is exercised by its own tests below;"
- `packages/coding-graph/src/lsp/resolution.test.ts:299` — "// this test asserts the definitive-empty path."
- `packages/coding-graph/src/lsp/resolution.test.ts:308` — "// Warm-up retry (issue #1933): tsserver answers pre-project-load definition"
- `packages/coding-graph/src/lsp/resolution.test.ts:309` — "// requests with [] instead of an error. An empty result before the server"
- `packages/coding-graph/src/lsp/resolution.test.ts:310` — "// has proven warm is retried once; the retry's answer is final."
- `packages/coding-graph/src/lsp/resolution.test.ts:614` — "// This test asserts URI shapes, not warm-up behavior (issue #1933)."
- `packages/coding-graph/src/lsp/resolution.ts:117` — "// Node-location lookup — the seam between LSP locations and graph nodes."
- `packages/coding-graph/src/lsp/resolution.ts:118` — "// Implemented by the caller (the store-backed resolution executor) so"
- `packages/coding-graph/src/lsp/resolution.ts:119` — "// the planner stays pure and testable without a database."
- `packages/coding-graph/src/lsp/resolution.ts:179` — "// Pre-compute line-offset maps per unique file to avoid recomputation"
- `packages/coding-graph/src/lsp/resolution.ts:294` — "// Group requests by file for batched transactional application."
- `packages/coding-graph/src/lsp/resolution.ts:309` — "// Warm-up tracking (issue #1933): false until the server returns its"
- `packages/coding-graph/src/lsp/resolution.ts:310` — "// first NON-EMPTY definition, or until one warm-up retry has been paid."
- `packages/coding-graph/src/lsp/resolution.ts:311` — "// tsserver answers pre-project-load requests with [] instead of an"
- `packages/coding-graph/src/lsp/resolution.ts:312` — "// error, so without the retry every first-run resolution silently"
- `packages/coding-graph/src/lsp/resolution.ts:318` — "// Send all definition requests for this file, collecting upgrades."
- `packages/coding-graph/src/lsp/resolution.ts:321` — "// Track whether EVERY request in this file batch was processed to a"
- `packages/coding-graph/src/lsp/resolution.ts:322` — "// definitive result (resolved or definitively-not-found). A timeout,"
- `packages/coding-graph/src/lsp/resolution.ts:323` — "// request_error, or server-crash mid-batch makes the batch"
- `packages/coding-graph/src/lsp/resolution.ts:324` — "// non-exhaustive: reconciliation must NOT run because the asserted"
- `packages/coding-graph/src/lsp/resolution.ts:325` — "// set would be incomplete, deleting valid lsp edges for call sites"
- `packages/coding-graph/src/lsp/resolution.ts:370` — "// Distinguish "server problem" (stop the whole pass) from"
- `packages/coding-graph/src/lsp/resolution.ts:371` — "// "this particular definition returned nothing" (continue)."
- `packages/coding-graph/src/lsp/resolution.ts:380` — "// Mark the batch failed so collected upgrades are NOT committed"
- `packages/coding-graph/src/lsp/resolution.ts:381` — "// (rule 25 — per-batch atomicity; a degraded batch must not"
- `packages/coding-graph/src/lsp/resolution.ts:382` — "// persist partial LSP edges)."
- `packages/coding-graph/src/lsp/resolution.ts:388` — "// The batch is non-exhaustive: this call site's LSP result is"
- `packages/coding-graph/src/lsp/resolution.ts:389` — "// indeterminate, so reconciliation for this file is suppressed."
- `packages/coding-graph/src/lsp/resolution.ts:419` — "// The batch was poisoned — collected upgrades must NOT be committed."
- `packages/coding-graph/src/lsp/resolution.ts:420` — "// Count them as unresolved for reporting accuracy."
- `packages/coding-graph/src/lsp/resolution.ts:434` — "// Reconcile ONLY when the batch was exhaustive (every call site"
- `packages/coding-graph/src/lsp/resolution.ts:435` — "// processed to a definitive result). A partial batch's asserted"
- `packages/coding-graph/src/lsp/resolution.ts:436` — "// set would be incomplete and retire valid edges for unprocessed"
- `packages/coding-graph/src/lsp/resolution.ts:437` — "// call sites (cursor High + codex P1 on #1914)."
- `packages/coding-graph/src/lsp/resolution.ts:449` — "// The apply failed — degrade but don't crash. Upgrades from this"
- `packages/coding-graph/src/lsp/resolution.ts:450` — "// batch are lost (the callback's transaction rolled back). Edges"
- `packages/coding-graph/src/lsp/resolution.ts:451` — "// from already-applied batches survive (they were in separate"
- `packages/coding-graph/src/lsp/resolution.ts:452` — "// transactions — this is the documented per-batch isolation)."
- `packages/coding-graph/src/lsp/resolution.ts:453` — "// Count the lost upgrades as unresolved for reporting."
- `packages/coding-graph/src/lsp/resolution.ts:504` — "// Cross-file without a resolver — best-effort fallback to caller"
- `packages/coding-graph/src/lsp/resolution.ts:505` — "// content. The byte offset may be imprecise for files with different"
- `packages/coding-graph/src/lsp/resolution.ts:506` — "// line lengths or Unicode, but the half-open containment check"
- `packages/coding-graph/src/lsp/resolution.ts:507` — "// tolerates small offsets."
- `packages/coding-graph/src/lsp/types.ts:1` — "Minimal LSP protocol types — only the subset the resolution pass needs... local subset avoids pulling in vscode-langua…"
