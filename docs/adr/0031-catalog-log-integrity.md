# Namespace catalog log integrity

Status: accepted

## Context

The namespace catalog (`namespaces.jsonl`) is a rebuildable, best-effort append log derived from the authoritative disk scan. Forces: multiple processes (daemon, gateway, CLI) append and rebuild concurrently; the log can reach 100+ MB; lines can be corrupt; a rebuild races concurrent writes; and a purged namespace record could silently resurrect after being deleted. The catalog must be recoverable at all times without ever resurrecting tombstoned records or clobbering a concurrent writer.

## Decision

Read the catalog with a streaming, chunked parser that yields to the event loop (StringDecoder for UTF-8 chunk seams); skip corrupt lines but count them so callers can detect an incomplete read; treat only a never-written catalog as normal and any other open failure as a hidden whole-catalog failure, surfacing `cache.incomplete` solely from the malformed-repair branch so deriving `malformed` cannot misfire for an unreadable catalog. Rebuilds fold newer cross-process touch fields onto surviving namespace records from the authoritative disk scan, never resurrect purged records, and only rewrite the log when the cross-process advisory lock is actually held; dry-runs and lock-less compute-only runs return computed records without renaming over the log and report `applied=false` so the CLI never reports success on a skipped rewrite. All read-modify-write mutations serialize through a single per-instance chain; direct appends bypassing re-serialization are reserved for already-serialized callers; rewrites use temp-file + rename (never delete-before-write) with temp cleanup on failure while the original error still surfaces. Provenance metadata (timestamps, principal hints) merges onto freshly discovered records at creation/merge only. Test-only seams exist inside the load-rename and stale-lock windows for concurrency tests.

## Consequences

Large catalogs no longer block the event loop; a crashed or lock-timed-out rebuild can never corrupt or overwrite a live log; the CLI cannot report success on a skipped rewrite. Cost: rebuild accuracy depends on holding the lock, so lock timeouts mean compute-only results; best-effort metadata means individual corrupt lines are tolerated but must be counted.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog.ts:1971` — "// is acceptable (the catalog is rebuildable best-effort metadata);"
- `packages/remnic-core/src/namespaces/catalog.ts:1972` — "// resurrecting a purged record is not. Drop it."
- `packages/remnic-core/src/namespaces/catalog.ts:1975` — "// SURVIVING namespace (still present in the authoritative disk scan):"
- `packages/remnic-core/src/namespaces/catalog.ts:1976` — "// fold in any newer touch fields that landed cross-process after our"
- `packages/remnic-core/src/namespaces/catalog.ts:1977` — "// initial snapshot so a concurrent gateway markWrite is not lost."
- `packages/remnic-core/src/namespaces/catalog.ts:1988` — "// Only rewrite when we actually hold the cross-process lock (round 6, codex"
- `packages/remnic-core/src/namespaces/catalog.ts:1989` — "// P2 — NBPmY). A dry-run never mutates; an unlocked rebuild (acquisition"
- `packages/remnic-core/src/namespaces/catalog.ts:1990` — "// timed out) returns the computed records WITHOUT renaming over the log, so"
- `packages/remnic-core/src/namespaces/catalog.ts:1991` — "// it can never clobber a concurrent lock holder's window."
- `packages/remnic-core/src/namespaces/catalog.ts:1993` — "// Test-only seam: the load→rename window where the old check-then-append"
- `packages/remnic-core/src/namespaces/catalog.ts:1994` — "// touch could be clobbered. A concurrency test attempts a cross-instance"
- `packages/remnic-core/src/namespaces/catalog.ts:1995` — "// touch here and asserts the held lock blocks it (no-op in production)."
- `packages/remnic-core/src/namespaces/catalog.ts:2002` — "// `applied` is true only when we actually rewrote the log: never for a"
- `packages/remnic-core/src/namespaces/catalog.ts:2003` — "// dry-run, and never for an `--apply` that ran compute-only because it could"
- `packages/remnic-core/src/namespaces/catalog.ts:2004` — "// not acquire the lock (canMutate=false). Surfaces the real mutation state so"
- `packages/remnic-core/src/namespaces/catalog.ts:2005` — "// the CLI does not report success on a skipped rewrite (NBn3n/NBsGG)."
- `packages/remnic-core/src/namespaces/catalog.ts:2011` — "/** * Run `fn` while HOLDING the shared cross-process advisory lock (round 5, codex * P2; generalized round 7 — NEZkA"
- `packages/remnic-core/src/namespaces/catalog.ts:2052` — "// NG7Bg seam: fires inside the util's breakStaleLock after it judges the"
- `packages/remnic-core/src/namespaces/catalog.ts:2053` — "// lock stale and captures its identity, before the atomic rename+verify."
- `packages/remnic-core/src/namespaces/catalog.ts:2060` — "/** * Merge a prior record's preserved metadata (timestamps, principal hints) * onto a freshly-discovered record. Dis"
- `packages/remnic-core/src/namespaces/catalog.ts:2097` — "// A catalog that was never written is normal; any other open failure hid the whole catalog."
- `packages/remnic-core/src/namespaces/catalog.ts:2122` — "// Invariant: cache.incomplete is set ONLY by the malformed branch below, so"
- `packages/remnic-core/src/namespaces/catalog.ts:2123` — "// deriving `malformed` here cannot misfire for an unreadable catalog."
- `packages/remnic-core/src/namespaces/catalog.ts:2136` — "// Streaming chunked parse (issue #1903): the log can reach 100+ MB in"
- `packages/remnic-core/src/namespaces/catalog.ts:2137` — "// production, so read it in bounded chunks and yield to the event loop"
- `packages/remnic-core/src/namespaces/catalog.ts:2138` — "// every ~5000 lines instead of buffering the whole file and blocking on a"
- `packages/remnic-core/src/namespaces/catalog.ts:2139` — "// single giant `split("\n")`. The fold is unchanged (last-record-wins with"
- `packages/remnic-core/src/namespaces/catalog.ts:2140` — "// field-level touch merge across cross-process full-snapshot appends)."
- `packages/remnic-core/src/namespaces/catalog.ts:2144` — "// StringDecoder buffers partial multi-byte UTF-8 sequences that straddle a"
- `packages/remnic-core/src/namespaces/catalog.ts:2145` — "// chunk boundary, so a namespace/principal with non-ASCII bytes never"
- `packages/remnic-core/src/namespaces/catalog.ts:2146` — "// corrupts at the seam."
- `packages/remnic-core/src/namespaces/catalog.ts:2157` — "// Skip corrupt lines (CLAUDE.md rule #18 robustness), but count them so a caller that"
- `packages/remnic-core/src/namespaces/catalog.ts:2158` — "// needs the whole catalog can tell the read was incomplete (issue #3293)."
- `packages/remnic-core/src/namespaces/catalog.ts:2222` — "/** * Serialize an arbitrary read-modify-write critical section through the single * per-instance chain. Every catalo"
- `packages/remnic-core/src/namespaces/catalog.ts:2238` — "/** * Append a single record to the JSONL log WITHOUT re-serializing through the * write chain. MUST only be called f"
- `packages/remnic-core/src/namespaces/catalog.ts:2255` — "/** * Atomic temp-file + rename rewrite (CLAUDE.md rule #54: write temp, then * rename — never delete-before-write) W"
- `packages/remnic-core/src/namespaces/catalog.ts:2271` — "// A failed write or rename (for example the catalog path is a directory) must not leave"
- `packages/remnic-core/src/namespaces/catalog.ts:2272` — "// the temp file behind; the original error still surfaces to the caller."
