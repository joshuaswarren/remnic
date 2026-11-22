# Activity sync degrades gracefully: durable data first, failures reported, aborts honored, teardown latched

Status: accepted

## Context
Activity sync spans sources, daemons, digest writes, QMD reindex, and dependent builders. Forces: two sources syncing the same day can lose-update each other's digest; a stalled daemon can hang the sync; opaque backend errors can embed paths/hostnames; a judge or provider failure must not abort a day's writes; re-arming registration can orphan a running interval; and at-rest encryption must not be silently bypassed by cleartext digests.

## Decision
- Digest section composition per (memoryDir, date) is serialized by a lock so the last writer in the chain lists every row present and wins.
- Durability comes first: rows persist keyed by their own timestamp (out-of-window or malformed-timestamp snapshots are retained under their own day, or rejected loudly if impossible); after rows/digest/cursor are durable, the search index refreshes best-effort (failure reported, not thrown). Only a loop that exhausts its page budget without a terminal cursor is a runaway.
- An abort is re-checked before the durable write section (no digest/cursor advance once aborted), before any later source builds a client, and races the guard/start window at registration; a one-off bad day is recorded and skipped, never starving remaining dates.
- Errors are sanitized: controlled `HTTP <status>` messages surface verbatim; anything else reduces to a name+code, never raw backend/network error text.
- Judge, extraction, or provider failures degrade: structured zero-results, confidence-only trust scoring without the judge boost, and per-failure salvage that drops bad fields instead of aborting the pass.
- Scheduler: never keeps the host alive solely for cadence; latched-stop and overlap guards prevent invoking after stop() or during a prior slow sync; completion is signaled only after invoke() fully resolves.
- Registration: stop any prior scheduler before re-arming; the teardown latch stays set once disposed; reindex after a digest write is strict (bypasses the throttle, throws on failure) while retries route through the durable throttled QMD path — never after teardown; the meeting-builder tail step fires only after durable ingestion and never after teardown; encryption-at-rest refuses to run.
- Source clients bound every request with a timeout, honor caller abort signals, tolerate a missing/undefined nextCursor as end-of-pagination (only a present non-string is invalid), and accept no-text/untitled windows rather than erroring the day. Manual one-shot syncs flush the debounced meeting tail-step timer before returning; the daemon keeps coalescing.

## Consequences
Partial failures surface as structured per-day/per-source results rather than exceptions; operators must read per-day error records to find broken backfill days. Data is never lost to a transient downstream outage, at the cost of extra re-check and latch bookkeeping.

## Origin comments

Merged here: scheduler, registration, source-client, and pipeline abort/degradation records form one lifecycle-resilience decision.

- `packages/remnic-core/src/access-wearables-meetings-surface.ts:65` — "// Manual one-shot sync (HTTP/MCP/CLI): the meeting tail-step arms a"
- `packages/remnic-core/src/access-wearables-meetings-surface.ts:66` — "// debounced, unref'd timer a short-lived caller exits before firing. Drain"
- `packages/remnic-core/src/access-wearables-meetings-surface.ts:67` — "// it now so a manual sync's meeting build actually runs before we return."
- `packages/remnic-core/src/access-wearables-meetings-surface.ts:68` — "// The long-lived auto-sync daemon does NOT flush — it keeps coalescing."
- `packages/remnic-core/src/activity/memory-gen.test.ts:218` — "// A judge failure must not abort the day: with no verdict the fact is scored"
- `packages/remnic-core/src/activity/memory-gen.test.ts:219` — "// on confidence x sourceTrust alone (0.95) and still clears autoApproveTrust."
- `packages/remnic-core/src/activity/memory-gen.test.ts:229` — "// An extraction failure must not throw out of the day's pass."
- `packages/remnic-core/src/activity/memory-gen.ts:191` — "// A provider/parse failure must not throw out of the pass; return the"
- `packages/remnic-core/src/activity/memory-gen.ts:192` — "// structured zero-result so the caller can retry on the next digest run."
- `packages/remnic-core/src/activity/memory-gen.ts:199` — "// In-band failure marker (partial/failed provider result): treat like a"
- `packages/remnic-core/src/activity/memory-gen.ts:200` — "// thrown extraction — warn and return the structured zero-result."
- `packages/remnic-core/src/activity/memory-gen.ts:232` — "// Degraded smart mode (wearables parity): a judge failure must not abort the"
- `packages/remnic-core/src/activity/memory-gen.ts:233` — "// day's writes. Fall back to trust scoring alone (no judge accept boost)."
- `packages/remnic-core/src/activity/pipeline.ts:30` — "// Serializes the list -> compose -> write digest section per (memoryDir, date)"
- `packages/remnic-core/src/activity/pipeline.ts:31` — "// so two sources syncing the same day cannot lose-update each other's digest:"
- `packages/remnic-core/src/activity/pipeline.ts:32` — "// the last writer in the chain lists every row present and wins."
- `packages/remnic-core/src/activity/pipeline.ts:171` — "// Only a loop that ran out of its page budget without seeing a terminal"
- `packages/remnic-core/src/activity/pipeline.ts:172` — "// null cursor is a runaway; completing on the final allowed page is normal."
- `packages/remnic-core/src/activity/pipeline.ts:177` — "// Re-check abort before the durable write section: stop() may have fired after"
- `packages/remnic-core/src/activity/pipeline.ts:178` — "// the last page returned, or while this date waited behind digestLocks. An"
- `packages/remnic-core/src/activity/pipeline.ts:179` — "// aborted tick must not compose/write a digest or advance the cursor."
- `packages/remnic-core/src/activity/pipeline.ts:196` — "// Rows and digest are durable and the cursor has advanced; refresh the search"
- `packages/remnic-core/src/activity/pipeline.ts:197` — "// index so the new digest is discoverable (rule 31). Best-effort: a failure"
- `packages/remnic-core/src/activity/pipeline.ts:198` — "// is reported, not thrown — the data indexes on the next update."
- `packages/remnic-core/src/activity/pipeline.ts:204` — "// reindexError is part of the exported ActivitySyncResult. Keep our"
- `packages/remnic-core/src/activity/pipeline.ts:205` — "// controlled QMD strict messages, but reduce opaque backend errors (which"
- `packages/remnic-core/src/activity/pipeline.ts:206` — "// can embed absolute paths / loader stacks) to a sanitized name+code."
- `packages/remnic-core/src/activity/runner.ts:164` — "// Local dates that gained new snapshots this run (any source). Drives the"
- `packages/remnic-core/src/activity/runner.ts:165` — "// meetings rebuild fan-out so a backfilled OLDER day is rebuilt too."
- `packages/remnic-core/src/activity/runner.ts:202` — "// The day's rows/digest/cursor are durable; a failed post-digest"
- `packages/remnic-core/src/activity/runner.ts:203` — "// reindex is a separate, already-sanitized signal (not a sync"
- `packages/remnic-core/src/activity/runner.ts:204` — "// failure) so the scheduler can observe a stale index."
- `packages/remnic-core/src/activity/runner.ts:207` — "// One bad day (a malformed historical snapshot, a per-day daemon"
- `packages/remnic-core/src/activity/runner.ts:208` — "// error) must not starve the remaining dates — record it and move"
- `packages/remnic-core/src/activity/runner.ts:209` — "// on. Dates are processed oldest-first, so continuing keeps today's"
- `packages/remnic-core/src/activity/runner.ts:210` — "// sync alive when an old backfill day is broken. An abort, though,"
- `packages/remnic-core/src/activity/runner.ts:211` — "// halts the whole run."
- `packages/remnic-core/src/activity/runner.ts:221` — "// An abort halts the WHOLE run: the in-flight source above is recorded"
- `packages/remnic-core/src/activity/runner.ts:222` — "// (its fast-failing attempt reports an error), but no later source builds"
- `packages/remnic-core/src/activity/runner.ts:223` — "// a client or contacts a daemon — teardown settles promptly."
- `packages/remnic-core/src/activity/scheduler.test.ts:246` — "// Event-driven completion: the scheduler calls onRun(summary) in its .then,"
- `packages/remnic-core/src/activity/scheduler.test.ts:247` — "// i.e. AFTER invoke() (runActivitySyncOnce) has fully resolved — every fs"
- `packages/remnic-core/src/activity/scheduler.test.ts:248` — "// write and setCursor durable. Awaiting this signal is deterministic; a bare"
- `packages/remnic-core/src/activity/scheduler.test.ts:249` — "// setImmediate flush races the runner's real fs I/O on the libuv threadpool."
- `packages/remnic-core/src/activity/scheduler.test.ts:250` — "// onError rejects the same deferred so a runner failure (SQLite/digest write"
- `packages/remnic-core/src/activity/scheduler.test.ts:251` — "// regression, temp-dir fault) surfaces promptly instead of hanging to timeout."
- `packages/remnic-core/src/activity/scheduler.ts:100` — "// Never keep the host process alive solely for the sync cadence."
- `packages/remnic-core/src/activity/scheduler.ts:139` — "// Latched-stop and overlap guards: a callback that fires after stop(), or"
- `packages/remnic-core/src/activity/scheduler.ts:140` — "// while a prior slow sync is still running, must not invoke."
- `packages/remnic-core/src/activity/source-client.test.ts:136` — "// Reserve an ephemeral loopback port, then close it so the connection is"
- `packages/remnic-core/src/activity/source-client.test.ts:137` — "// deterministically refused (no reliance on a fixed low port being free)."
- `packages/remnic-core/src/activity/source-client.test.ts:183` — "// A legitimate no-text/untitled foreground window must parse, not throw —"
- `packages/remnic-core/src/activity/source-client.test.ts:184` — "// else the runner errors the day and the cursor never advances past it."
- `packages/remnic-core/src/activity/source-client.ts:75` — "// A missing/undefined nextCursor (field omitted, not JSON null) is normal"
- `packages/remnic-core/src/activity/source-client.ts:76` — "// end-of-pagination — only a present non-string value is invalid."
- `packages/remnic-core/src/activity/source-client.ts:114` — "// Bound every request so a stalled daemon aborts instead of hanging the"
- `packages/remnic-core/src/activity/source-client.ts:115` — "// sync forever; honor the caller's signal too when one is supplied."
- `packages/remnic-core/src/activity/source-client.ts:131` — "// The controlled `HTTP <status>` message is safe to surface verbatim;"
- `packages/remnic-core/src/activity/source-client.ts:132` — "// anything else (network/runtime fetch errors that can embed hostnames or"
- `packages/remnic-core/src/activity/source-client.ts:133` — "// absolute paths) is reduced to a sanitized name+code via"
- `packages/remnic-core/src/activity/source-client.ts:134` — "// displayErrorDetail, matching the wearables operator-facing path."
- `packages/remnic-core/src/activity/sync-registration.ts:69` — "/** Latched by dispose() so a draining tick's onRun cannot re-arm maintenance. */"
- `packages/remnic-core/src/activity/sync-registration.ts:87` — "// Re-arm or teardown: stop any prior scheduler before anything else, so a"
- `packages/remnic-core/src/activity/sync-registration.ts:88` — "// repeated registration never orphans a running interval."
- `packages/remnic-core/src/activity/sync-registration.ts:92` — "// Teardown began (possibly during the drain above). Never arm nor clear the"
- `packages/remnic-core/src/activity/sync-registration.ts:93` — "// latch: dispose() may already have set it, and it must stay set."
- `packages/remnic-core/src/activity/sync-registration.ts:95` — "// Opted-in at-rest encryption must not be silently bypassed: activity"
- `packages/remnic-core/src/activity/sync-registration.ts:96` — "// digests + SQLite are written in the clear, so refuse to run under it."
- `packages/remnic-core/src/activity/sync-registration.ts:103` — "// Committed to a fresh lifecycle: clear the latch so this scheduler's"
- `packages/remnic-core/src/activity/sync-registration.ts:104` — "// reindex retries fire again."
- `packages/remnic-core/src/activity/sync-registration.ts:111` — "// Strict refresh after each digest write (rule 31): bypasses the"
- `packages/remnic-core/src/activity/sync-registration.ts:112` — "// min-interval gate and throws on a real failure."
- `packages/remnic-core/src/activity/sync-registration.ts:115` — "// A failed reindex (QMD down) leaves the next unchanged-digest tick"
- `packages/remnic-core/src/activity/sync-registration.ts:116` — "// skipping afterWrites, so route the retry through the durable,"
- `packages/remnic-core/src/activity/sync-registration.ts:117` — "// throttled QMD path — but never after teardown."
- `packages/remnic-core/src/activity/sync-registration.ts:125` — "// Tail step: a durable tick that ingested snapshots may have changed a"
- `packages/remnic-core/src/activity/sync-registration.ts:126` — "// meeting's screen context; notify the dependent builder. Never after"
- `packages/remnic-core/src/activity/sync-registration.ts:127` — "// teardown."
- `packages/remnic-core/src/activity/sync-registration.ts:135` — "// Close the race where abort fires between the guard above and start()."
