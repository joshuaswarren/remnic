# QMD operations degrade gracefully under congestion, serialize safely, and cache only trustworthy results - a slow or saturated backend reduces recall quality (lex-only) but never hangs or returns cross-contaminated results.

Status: accepted

## Context
QMD is a shared external resource (SQLite-backed, optional daemon, subprocesses with grandchildren) invoked concurrently from many channels; unserialized calls contend on locks, a saturated embedding backend stalls all recall, and cache keys that omit strategy collide.

## Decision
Searches prefer the daemon and trust its outcome over the subprocess path (which hangs on large indexes); the subprocess launcher runs detached in its own POSIX process group so a timeout/abort kill takes down grandchildren too (Windows falls back to a direct child kill). All non-daemon qmd calls are serialized behind one mutex to avoid SQLite lock contention. The daemon search timeout stays under the recall timeout so a slow daemon fails fast; the default covers multi-GB cold indexes and remains operator-overridable.

Congestion: a hybrid query slower than a threshold opens a congestion window keyed by the shared daemon session - every client retaining that session then runs the lex-only plan; an in-flight call already past the threshold gates siblings even before the window opens. Version-check probes retry only TRANSIENT failures (timeout/abort under load) with backoff; ENOENT/EACCES is hard misconfiguration and fails fast, and message text is never scanned to reclassify a failure. Cancellation is detected first as non-actionable noise.

Cache and cancellation: the recall cache key captures daemon/subprocess strategies (no cross-strategy collisions within the TTL); centralized invalidation lives in the update/embed paths so every refresh route invalidates without per-caller diligence; only degraded-free results are cached (no degradation on hit). Identical concurrent searches share one in-flight call whose signal aborts only when every waiter has aborted; a doomed slot's late-settling promise is never handed to a new caller and its rejection is swallowed. The default search plan and no-strategy default preserve historical recall behaviour across upgrades. New regexes in this area are written as character scans to satisfy the regex-safety ratchet.

## Consequences
Congestion trades recall quality for availability; POSIX-only process-group semantics; the daemon timeout is a global default operators with small indexes may want to lower; cache correctness depends on strategy remaining part of the key.

> Note: this file merges smaller neighbouring themes that did not warrant their own ADR under the ten-file limit for this chunk.

## Origin comments
(80 records)
- `packages/remnic-core/src/qmd-daemon-congestion.test.ts:8` - "/** * Regression coverage for the recall stall fixed in #3476: when the shared * qmd mcp daemon's embedding backend is c"
- `packages/remnic-core/src/qmd-daemon-session.ts:24` - "/** * Drop C0 controls and one ANSI CSI sequence. Char scan on purpose: * the regex-safety ratchet flags new regular exp"
- `packages/remnic-core/src/qmd-daemon-session.ts:54` - "/** * One `qmd mcp` child and its JSON-RPC session. * * Aborting or timing out a `tools/call` writes MCP `notifications/"
- `packages/remnic-core/src/qmd-daemon-session.ts:250` - "// Only a tool call that actually went out can be holding the worker."
- `packages/remnic-core/src/qmd-daemon-session.ts:251` - "// initialize stays running across a slow model load."
- `packages/remnic-core/src/qmd-mcp-cancel.ts:3` - "/** * One in-flight daemon search shared by identical callers. * The shared signal aborts only when every waiter has abo"
- `packages/remnic-core/src/qmd-mcp-cancel.ts:28` - "// A slot whose last waiter already aborted is doomed; its promise settles"
- `packages/remnic-core/src/qmd-mcp-cancel.ts:29` - "// late. Never hand it to a new caller."
- `packages/remnic-core/src/qmd-mcp-cancel.ts:48` - "// A cancel with no remaining waiter rejects this promise after the"
- `packages/remnic-core/src/qmd-mcp-cancel.ts:49` - "// waiter has already settled. Swallow that so it is not unhandled."
- `packages/remnic-core/src/qmd-mcp-cancel.ts:94` - "/** * Score documents on a shared cursor and stop between documents when * `signal` aborts. In-flight `rankIndex` calls "
- `packages/remnic-core/src/qmd-preflight.ts:1` - "/** * QMD version-check PREFLIGHT / probe-classification helpers. * * Pure, self-contained functions extracted from qmd."
- `packages/remnic-core/src/qmd-preflight.ts:25` - "// Backoff schedule (ms) for retrying a TRANSIENT (timeout/abort) version-check"
- `packages/remnic-core/src/qmd-preflight.ts:26` - "// probe of a CONFIGURED qmdPath before declaring it failed. A binary that"
- `packages/remnic-core/src/qmd-preflight.ts:27` - "// resolved and ran before is more likely slow under load than gone, so we retry"
- `packages/remnic-core/src/qmd-preflight.ts:28` - "// transient failures but NOT ENOENT/EACCES (hard misconfiguration, fail fast)."
- `packages/remnic-core/src/qmd-preflight.ts:29` - "// Length == number of retries after the initial attempt. Issue #1841."
- `packages/remnic-core/src/qmd-preflight.ts:34` - "/** * Classify a `qmd --version` probe failure so the preflight can distinguish a * slow/overloaded binary (a genuine de"
- `packages/remnic-core/src/qmd-preflight.ts:59` - "// An AbortError reaching here is a deadline/abort under load → transient."
- `packages/remnic-core/src/qmd-preflight.ts:60` - "// (Caller cancellation is intercepted by the retry loop before this runs.)"
- `packages/remnic-core/src/qmd-preflight.ts:62` - "// Anything else — including a non-zero exit whose message embeds stderr — is"
- `packages/remnic-core/src/qmd-preflight.ts:63` - "// a generic failure: never scan the message to upgrade/downgrade it."
- `packages/remnic-core/src/qmd-process-group.test.ts:9` - "// Regression for issue #2456: on timeout/abort the bounded qmd subprocess"
- `packages/remnic-core/src/qmd-process-group.test.ts:10` - "// launcher must be killed together with its descendants. The launcher runs"
- `packages/remnic-core/src/qmd-process-group.test.ts:11` - "// detached (own process group) so a negative-pid signal reaches grandchildren"
- `packages/remnic-core/src/qmd-process-group.test.ts:12` - "// the old child.kill("SIGKILL") left behind. POSIX only — Windows falls back"
- `packages/remnic-core/src/qmd-process-group.test.ts:13` - "// to a direct child kill by design."
- `packages/remnic-core/src/qmd-process-group.test.ts:15` - "// Real timers by design: this suite kills real OS processes, so the timeout"
- `packages/remnic-core/src/qmd-process-group.test.ts:16` - "// trigger and the exit polls run against the platform clock. Fake timers"
- `packages/remnic-core/src/qmd-process-group.test.ts:17` - "// cannot deliver signals to a spawned `sleep`. Every poll awaits a condition"
- `packages/remnic-core/src/qmd-process-group.test.ts:18` - "// (pid file exists, process gone), never a fixed sleep."
- `packages/remnic-core/src/qmd-recall-cache.ts:25` - "// QMD search/subprocess strategies change the recalled results, so they must"
- `packages/remnic-core/src/qmd-recall-cache.ts:26` - "// participate in the cache key — otherwise a different strategy's cached QMD"
- `packages/remnic-core/src/qmd-recall-cache.ts:27` - "// phase is served within the TTL (gotcha #37). Issue #1335 (codex review #1422)."
- `packages/remnic-core/src/qmd.test.ts:80` - "// Default (no strategy argument) must preserve historical behavior so an"
- `packages/remnic-core/src/qmd.test.ts:81` - "// upgrade never silently drops vector/HyDE recall. Issue #1335."
- `packages/remnic-core/src/qmd.test.ts:400` - "// The centralized invalidation lives in QmdClient.runUpdateForCollection /"
- `packages/remnic-core/src/qmd.test.ts:401` - "// runEmbedForCollection so every refresh path (direct update, namespace"
- `packages/remnic-core/src/qmd.test.ts:402` - "// router, wearable/OpenClaw sync) invalidates the cached pre-refresh bundles"
- `packages/remnic-core/src/qmd.test.ts:403` - "// without each caller having to remember. Defend that contract."
- `packages/remnic-core/src/qmd.ts:158` - "// Daemon timeout for search calls. Keep under RECALL_TIMEOUT_MS (75s) so a slow"
- `packages/remnic-core/src/qmd.ts:159` - "// daemon fails fast. Default only — override via `qmdDaemonTimeoutMs` (#1335/#3098)."
- `packages/remnic-core/src/qmd.ts:160` - "// 60s covers multi-GB cold indexes that 8s missed; operators can still set 8s."
- `packages/remnic-core/src/qmd.ts:162` - "// Congestion degradation (#3476): when the daemon's embedding backend is"
- `packages/remnic-core/src/qmd.ts:163` - "// saturated by outside work, every hybrid query waits on the same serialized"
- `packages/remnic-core/src/qmd.ts:164` - "// resource. A query slower than this threshold marks the daemon congested…"
- `packages/remnic-core/src/qmd.ts:166` - "// …and subsequent queries run lex-only (no embed legs) for this long."
- `packages/remnic-core/src/qmd.ts:357` - "/** * Build the structured sub-queries the daemon `query` tool runs in one request. * * The default `"hybrid"` plan (..."
- `packages/remnic-core/src/qmd.ts:488` - "// Serialize all qmd calls. This avoids SQLite lock contention when multiple"
- `packages/remnic-core/src/qmd.ts:489` - "// channels/agents trigger QMD operations at nearly the same time."
- `packages/remnic-core/src/qmd.ts:571` - "// POSIX: own process group so a timeout/abort kill can take down qmd's"
- `packages/remnic-core/src/qmd.ts:572` - "// grandchildren too (launcher scripts spawn workers that outlive the"
- `packages/remnic-core/src/qmd.ts:573` - "// launcher itself). Issue #2456. Windows ignores this option here —"
- `packages/remnic-core/src/qmd.ts:574` - "// kill falls back to a direct child.kill."
- `packages/remnic-core/src/qmd.ts:676` - "/** * Splits `collection/path.ext - Title text` into path and title. * Non-greedy `.+?` finds the FIRST dot-extension..."
- `packages/remnic-core/src/qmd.ts:840` - "// Test-only seams (#1537): lifecycle tests assert the pool reaches zero after"
- `packages/remnic-core/src/qmd.ts:841` - "// every holder disposes — the property the stop()-teardown fix restores."
- `packages/remnic-core/src/qmd.ts:846` - "// Congestion deadlines keyed by the shared daemon session itself, so every"
- `packages/remnic-core/src/qmd.ts:847` - "// QmdClient retaining the same session reads one window: a slow/timeout mark"
- `packages/remnic-core/src/qmd.ts:848` - "// from any sibling gates them all (#3476)."
- `packages/remnic-core/src/qmd.ts:851` - "// In-flight slow-call markers (#3499): a hybrid/vector daemon call that is"
- `packages/remnic-core/src/qmd.ts:852` - "// already past the slow-query threshold gates siblings on the same session"
- `packages/remnic-core/src/qmd.ts:853` - "// even before its result opens the congestion window above. Handles carry the"
- `packages/remnic-core/src/qmd.ts:854` - "// mocked-clock-friendly start time; the gate is a pure clock comparison."
- `packages/remnic-core/src/qmd.ts:860` - "// Test-only seam: congestion tests drive a stub session object directly."
- `packages/remnic-core/src/qmd.ts:1169` - "// Retry only transient probes; ENOENT/EACCES is a hard misconfiguration (#1841)."
- `packages/remnic-core/src/qmd.ts:1181` - "// Detect caller cancellation first — non-actionable noise (#1841)."
- `packages/remnic-core/src/qmd.ts:1187` - "// Never retry a hard misconfiguration (missing/not-executable) — only"
- `packages/remnic-core/src/qmd.ts:1188` - "// transient slowness. (Caller cancellation is handled above.)"
- `packages/remnic-core/src/qmd.ts:1203` - "// Distinct warnings for slow binary vs misconfiguration; suppress on caller cancellation (#1841)."
- `packages/remnic-core/src/qmd.ts:1214` - "// Preserve the historical generic message for exit-code/other failures."
- `packages/remnic-core/src/qmd.ts:1397` - "// Daemon mode is healthy; keep this as debug noise rather than warning."
- `packages/remnic-core/src/qmd.ts:1525` - "/** * Open the congestion window (#3476): while set, daemon searches run the * lex-only plan instead of lex+vec+hyde ..."
- `packages/remnic-core/src/qmd.ts:1560` - "/** * Handle a non-timeout, non-cancellation daemon error. * Tolerates up to DAEMON_MAX_TRANSIENT_FAILURES consecutiv..."
- `packages/remnic-core/src/qmd.ts:1751` - "// Key must capture daemon/subprocess strategies to avoid cross-instance collisions (#1335)."
- `packages/remnic-core/src/qmd.ts:1753` - "// Cache and join only calls with the same plan (#3476, #3499)."
- `packages/remnic-core/src/qmd.ts:1762` - "// No degradation on cache hit by design (#1536): only trustworthy results are cached."
- `packages/remnic-core/src/qmd.ts:1767` - "// Try daemon first (bypasses QMD_MUTEX — daemon handles its own concurrency)"
- `packages/remnic-core/src/qmd.ts:1780` - "// When the daemon is available, trust its outcome and skip the subprocess."
- `packages/remnic-core/src/qmd.ts:1781` - "// The subprocess runs `qmd query` (BM25 + LLM expansion) which hangs at"
