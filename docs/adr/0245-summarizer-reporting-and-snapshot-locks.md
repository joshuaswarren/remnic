# Summarizer reports staleness honestly and snapshot upserts share one lock implementation

Status: accepted

## Context
runHourly previously reported an empty store and a failed scan identically, and
its scan state was shared across concurrent invocations. Summary-snapshot upserts
were guarded by TWO bespoke serializers (an in-process promise chain that could be
poisoned by one rejection, and a hand-rolled file lock) whose defects silently
dropped hours from the snapshot.

## Decision
- runHourly reports run stats and interprets them into an operator-facing
  message/warning; it must NOT report success on empty work. Scan bookkeeping is
  LOCAL to the invocation (shared state would let two concurrent runHourly calls
  cross-report each other's timestamps). A failed scan (permissions, I/O) is
  reported as failed — a different incident from an empty store, which must never
  be published when the scan failed. ENOENT on the root is an empty store, not a
  failure; ENOENT on a file is a concurrent deletion, ignored. Timestamps are
  compared as parsed epoch values, never strings, so a malformed hand-edited
  timestamp cannot poison the staleness signal with lexically-maximal garbage.
  The newest entry across the whole store doubles as the staleness signal from the
  same scan getActiveSessions already performs.
- Session identity goes through the shared session-identity layer: arbitrary keys
  route to `session/<hash>`, legacy paths stay readable via read-back candidate
  dirs, and identical raw JSONL rows left by a partially-applied migration are
  deduped (the exact raw line is the stable identity).
- Model resolution is shared (taskModelChain > gatewayAgentId). The HourlySummary
  surface stays stable: topics are encoded as bullets for recall injection.
- Summary-snapshot upserts run through the SHARED concurrency primitives:
  `serializeMutations` for in-process serialization (rejection-recovering — a
  failed upsert never poisons the next, which the old bare `.then` chain dropped)
  and `withHeldFileLock` for the cross-process mutex (replacement-safe stale break
  and ownership-checked release, stronger than the previous bare unlink). The
  upsert is a read-merge-write, so acquisition failure is a STRICT failure — never
  an unlocked best-effort run — and the error message names both contention
  timeouts and filesystem acquire failures honestly, keeping upstream fail-open
  unchanged.

## Consequences
Strict-fail locking means a broken summaries root makes the hour's upsert fail loudly rather than race; staleness reporting surfaces partial unreadability as an incident.

## Origin comments
- `packages/remnic-core/src/summarizer.ts:48` — "/** * Outcome stats of one `runHourly` pass (issue #2783). The summarizer must * not report success on empty w"
- `packages/remnic-core/src/summarizer.ts:69` — "/** * Interpret one {@link HourlySummarizerRunStats} into the operator-facing * message/warning (issue #2783)."
- `packages/remnic-core/src/summarizer.ts:161` — "// Shared resolution (taskModelChain > gatewayAgentId) \u2014 gotcha #22. Issue #1365."
- `packages/remnic-core/src/summarizer.ts:212` — "// Keep HourlySummary surface stable; encode \"topics\" as bullets for recall injection."
- `packages/remnic-core/src/summarizer.ts:793` — "// Get active sessions from transcript. The scan outcome is kept LOCAL to"
- `packages/remnic-core/src/summarizer.ts:794` — "// this invocation (review round 2): shared instance state would let two"
- `packages/remnic-core/src/summarizer.ts:795` — "// concurrent runHourly calls cross-report each other's timestamps."
- `packages/remnic-core/src/summarizer.ts:830` — "// Staleness signal (issue #2783): newest entry across the whole"
- `packages/remnic-core/src/summarizer.ts:831` — "// store, from the same scan getActiveSessions already performs."
- `packages/remnic-core/src/summarizer.ts:840` — "// Get list of active sessions from the transcript directory, plus the"
- `packages/remnic-core/src/summarizer.ts:841` — "// scan bookkeeping runHourly reports: newest entry timestamp (staleness"
- `packages/remnic-core/src/summarizer.ts:842` — "// signal) and whether the scan itself FAILED. A failed scan must not be"
- `packages/remnic-core/src/summarizer.ts:843` — "// reported as an empty store \u2014 those are different incidents (review"
- `packages/remnic-core/src/summarizer.ts:844` — "// round 2)."
- `packages/remnic-core/src/summarizer.ts:869` — "// Compare parsed epoch values, never strings: a malformed"
- `packages/remnic-core/src/summarizer.ts:870` — "// timestamp in a hand-edited file must not poison the staleness"
- `packages/remnic-core/src/summarizer.ts:871` — "// signal with a lexically-maximal garbage value (review)."
- `packages/remnic-core/src/summarizer.ts:884` — "// ENOENT is a concurrently-deleted file \u2014 ignore. Any other read"
- `packages/remnic-core/src/summarizer.ts:885` — "// failure (permissions, I/O) means the store is partially UNREADABLE:"
- `packages/remnic-core/src/summarizer.ts:886` — "// mark the scan failed so the caller warns instead of reporting an"
- `packages/remnic-core/src/summarizer.ts:887` — "// empty store (review round 3)."
- `packages/remnic-core/src/summarizer.ts:919` — "// ENOENT on the root is a never-written store \u2014 an EMPTY store, not a"
- `packages/remnic-core/src/summarizer.ts:920` — "// scan failure (those are different incidents)."
- `packages/remnic-core/src/summarizer.ts:932` — "// Shared session-identity layer (issue #1496, rule #22). Arbitrary keys"
- `packages/remnic-core/src/summarizer.ts:933` — "// route to `session/<hash>`; legacy `agent:<id>:...` keep their paths. The"
- `packages/remnic-core/src/summarizer.ts:934` — "// shared helper also supplies the read-back-only candidate dirs (mirrors"
- `packages/remnic-core/src/summarizer.ts:935` — "// TranscriptManager) so legacy `other/default` AND old `parts.length >= 3`"
- `packages/remnic-core/src/summarizer.ts:936` — "// data stays discoverable here too."
- `packages/remnic-core/src/summarizer.ts:947` — "// Dedup identical raw rows that a partially-applied migration may have"
- `packages/remnic-core/src/summarizer.ts:948` — "// left in both the primary dir and a read-back dir (issue #1496, cursor"
- `packages/remnic-core/src/summarizer.ts:949` — "// review). Exact raw JSONL line is the stable identity."
- `packages/remnic-core/src/summary-snapshot.test.ts:762` — "// \u2500\u2500 Issue #1524 adoption prove-fail: summary-snapshot upserts must run through"
- `packages/remnic-core/src/summary-snapshot.test.ts:763` — "// the shared serializeMutations chain (rejection-recovering). The defect class"
- `packages/remnic-core/src/summary-snapshot.test.ts:764` — "// is a naive bare-.then(fn) chain that silently drops subsequent tasks after a"
- `packages/remnic-core/src/summary-snapshot.test.ts:765` — "// rejection: if upsert A rejects (e.g. transient I/O error) and the chain does"
- `packages/remnic-core/src/summary-snapshot.test.ts:766` — "// not recover, upsert B queued behind it never runs \u2014 its hour goes missing"
- `packages/remnic-core/src/summary-snapshot.test.ts:767` — "// from the snapshot. We seed the failure by rejecting the first upsert (a"
- `packages/remnic-core/src/summary-snapshot.test.ts:768` — "// hostile lock directory that throws on mkdir), then upsert B must STILL land"
- `packages/remnic-core/src/summary-snapshot.test.ts:769` — "// its hour. Pre-fix (a poison chain) B would be skipped."
- `packages/remnic-core/src/summary-snapshot.test.ts:774` — "// The lock directory for sessionKey is <root>/state/summaries/<encoded>.lock."
- `packages/remnic-core/src/summary-snapshot.test.ts:775` — "// Pre-create a FILE at the summaries root so the upsert's mkdir(dirname)"
- `packages/remnic-core/src/summary-snapshot.test.ts:776` — "// inside writeSummarySnapshot throws ENOTDIR \u2014 a deterministic rejection"
- `packages/remnic-core/src/summary-snapshot.test.ts:777` — "// that does not depend on filesystem timing. Both upserts target the SAME"
- `packages/remnic-core/src/summary-snapshot.test.ts:778` — "// sessionKey so they serialize through the same chain."
- `packages/remnic-core/src/summary-snapshot.test.ts:798` — "// Upsert A rejects (hostile summaries root). We MUST catch \u2014 the contract"
- `packages/remnic-core/src/summary-snapshot.test.ts:799` — "// is that the chain recovers, not that the failing op silently succeeds."
- `packages/remnic-core/src/summary-snapshot.ts:33` — "// Lock timings for the cross-process summary-snapshot file lock. These are"
- `packages/remnic-core/src/summary-snapshot.ts:34` — "// passed straight through to the shared `withHeldFileLock` utility (issue"
- `packages/remnic-core/src/summary-snapshot.ts:35` — "// #1524 adoption); the previous bespoke lock used the same numbers."
- `packages/remnic-core/src/summary-snapshot.ts:138` — "// \u2500\u2500 Concurrency primitives (issue #1524 adoption) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
- `packages/remnic-core/src/summary-snapshot.ts:139` — "//"
- `packages/remnic-core/src/summary-snapshot.ts:140` — "// Summary-snapshot upserts were previously guarded by TWO bespoke serializers:"
- `packages/remnic-core/src/summary-snapshot.ts:141` — "// 1. an in-process `summarySnapshotUpserts` map keyed by sessionKey that"
- `packages/remnic-core/src/summary-snapshot.ts:142` — "// chained each upsert off the prior one's release (mirroring"
- `packages/remnic-core/src/summary-snapshot.ts:143` — "// `serializeMutations`), and"
- `packages/remnic-core/src/summary-snapshot.ts:144` — "// 2. an on-disk `withExclusiveSummarySnapshotFileLock` that re-implemented"
- `packages/remnic-core/src/summary-snapshot.ts:145` — "// `open(path, \"wx\")` acquire, mtime heartbeat, stale-break, and"
- `packages/remnic-core/src/summary-snapshot.ts:146` — "// ownership-checked release."
- `packages/remnic-core/src/summary-snapshot.ts:147` — "// Both now delegate to the shared utility so there is ONE home for each"
- `packages/remnic-core/src/summary-snapshot.ts:148` — "// primitive (`serializeMutations` for in-process, `withHeldFileLock` for"
- `packages/remnic-core/src/summary-snapshot.ts:149` — "// cross-process). The behavior contract is preserved:"
- `packages/remnic-core/src/summary-snapshot.ts:150` — "// - in-process upserts for the SAME sessionKey are strictly serialized"
- `packages/remnic-core/src/summary-snapshot.ts:151` — "// (read-merge-write cannot interleave);"
- `packages/remnic-core/src/summary-snapshot.ts:152` — "// - a cross-process holder blocks up to `summarySnapshotLockTimeoutMs`, then"
- `packages/remnic-core/src/summary-snapshot.ts:153` — "// the upsert FAILS (a snapshot is advisory; we never race a read-merge-write"
- `packages/remnic-core/src/summary-snapshot.ts:154` — "// unlocked). To preserve this strictness on top of a best-effort utility,"
- `packages/remnic-core/src/summary-snapshot.ts:155` — "// the work callback throws when `acquired === false`."
- `packages/remnic-core/src/summary-snapshot.ts:162` — "// In-process serialization (one upsert per sessionKey at a time). The"
- `packages/remnic-core/src/summary-snapshot.ts:163` — "// serializer recovers from rejection, so a failed upsert never poisons the"
- `packages/remnic-core/src/summary-snapshot.ts:164` — "// next one \u2014 matching the previous chain's `.then(noop, noop)` recovery."
- `packages/remnic-core/src/summary-snapshot.ts:166` — "// Cross-process mutex via the shared utility. The lock path, stale"
- `packages/remnic-core/src/summary-snapshot.ts:167` — "// threshold, bounded wait, and heartbeat cadence all flow through; the"
- `packages/remnic-core/src/summary-snapshot.ts:168` — "// utility's replacement-safe stale break (NG7Bg) and ownership-checked"
- `packages/remnic-core/src/summary-snapshot.ts:169` — "// release are stronger than the bare `unlink` this module used before."
- `packages/remnic-core/src/summary-snapshot.ts:178` — "// Strict-fail when the lock could not be acquired: the upsert is a"
- `packages/remnic-core/src/summary-snapshot.ts:179` — "// read-merge-write, so a best-effort unlocked run would clobber a"
- `packages/remnic-core/src/summary-snapshot.ts:180` — "// concurrent writer. The utility's `acquired === false` covers BOTH a"
- `packages/remnic-core/src/summary-snapshot.ts:181` — "// genuine contention timeout AND a filesystem acquire failure (lock-dir"
- `packages/remnic-core/src/summary-snapshot.ts:182` — "// mkdir/open/permission errors \u2014 the advisory lock is best-effort, so"
- `packages/remnic-core/src/summary-snapshot.ts:183` — "// the util degrades rather than throwing). The bespoke lock this"
- `packages/remnic-core/src/summary-snapshot.ts:184` — "// replaced propagated fs errors verbatim and reserved the timeout"
- `packages/remnic-core/src/summary-snapshot.ts:185` — "// message for contention; we no longer claim \"timed out\" for an fs"
- `packages/remnic-core/src/summary-snapshot.ts:186` — "// failure (cursor Low 25143f4f) \u2014 the message names both causes so"
- `packages/remnic-core/src/summary-snapshot.ts:187` — "// upstream fail-open (runHourly) is unchanged but debugging is honest."
