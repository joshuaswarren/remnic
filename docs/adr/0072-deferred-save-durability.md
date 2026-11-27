# A buffered turn is durable before extraction runs; failed or deferred saves stay pending and retry — memory and disk never silently diverge

Status: accepted

## Context
Whole-state session persistence is debounced for throughput, and large hot session files are rewritten on a deferral cadence (#3389) to avoid per-turn rewrites. Every earlier shortcut — clearing pendingSave before the write succeeds, clearing it outside the serializer, arming no retry after a deferred failure, escalating a retry into a barrier rewrite — dropped turns or rewrote a rate-limited session. The sanctioned crash-loss window is the debounce interval, nothing wider.

## Decision
Treat the pending-save flag as the durability contract: (1) the turn that triggers extraction must be durable before extraction runs — triggering writes are durability barriers that pass allowDeferral:false and surface failure to the caller (throwOnFailure on the extract path; fail-open only for timer/shutdown callers); (2) pendingSave is cleared only inside the same serialized mutation as a successful write, and only after the write succeeds — a failed write keeps the flag pending and re-arms a retry (timer and graceful-shutdown flush both retry), so buffered turns — including other sessions' turns that only ever existed in debounced state — are never dropped; (3) a debounce timer is dropped before mutation so it cannot fire mid-mutation, but the pending state is retained until the post-clear write is durable; (4) steady-state buffering coalesces onto a trailing-edge debounced save; a staleness-cap hit runs the pass inline instead of re-arming; session-level deferral may rate-limit a large rewrite, and when it does, armDeferredRetry lands the tail at the session's eligibility time — a deferred pass must always arm a retry (debounce on or off), and a catch-path retry must preserve deferral: a steady-state retry must not escalate into a barrier write of a rate-limited session; (5) a concurrent flush that already persisted the save is detected under the serializer and skipped (no phantom writes); (6) deferral is refused for sessions a backend cannot prove unclaimed: a session-capable backend that omits isBufferSessionClaimed forces fail-closed immediate persistence; (7) admission keys are never persisted while session bodies are still deferred — a crash after the key lands but before the deferred rewrite would let a same-key retry swallow the unwritten turns; (8) a dirty key without state is persisted as a deletion, never from a fabricated empty entry; (9) a "handed_over" entry's pending state is settled (durable in the claim) and its in-memory entry is evicted by the caller; (10) the deferral size estimate includes serialized JSON structure + escaping (~15% over content plus fixed per-turn overhead) and errs high, because under-counting biases against deferral — the exact case the floor exists for.

## Consequences
The crash-loss window is bounded by the debounce/deferral interval, not eliminated; a crash inside it loses the tail by design. Every failure path must arm a retry, so save code carries retry state on every branch. High-biased size estimates occasionally defer sessions a flat sum would have rewritten. Preserving deferral across retries means a large session can stay memory-resident longer than a naive barrier policy would allow — bounded by its eligibility time.

## Origin comments
### buffer-incremental-persistence-contract
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:1` — "/** * Per-session incremental buffer persistence (SmartBuffer layer). * * Pins the hot-path contract on top of the stor…"
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:144` — "// Inline save already ran inside the mutation — no flush needed."

### buffer-persistence-test-doubles
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:35` — "/** * Storage double implementing the incremental per-session surface. Records * per-session writes/deletes and whole-s…"
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:72` — "/** * Storage double implementing ONLY the legacy whole-state surface — every * pre-existing test double in the repo lo…"

### large-session-rewrite-deferral
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:1` — "/** * Large-session rewrite deferral (issue #3389). * * A session file grows without bound while its session stays hot; "

### extraction-trigger-durability
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:242` — "// This turn triggers extraction (turns >= bufferMaxTurns): the triggering"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:243` — "// turn must be durable before extraction runs — no deferral."

### realtime-linked-fake-clock
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:251` — "/** * Real-time-linked fake clock for the SmartBuffer-level deferral tests: the * deferred-retry timer is a real setTime"

### deferred-retry-arm
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:262` — "// Review round 2 (PR 3481): after a deferred pass the buffer cleared"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:263` — "// pendingSave and armed nothing, so the tail of a burst sat in memory until"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:264` — "// the next turn or barrier — wider than the sanctioned crash-loss window."
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:265` — "// Debounce off: the keep_buffering path saves inline and opts into deferral,"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:266` — "// so the second turn defers and the armed retry must land it at eligibility."

### retry-preserves-deferral
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:343` — "// Review round 2: the catch-path retry armed flushPendingSave() without"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:344` — "// opts, so the retry ran as a barrier and rewrote the large session anyway."
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:345` — "// The failing write belongs to a SMALL session in the same pass: while big"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:346` — "// sits inside its deferral window, small's transient failure makes the catch"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:347` — "// re-arm a retry — and that retry must still defer big."
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:377` — "// Big gets a tail turn (deferred, inside its window) and small fails once in"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:378` — "// the same pass. The catch re-arms a retry; without deferral preserved it"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:379` — "// would rewrite big as a barrier."
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:432` — "// Review round 3 (PR 3481): with bufferSaveDebounceMs 0 the catch block in"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:433` — "// flushPendingSave armed no retry — a transient failure at the deferred"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:434` — "// session's eligibility time left it dirty until another turn or barrier."
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:461` — "// Second turn defers; the eligibility-time write fails once. A retry armed"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:462` — "// independent of the debounce must land the session — no further turn and"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:463` — "// no barrier."

### size-estimate-json-overhead
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:396` — "// The estimate must include serialized JSON structure + escaping: content"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:397` — "// just under 8 MiB serializes past the floor, so a flat content sum"
- `packages/remnic-core/src/buffer-large-session-defer.test.ts:398` — "// under-counts and the hot file keeps being rewritten every flush."
- `packages/remnic-core/src/buffer-persistence.ts:73` — "// ~15% over content for JSON structure + string escaping (quotes, braces,"
- `packages/remnic-core/src/buffer-persistence.ts:74` — "// key names, escape growth); the fixed per-turn overhead covers field names"
- `packages/remnic-core/src/buffer-persistence.ts:75` — "// and metadata. Under-counting here biases against deferral — the exact"
- `packages/remnic-core/src/buffer-persistence.ts:76` — "// case the floor exists for — so the estimate errs high."

### dirty-key-without-state-as-deletion
- `packages/remnic-core/src/buffer-persistence.ts:178` — "// A dirty key without state must not be written from a fabricated"
- `packages/remnic-core/src/buffer-persistence.ts:179` — "// empty entry: treat it as a deletion instead."

### admission-idempotency-after-deferred
- `packages/remnic-core/src/buffer-persistence.ts:218` — "// #3368: never persist admission keys while session bodies are still deferred —"
- `packages/remnic-core/src/buffer-persistence.ts:219` — "// a crash after the key lands but before the deferred rewrite would make a"
- `packages/remnic-core/src/buffer-persistence.ts:220` — "// same-key retry swallow the unwritten turns."

### debounce-failed-flush-retry
- `packages/remnic-core/src/buffer-session.test.ts:965` — "// Issue #1909 review round 2 finding 1: flushPendingSave must not clear"
- `packages/remnic-core/src/buffer-session.test.ts:966` — "// pendingSave until the write SUCCEEDS — otherwise a failed write diverges"
- `packages/remnic-core/src/buffer-session.test.ts:967` — "// memory from disk and a later shutdown flush early-returns, dropping turns."
- `packages/remnic-core/src/buffer-session.test.ts:1059` — "// Issue #1909 review round 13: clearAfterExtraction must NOT clear the global"
- `packages/remnic-core/src/buffer-session.test.ts:1060` — "// pending-save state/timer before its post-clear save is durable. If any"
- `packages/remnic-core/src/buffer-session.test.ts:1061` — "// session has a debounced save pending and the post-clear write throws, the"
- `packages/remnic-core/src/buffer-session.test.ts:1062` — "// pending state must be retained + re-armed so shutdown/the timer retries —"
- `packages/remnic-core/src/buffer-session.test.ts:1063` — "// otherwise buffered turns from OTHER sessions that only ever existed in the"
- `packages/remnic-core/src/buffer-session.test.ts:1064` — "// debounced state are lost."

### flush-clear-serializer-atomicity
- `packages/remnic-core/src/buffer-session.test.ts:1162` — "// Issue #1909 PR #2016 review: flushPendingSave used to clear"
- `packages/remnic-core/src/buffer-session.test.ts:1163` — "// pendingSave/firstPendingAtMs AFTER the serialized write mutation resolved,"
- `packages/remnic-core/src/buffer-session.test.ts:1164` — "// i.e. OUTSIDE the serializer. A turn recorded around that flush re-arms a"
- `packages/remnic-core/src/buffer-session.test.ts:1165` — "// debounced save (pendingSave = true); if the flush's late clear then wiped"
- `packages/remnic-core/src/buffer-session.test.ts:1166` — "// that flag, the interleaved turn's own scheduled flush would early-return"
- `packages/remnic-core/src/buffer-session.test.ts:1167` — "// and its persistence would be lost. The fix makes write + clear atomic on"
- `packages/remnic-core/src/buffer-session.test.ts:1168` — "// the existing serializer mutex. This drives the interleave deterministically"
- `packages/remnic-core/src/buffer-session.test.ts:1169` — "// and proves BOTH the pre-flush turn and the interleaved turn reach disk."

### debounced-save-staleness-deferral
- `packages/remnic-core/src/buffer.ts:317` — "// Staleness cap hit: run the persist pass inline rather than re-arming"
- `packages/remnic-core/src/buffer.ts:318` — "// the debounce. Session-level deferral (#3389) may still rate-limit a"
- `packages/remnic-core/src/buffer.ts:319` — "// large rewrite; when it does, armDeferredRetry keeps the save pending"
- `packages/remnic-core/src/buffer.ts:320` — "// and retries at the session's eligibility time, so the pass's tail"
- `packages/remnic-core/src/buffer.ts:321` — "// cannot sit in memory waiting for a turn that may never come (3481"
- `packages/remnic-core/src/buffer.ts:322` — "// review). Drop the armed timer and only mark clean on success — a"
- `packages/remnic-core/src/buffer.ts:323` — "// failure keeps the save pending + re-arms so shutdown/the next timer"
- `packages/remnic-core/src/buffer.ts:324` — "// retries (issue #1909 review round 2), never diverging memory from disk."

### buffer-pending-save-retention
- `packages/remnic-core/src/buffer.ts:444` — "// Re-check under the serializer: a concurrent flush may have already"
- `packages/remnic-core/src/buffer.ts:445` — "// persisted this pending save. Skip the redundant write (no phantom"
- `packages/remnic-core/src/buffer.ts:446` — "// writes). resetToEmpty-only deletions also land here without a"
- `packages/remnic-core/src/buffer.ts:447` — "// pending-save flag."
- `packages/remnic-core/src/buffer.ts:450` — "// Clear the pending flag INSIDE the same serialized mutation as the"
- `packages/remnic-core/src/buffer.ts:451` — "// write (issue #1909 review): an addTurn interleaving between the"
- `packages/remnic-core/src/buffer.ts:452` — "// write and the clear would lose its re-armed timer. Deferred"
- `packages/remnic-core/src/buffer.ts:453` — "// sessions keep the flag — still dirty — and armDeferredRetry"
- `packages/remnic-core/src/buffer.ts:454` — "// schedules their write at eligibility."
- `packages/remnic-core/src/buffer.ts:463` — "// The write failed: memory and disk diverge (issue #1909 review round 2)."
- `packages/remnic-core/src/buffer.ts:464` — "// Keep the save PENDING (do NOT clear pendingSave/firstPendingAtMs) so a"
- `packages/remnic-core/src/buffer.ts:465` — "// graceful shutdown flush and the re-armed timer both retry it — clearing"
- `packages/remnic-core/src/buffer.ts:466` — "// the flag here would drop the buffered turns permanently. Re-arm a"
- `packages/remnic-core/src/buffer.ts:467` — "// background retry even when debounce is off (3481 review round 3)."
- `packages/remnic-core/src/buffer.ts:1051` — "// Drop any armed debounce TIMER so it cannot fire mid-mutation and race"
- `packages/remnic-core/src/buffer.ts:1052` — "// our post-clear write, but KEEP the pending-save state (issue #1909"
- `packages/remnic-core/src/buffer.ts:1053` — "// review round 13): the post-clear save below can fail, and clearing the"
- `packages/remnic-core/src/buffer.ts:1054` — "// pending flag here would strand buffered turns — including turns from"
- `packages/remnic-core/src/buffer.ts:1055` — "// OTHER sessions that only ever entered the debounced pending state — with"
- `packages/remnic-core/src/buffer.ts:1056` — "// nothing left to retry them. saveNowRetainingPendingOnFailure clears the"
- `packages/remnic-core/src/buffer.ts:1057` — "// pending state only after a durable write, or re-arms it on failure."

### deferred-retry-no-escalation
- `packages/remnic-core/src/buffer.ts:476` — "// A steady-state retry must not escalate into a barrier write of a"
- `packages/remnic-core/src/buffer.ts:477` — "// rate-limited session (3481 review)."

### flush-durability-barrier
- `packages/remnic-core/src/buffer.ts:482` — "// Surprise-extraction boundary needs the durability guarantee — surface"
- `packages/remnic-core/src/buffer.ts:483` — "// the failure so the caller does not proceed with a non-durable flush."
- `packages/remnic-core/src/buffer.ts:485` — "// fail-open for timer/shutdown callers"

### buffer-debounced-save
- `packages/remnic-core/src/buffer.ts:711` — "// Steady-state buffering: coalesce the whole-state serialize onto a"
- `packages/remnic-core/src/buffer.ts:712` — "// trailing-edge timer (issue #1909) instead of rewriting per turn."
- `packages/remnic-core/src/buffer.ts:715` — "// Persist immediately within this mutation (awaited) when either:"
- `packages/remnic-core/src/buffer.ts:716` — "// - the turn triggered extraction (the buffer must be durable), or"
- `packages/remnic-core/src/buffer.ts:717` — "// - debounce is disabled (bufferSaveDebounceMs <= 0), which reproduces"
- `packages/remnic-core/src/buffer.ts:718` — "// the legacy save-every-turn behavior byte-for-byte."
- `packages/remnic-core/src/buffer.ts:719` — "// Round 8 thread 4: the write is attempted BEFORE the pending state is"
- `packages/remnic-core/src/buffer.ts:720` — "// cleared, and a failed write leaves it pending (+ a re-armed timer) for"
- `packages/remnic-core/src/buffer.ts:721` — "// shutdown/timer retry instead of dropping the in-memory turns."
- `packages/remnic-core/src/buffer.ts:722` — "// #3389: a keep_buffering turn has no extraction barrier, so this pass"
- `packages/remnic-core/src/buffer.ts:723` — "// may defer rewriting a large session file that was just persisted —"
- `packages/remnic-core/src/buffer.ts:724` — "// the rewrite cadence for huge sessions collapses from per-turn to"
- `packages/remnic-core/src/buffer.ts:725` — "// once per BUFFER_SESSION_DEFER_INTERVAL_MS. A triggering turn is a"
- `packages/remnic-core/src/buffer.ts:726` — "// durability barrier and passes allowDeferral: false."

### deferred-retention-order
- `packages/remnic-core/src/buffer.ts:882` — "// Retained turns (from a previous defer verdict, issue #562 PR 2) are"
- `packages/remnic-core/src/buffer.ts:883` — "// prepended so the chronological order — oldest context first — is"
- `packages/remnic-core/src/buffer.ts:884` — "// preserved for the next extraction pass."
