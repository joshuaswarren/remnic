# Screen capture checks deny-lists and redacts BEFORE any text is extracted, hashed, or written, and the daemon stays loopback-only with owner-only storage

Status: accepted

## Context
Screen capture handles the most sensitive content in the system (password managers, browsing history), so ordering rules — deny before extraction, redact before hashing — matter more than any single control. The package also deliberately runs standalone from the core pipeline, which means its vendored helpers must be kept faithful.

Merged sweep themes: capture-privacy-ordering, deny-before-text-extraction, redact-before-hash, global-regexp-lastindex, capture-screen-security, capture-screen-sanitization, capture-screen-loopback-only, capture-screen-error-taxonomy, capture-screen-cli-runtime, capture-screen-standalone, spool-permissions, token-security, pidfile-design, utc-canonicalization, replay-determinism, daywindow-core-adapter, dedup-suppression, simhash-design, scheduler-idle-vs-settle, helper-seam-degrade, helper-dynamic-import, ax-tree-decode-iterative, version-constant-sync, capture-pipeline-architecture, validate-cursor-keyset.

## Decision
**Privacy ordering.** Deny-lists are checked FIRST — before any text extraction, hashing, or spool write; a match records only a tombstone. Built-in defaults (secret managers, etc.) are always checked in addition to user rules, and the first rule that fires wins. The live loop additionally runs deny preflight on the SNAPSHOT's own identity: a window retitled between the window facts and the tree read may now be deny-listed, and a legacy helper gives no window facts without the tree — so a deny-listed window is never OCR'd (the pipeline's own deny check runs only AFTER text extraction). If a window changes identity after the facts the deny list approved, and the retitled snapshot carries no URL, nothing is read and nothing is stored: a URL rule could not have run on it. Daemon-side redaction applies to snapshot text BEFORE it is hashed or written to the spool. Shared global regexes reset lastIndex between calls.

**Text and hashing.** Accessibility-tree text is extracted by walking the helper's JSON snapshot with every field treated as optional and unknown fields kept; decoding is iterative (no unbounded recursion). Snapshot hashes are SHA-256 over length-prefixed fields so control characters (including NUL) in captured text cannot make two distinct snapshots collide. Near-duplicate suppression uses 64-bit word-shingle SimHash keyed per (app, windowTitle) with last-STORED comparison; keys join with a NUL separator because app/title are arbitrary text and a printable delimiter could appear in them; the first snapshot of a window is always stored.

**Daemon security.** The daemon is loopback-only by default — capture is local-first; a host is loopback when only this machine can reach it, and binding a LAN address or 0.0.0.0 is refused. The spool (SQLite) and its WAL/SHM sidecars — which hold the same sensitive capture text — are kept owner-only (best effort where chmod is a no-op). The bearer token auto-generates 256-bit, stores 0600, and is created exclusively: if two daemons start together the loser gets EEXIST and reads the winner's token rather than both persisting divergent values. The pid file is the same atomic identity-bearing design as the audio daemon; it is removed only when it still records that pid, so a newer daemon's record is never deleted by a late shutdown. Operator-facing errors carry name + errno code only — never foreign message text or filesystem paths — in two authored error classes mirroring the audio package; the CLI's last-resort handler prints only already-sanitized errors. A custom spool parent is prepared (created 0700) WITHOUT clobbering an existing directory's mode, and a custom spool may live outside the base dir. The retention janitor prunes expired rows once on start so a long-idle spool does not grow unbounded; on stop, the capture loop and replay are cancelled and BOTH drained before the spool closes.

**Time and replay determinism.** Capture instants canonicalize to UTC `Z` so offset-bearing instants sort correctly under the keyset; date-only and offsetless timestamps are rejected, not guessed. Replay sorts by stable ascending capture order (tie: original index) so dedup is deterministic. The local-day window delegates to the core package's canonical DST-aware adapter — the previously inlined copy truncated historical LMT offsets (e.g. −05:47:04 became −05:47) and mis-bucketed captures; core signals caller-correctable date/timezone problems with RangeError. The replay wire parser is a faithful local re-implementation of the core HTTP source client, and the date formatter is a vendored local copy: this package deliberately stays standalone from the core runtime. The version constant reported by health is kept in sync with package.json by release tooling, and the endpoint tolerates drift.

**Scheduling.** The idle heartbeat anchors to the first poll after startup — not since epoch — or it would immediately preempt the settle window; and an idle heartbeat for an UNCHANGED foreground must never preempt a change still inside its settle window.

**Helper seam.** The actual screen reader is a platform-specific Swift binary shipped as a separate optional package; the seam bounds buffered helper stdout (guards a runaway child), imports it with a runtime-selected specifier (platform/arch-specific and absent on most hosts, so a static import is impossible), degrades honestly when it is missing, and sanitizes spawn errors to name + errno — never the spawn path. The CLI mirrors the audio CLI's runtime rules (config coercion throws with exit 1 rather than silently defaulting).

## Consequences
Deny-before-extraction means deny rules cannot inspect full text, only identity (app, title, URL) — a retitled sensitive window is protected only if its identity matches. Vendored copies of core helpers must be reconciled manually when core fixes land (the offset-truncation bug happened exactly this way). Owner-only modes are best effort on filesystems that ignore chmod.

## Origin comments
- `packages/capture-screen/src/axtree.ts:1` — "/** * Accessibility-tree text extraction. Walks a macOS AX-tree JSON snapshot and * concatenates the visible text, wit"
- `packages/capture-screen/src/capture.ts:1` — "/** * Capture-time processing pipeline (pure, hardware-free). A raw candidate — * frontmost app/window plus either an "
- `packages/capture-screen/src/capture.ts:85` — "/** * SHA-256 over length-prefixed fields so control characters (incl. NUL) in the * captured text cannot make two dis"
- `packages/capture-screen/src/cli-bin.ts:9` — "// Last-resort handler (runCapture already sanitizes its own errors). Print"
- `packages/capture-screen/src/cli.test.ts:110` — "// coerceNumber raises a config error (exit 1), matching the capture-audio CLI."
- `packages/capture-screen/src/cli.ts:1` — "/** * `remnic-capture-screen` CLI. Subcommands: * init | start | stop | status | install-service | logs | test-snapsho"
- `packages/capture-screen/src/cli.ts:205` — "/** * Prepare a custom --spool parent WITHOUT clobbering an existing directory's * mode. Absent → create a dedicated 0"
- `packages/capture-screen/src/cli.ts:290` — "/** * Run replay ingestion as a supervised task AFTER the daemon is ready. Never * throws: success/failure is surfaced"
- `packages/capture-screen/src/cli.ts:416` — "// A custom --spool may live outside base-dir; prepare its parent (create 0700"
- `packages/capture-screen/src/cli.ts:421` — "// Retention janitor: prune expired rows once on start so a long-idle spool is"
- `packages/capture-screen/src/cli.ts:477` — "// Stop the capture loop and cancel replay, then drain BOTH before closing"
- `packages/capture-screen/src/coerce.ts:1` — "/** * Config-layer coercion. Every helper THROWS on an unrecognized value (never * silently defaults); callers apply d"
- `packages/capture-screen/src/constants.ts:3` — "/** * Reported by GET /v1/health. Kept in sync with package.json by the release * tooling; the health endpoint tolerat"
- `packages/capture-screen/src/constants.ts:10` — "/** Loopback default; capture is local-first (charter). */"
- `packages/capture-screen/src/control.ts:1` — "/** * Daemon process control: an atomic, identity-bearing pid file plus liveness * probing. * * The pid file is JSON `"
- `packages/capture-screen/src/control.ts:101` — "/** * Remove the pid file only when it still records `pid`. Prevents a late * shutdown or `stop` from deleting a NEWER"
- `packages/capture-screen/src/daemon.ts:1` — "/** * Loopback-only HTTP daemon. Serves the spool over three read-only routes: * * GET /v1/health → liveness + capture"
- `packages/capture-screen/src/daywindow.test.ts:47` — "// Read the local wall clock and offset through Intl so the historical-LMT"
- `packages/capture-screen/src/daywindow.test.ts:72` — "// Regression for #2821: capture-screen's inlined copy truncated offsets to"
- `packages/capture-screen/src/daywindow.test.ts:92` — "// Regression for #2821: the inlined copy truncated the −05:47:04 LMT to"
- `packages/capture-screen/src/daywindow.ts:1` — "/** * DST-aware local-day window — thin adapter over @remnic/core's canonical * `activityDayWindow` (issue #2821). cap"
- `packages/capture-screen/src/daywindow.ts:19` — "// core signals caller-correctable date/timezone problems with RangeError;"
- `packages/capture-screen/src/dedup.ts:1` — "/** * Per-window near-duplicate suppression. Keyed by (app, windowTitle): for each * window we remember the last STORE"
- `packages/capture-screen/src/dedup.ts:32` — "// NUL separator: app/title are arbitrary text, so a printable delimiter"
- `packages/capture-screen/src/dedup.ts:42` — "/** * Decide whether a snapshot should be stored, updating the cache when it is. * First snapshot of a window always s"
- `packages/capture-screen/src/denylist.ts:1` — "/** * Capture-time deny-lists, checked FIRST — before any text extraction, hashing, * or spool write. A match records "
- `packages/capture-screen/src/denylist.ts:10` — "/** Secret managers whose windows must never be captured. */"
- `packages/capture-screen/src/denylist.ts:58` — "/** * The first deny rule that fires for this candidate, or null. Built-in defaults * are always checked in addition t"
- `packages/capture-screen/src/errors.ts:1` — "/** * Error taxonomy for @remnic/capture-screen. * * Two authored-message classes, mirroring @remnic/capture-a"
- `packages/capture-screen/src/helper.ts:1` — "/** * Native-helper seam. The actual screen reader is a platform Swift binary * shipped separately as `@remnic"
- `packages/capture-screen/src/helper.ts:28` — "/** Max helper stdout we will buffer (guards a runaway child). */"
- `packages/capture-screen/src/helper.ts:71` — "// Runtime-selected specifier: the helper package is platform/arch-specific"
- `packages/capture-screen/src/helper.ts:72` — "// and absent on most hosts, so a static import is impossible here."
- `packages/capture-screen/src/helper.ts:120` — "// Sanitize: name + errno only, never the spawn path."
- `packages/capture-screen/src/helper.ts:216` — "/** * One AX node as the helper prints it, checked on its own: every field is optional, unknown fields are kep"
- `packages/capture-screen/src/live.ts:1` — "/** * Live capture cycle: one window captured through the native helper and run * through the processing pipel"
- `packages/capture-screen/src/live.ts:73` — "// The window changed identity after the facts the deny list approved. The retitled snapshot"
- `packages/capture-screen/src/live.ts:74` — "// carries no URL, so a URL rule could not run on it; read nothing and store nothing."
- `packages/capture-screen/src/live.ts:100` — "// Deny preflight on the snapshot's own identity: the window may have been"
- `packages/capture-screen/src/live.ts:101` — "// retitled between the window facts and the tree read, and a legacy helper"
- `packages/capture-screen/src/live.ts:102` — "// gives no window facts without the tree. Never OCR a deny-listed window;"
- `packages/capture-screen/src/live.ts:103` — "// process() applies deny too, but only AFTER text extraction."
- `packages/capture-screen/src/redact.ts:1` — "/** * Daemon-side redaction, applied to snapshot text BEFORE it is hashed or * written to the spool. Built-in "
- `packages/capture-screen/src/redact.ts:57` — "// Reset lastIndex: a shared global RegExp carries state between calls."
- `packages/capture-screen/src/replay.test.ts:20` — "/** * Faithful re-implementation of @remnic/core's ActivityHttpSourceClient wire * parser (packages/remnic-cor"
- `packages/capture-screen/src/replay.ts:65` — "// Canonicalize to UTC (Z) so an offset instant sorts correctly under the keyset."
- `packages/capture-screen/src/replay.ts:136` — "// Stable ascending capture order (tie: original index) — deterministic dedup."
- `packages/capture-screen/src/scheduler.ts:105` — "// Anchor the idle heartbeat to the first poll so the fallback measures from"
- `packages/capture-screen/src/scheduler.ts:106` — "// startup, not since epoch — otherwise it would preempt the settle window."
- `packages/capture-screen/src/scheduler.ts:120` — "// Idle is a heartbeat for an UNCHANGED foreground; it must not preempt a"
- `packages/capture-screen/src/scheduler.ts:121` — "// change that is still inside its settle window."
- `packages/capture-screen/src/simhash.ts:1` — "/** * 64-bit word-shingle SimHash for near-duplicate screen-text detection. * Text is lower-cased and tokenize"
- `packages/capture-screen/src/spool.ts:123` — "/** * Validate + canonicalize a capture instant to UTC `Z`. Date-only strings and * offsetless timestamps are "
- `packages/capture-screen/src/spool.ts:157` — "// Screen-capture history is sensitive; keep the spool owner-only (best"
- `packages/capture-screen/src/spool.ts:158` — "// effort; ignored where chmod is a no-op)."
- `packages/capture-screen/src/spool.ts:161` — "// WAL mode writes <location>-wal / <location>-shm sidecars that hold the"
- `packages/capture-screen/src/spool.ts:162` — "// same sensitive capture text; keep them owner-only too (best effort)."
- `packages/capture-screen/src/token.ts:1` — "/** * Bearer-token lifecycle. The daemon auto-generates a 256-bit token on first * use and stores it 0600; a p"
- `packages/capture-screen/src/token.ts:27` — "// Exclusive create: if two daemons start together, the loser gets EEXIST and"
- `packages/capture-screen/src/token.ts:28` — "// reads the winner's token rather than both persisting divergent values."
- `packages/capture-screen/src/util.ts:3` — "/** * Format a Date as YYYY-MM-DD in the given IANA timezone. Local copy of the * pipeline helper — capture-sc"
- `packages/capture-screen/src/util.ts:33` — "/** * A host is loopback when it can only be reached from this machine. Binding * anything else (a LAN address"
- `packages/capture-screen/src/util.ts:59` — "/** * Operator-safe error description — name + errno code only, never foreign * message text or filesystem pat"
- `packages/capture-screen/src/validate.ts:1` — "/** * Request-input validation for the HTTP surface. Every failure raises * CaptureInputError, which the daemo"
