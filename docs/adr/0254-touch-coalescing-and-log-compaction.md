# Repeat timestamp touches are coalesced per window and the log is auto-compacted with hysteresis

Status: accepted

Append-only JSONL grows one line per touch; hot recall/extraction would
rewrite the file constantly and starve consumers (writtenSince, maintenance)
with I/O.

## Decision

- Pure-timestamp touches on an already-known record buffer into a
  per-(namespace, kind) coalescing buffer and flush once per fixed window;
  the newest buffered timestamp wins on flush. The timer is NOT re-armed on
  each touch (that would debounce forever under sustained traffic); windows
  above Node's max setTimeout delay are clamped deliberately.
- Semantically observable touches bypass the buffer and flush immediately:
  first sight, provenance change (including the config->write upgrade),
  first-set touch field (presence/writtenSince becomes true), and a changed
  storageDir. An older buffered touch for the same key is dropped when a
  newer flush supersedes it.
- `CompactBytes=0` disables rewriting; `CoalesceMs=0` appends one line per
  touch (pre-#1903 behavior). `0` is a real disable switch preserved by
  nullish coalescing; missing knobs in an externally built config fall back
  to documented production defaults.
- Size-triggered auto-compaction folds the log to one row per namespace
  (keeping every namespace and its newest fields) when it exceeds the byte
  limit, inside the held lock + critical section. Hysteresis: after a
  compaction, compact again only once the log has grown by at least one
  limit-worth, so a folded catalog above the limit is not re-folded on
  every touch.
- Cross-process cache coherence: compaction on one instance never drops
  another instance's rows; a cold cache skips the size check until
  re-warmed.

## Consequences

Under continuous traffic lastWriteAt can lag up to one coalesce window (but
observable changes are immediate). Compaction rewrites the whole file at
most once per growth-limit-worth of appends.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog.test.ts:3734` — "// ── Issue #1903: touch-path performance (auto-compaction, coalescing, streaming) ──"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3741` — "// 1. Warm cache: with coalescing OFF every touch appends, but a warm cache means"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3742` — "// none of them re-parses the JSONL after the initial warm-up parse."
- `packages/remnic-core/src/namespaces/catalog.test.ts:3772` — "// 2. Write-touch coalescing collapses many in-window writes into a single append,"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3773` — "// and the newest buffered timestamp wins on flush."
- `packages/remnic-core/src/namespaces/catalog.test.ts:3813` — "// 3. Read-touch coalescing collapses in-window reads and keeps the latest freshness."
- `packages/remnic-core/src/namespaces/catalog.test.ts:3847` — "// 4. Provenance upgrade under coalescing: a config pre-registration followed by a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3848` — "// write must read back "write" WITHOUT an explicit flush (immediate-flush rule)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:3878` — "// 5. Zero-limit semantics: CompactBytes=0 never rewrites and CoalesceMs=0 appends"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3879` — "// one line per touch (line count == touch count) — the pre-#1903 behavior."
- `packages/remnic-core/src/namespaces/catalog.test.ts:3904` — "// 6. Auto-compaction bounds the log to one row per namespace and preserves every"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3905` — "// namespace with its newest fields. A tiny limit forces compaction on each touch."
- `packages/remnic-core/src/namespaces/catalog.test.ts:3951` — "// 7. Cross-process cache-coherence: compaction on one instance must never drop"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3952` — "// another instance's rows (mirrors the rebuild-race tests). A third fresh"
- `packages/remnic-core/src/namespaces/catalog.test.ts:3953` — "// instance must read back every namespace touched by either."
- `packages/remnic-core/src/namespaces/catalog.ts:510` — "// Issue #1903 — touch-path performance knobs, resolved with the documented"
- `packages/remnic-core/src/namespaces/catalog.ts:511` — "// defaults when an externally-built PluginConfig omits them (so a partial"
- `packages/remnic-core/src/namespaces/catalog.ts:512` — "// config object still yields the production behavior). `0` is a real disable"
- `packages/remnic-core/src/namespaces/catalog.ts:513` — "// switch for each and is preserved by `??` (0 is not null/undefined)."
- `packages/remnic-core/src/namespaces/catalog.ts:525` — "// Size after the most recent auto-compaction (0 = none yet). Hysteresis for"
- `packages/remnic-core/src/namespaces/catalog.ts:526` — "// maybeAutoCompact: a folded catalog that is itself above the limit (many"
- `packages/remnic-core/src/namespaces/catalog.ts:527` — "// distinct namespaces) would otherwise be re-folded + re-rewritten on every"
- `packages/remnic-core/src/namespaces/catalog.ts:528` — "// touch. We only compact again once the log has grown by >= one limit-worth"
- `packages/remnic-core/src/namespaces/catalog.ts:529` — "// since the last compaction (#1903, Codex)."
- `packages/remnic-core/src/namespaces/catalog.ts:532` — "// Issue #1903 — per-(namespace, kind) coalescing buffer. Keyed `${kind}:${ns}`."
- `packages/remnic-core/src/namespaces/catalog.ts:533` — "// Holds the latest buffered timestamp/metadata for a pure-timestamp touch on"
- `packages/remnic-core/src/namespaces/catalog.ts:534` — "// an already-known record; a `.unref()`'d timer flushes it once per window so"
- `packages/remnic-core/src/namespaces/catalog.ts:535` — "// the append-only log does not grow one line per repeat touch. Semantically"
- `packages/remnic-core/src/namespaces/catalog.ts:536` — "// observable touches (first sight, provenance/field change) bypass this buffer"
- `packages/remnic-core/src/namespaces/catalog.ts:537` — "// and flush immediately (see `coalesceTouch`)."
- `packages/remnic-core/src/namespaces/catalog.ts:648` — "/** * Route a read/write touch through the per-(namespace, kind) coalescing buffer * (issue #1903). A touch flushes I"
- `packages/remnic-core/src/namespaces/catalog.ts:673` — "// Validate up front so an unsafe namespace rejects deterministically, exactly"
- `packages/remnic-core/src/namespaces/catalog.ts:674` — "// as the immediate-append path does (touch validates too)."
- `packages/remnic-core/src/namespaces/catalog.ts:678` — "// Semantically observable in-process → flush now (also warms the cache)."
- `packages/remnic-core/src/namespaces/catalog.ts:679` — "// Any older buffered touch for this key is now redundant (this newer touch"
- `packages/remnic-core/src/namespaces/catalog.ts:680` — "// updates the same field with a newer timestamp): drop it so its stale"
- `packages/remnic-core/src/namespaces/catalog.ts:681` — "// timer cannot regress the timestamp after this flush."
- `packages/remnic-core/src/namespaces/catalog.ts:695` — "// Keep the ORIGINAL timer and only refresh the buffered payload (#1903,"
- `packages/remnic-core/src/namespaces/catalog.ts:696` — "// Codex). Re-arming on every touch would make this a debounce that never"
- `packages/remnic-core/src/namespaces/catalog.ts:697` — "// flushes under continuous traffic (e.g. a sustained import), leaving"
- `packages/remnic-core/src/namespaces/catalog.ts:698` — "// lastWriteAt stale and writtenSince/maintenance consumers blind to an"
- `packages/remnic-core/src/namespaces/catalog.ts:699` — "// actively-written namespace. With a fixed window, each window flushes on"
- `packages/remnic-core/src/namespaces/catalog.ts:700` — "// schedule carrying the newest buffered timestamp."
- `packages/remnic-core/src/namespaces/catalog.ts:705` — "// Cap at Node's maximum setTimeout delay (2^31-1 ms ≈ 24.8 days). Values"
- `packages/remnic-core/src/namespaces/catalog.ts:706` — "// above that are clamped by Node to 1ms, which would append almost every"
- `packages/remnic-core/src/namespaces/catalog.ts:707` — "// touch and recreate the churn this coalescing exists to prevent (#1903, Codex)."
- `packages/remnic-core/src/namespaces/catalog.ts:726` — "// A write upgrading a config pre-registration to "write" changes the"
- `packages/remnic-core/src/namespaces/catalog.ts:727` — "// discoveredBy filter result — must be observable at once (~:1261)."
- `packages/remnic-core/src/namespaces/catalog.ts:729` — "// The first time a touch field is set makes the namespace newly match"
- `packages/remnic-core/src/namespaces/catalog.ts:730` — "// presence/`writtenSince` reads, so it must not be deferred."
- `packages/remnic-core/src/namespaces/catalog.ts:735` — "// A changed storageDir repoints routing/containment for this namespace —"
- `packages/remnic-core/src/namespaces/catalog.ts:736` — "// must be observable at once, not held stale by the coalesce window (#1903, Cursor)."
- `packages/remnic-core/src/namespaces/catalog.ts:1362` — "// Size-triggered auto-compaction (issue #1903), still inside the held"
- `packages/remnic-core/src/namespaces/catalog.ts:1363` — "// cross-process lock + queueCritical turn so the fold→rename is atomic"
- `packages/remnic-core/src/namespaces/catalog.ts:1364` — "// against concurrent touches and cross-process rebuilds."
- `packages/remnic-core/src/namespaces/catalog.ts:1426` — "// Exact post-append size when the cache is warm; skip this touch's check"
- `packages/remnic-core/src/namespaces/catalog.ts:1427` — "// when the cache is cold (a cross-process append invalidated it) — the"
- `packages/remnic-core/src/namespaces/catalog.ts:1428` — "// next touch re-warms and re-checks."
- `packages/remnic-core/src/namespaces/catalog.ts:1431` — "// Hysteresis (issue #1903, Codex): a folded catalog whose deduped state is"
- `packages/remnic-core/src/namespaces/catalog.ts:1432` — "// itself above the limit (many distinct namespaces) would otherwise be"
- `packages/remnic-core/src/namespaces/catalog.ts:1433` — "// re-folded + re-rewritten on EVERY touch — O(catalog) per touch. Only"
- `packages/remnic-core/src/namespaces/catalog.ts:1434` — "// compact again once the log has grown by >= one limit-worth since the last"
- `packages/remnic-core/src/namespaces/catalog.ts:1435` — "// compaction; by then the new appends are duplicates the fold can collapse."
