# Session delta state advances only on trustworthy git results, and only for write-capable principals

Status: accepted

## Context
The session delta compares a repo against a persisted head marker. Force-pushes, transient git failures, corrupt state files, and read-only callers could silently advance (or freeze) a baseline — including another principal's.

## Decision
- Git exit code 128 ("bad revision" / object not found) means the prior head is genuinely unreachable (force-push/rebase erased it): return an empty slice labeled `unreachable_head` and ADVANCE the state marker so the next call uses the new head as its baseline. Other non-zero codes (127 spawn failure/timeout, 129+ signals, etc.) are TRANSIENT — the old head is probably still valid: return `git_failed`, do NOT advance, and let the next session retry. Zero commits despite a head change is also tagged unreachable-head, never a crash (rule 34).
- Handler flow: a resolved coding context (rootPath, the repo root the context came from) MUST exist — projectId is only a path hint; refresh is the caller's responsibility. Namespaces resolve through the SAME coding-scoped resolver the service uses. The subcommand switch (`get` today) keeps the shape forward-compatible for refresh/reset. On git failure, advance the state best-effort only when the head was readable; on `no_head` leave the prior marker. A malformed persisted timestamp degrades to the raw string instead of crashing the render.
- The state-marker write is gated on a write-capable principal (`canAdvanceState`, default true so legacy callers keep pre-fix behavior): a read-only caller receives the computed delta but does NOT advance the marker, so it cannot move another principal's baseline. Persisting the new state is best-effort (rule 25/54): failures are logged and surface in doctor/xray but do not fail the operation — the delta was computed and the next session may re-derive it. Unchanged slices short-circuit before the log call (saves a git invocation). git log runs with `--reverse` (oldest-first, so capCommits' slice(-max) keeps the NEWEST commits) and uses the ASCII unit separator (`\x1f`) as the field separator — NUL is ideal but awkward in argv, and `\x1f` is rejected by sanitize if it ever leaks into memory content.

## Consequences
- Best-effort marker writes can cause one repeated delta after a write failure — preferred over failing a computed delta. Transient git errors freeze the baseline until a clean run, by design.

## Origin comments
- `packages/remnic-core/src/coding/session-delta-surfaces.test.ts:547` — "// Legacy callers that don't set canAdvanceState keep pre-fix behavior:"
- `packages/remnic-core/src/coding/session-delta-surfaces.test.ts:548` — "// the marker advances. This protects the existing surface contract."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:134` — "/** * The resolved namespace context the handler needs. The service produces * this through the SAME coding-scoped re"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:154` — "/** * Dependencies the handler borrows from the service. The service constructs * this context per call; the handler "
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:200` — "// `get` is the only subcommand today; the switch keeps the shape forward-"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:201` — "// compatible if `refresh`/`reset` land later."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:223` — "// 2. Resolve the current repo slice. `rootPath` is the repo root the"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:224` — "// coding context was resolved from; it MUST exist for a delta to make"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:225` — "// sense. Fall back to `projectId` only as a path hint — refresh is the"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:226` — "// caller's responsibility (the gate already required a context)."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:234` — "// 3. Git failure → tagged failure, but advance the state file when we"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:235` — "// could at least read the current head (so the next call has a chance)."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:240` — "// Best-effort: still try to advance the state file if the head was readable."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:241` — "// On `no_head` we cannot write anything sensible — leave the prior marker."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:253` — "// 5. Persist the new state (rule 25 + rule 54). Failures here are logged"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:254` — "// but do NOT fail the operation — the delta was computed; the next"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:255` — "// session may re-derive it. A write failure surfaces in doctor/xray."
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:256` — "//"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:257` — "// Issue #1630 fix 2: the marker write is gated on a write-capable"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:258` — "// principal. A read-only caller (e.g. read-but-not-write on the shared"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:259` — "// namespace) receives the computed delta but does NOT advance the state"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:260` — "// marker, so it cannot move another principal's baseline. The default"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:261` — "// is `true` so legacy callers and the surface contract tests keep their"
- `packages/remnic-core/src/coding/session-delta-surfaces.ts:262` — "// pre-fix behavior."
- `packages/remnic-core/src/coding/session-delta.ts:154` — "// If the slice reports zero commits despite a head change, the prior head"
- `packages/remnic-core/src/coding/session-delta.ts:155` — "// is unreachable (force-push/rebase erased it). Tagged failure, never a crash."
- `packages/remnic-core/src/coding/session-delta.ts:233` — "// Defensive: if the stored timestamp is malformed, fall back to the raw"
- `packages/remnic-core/src/coding/session-delta.ts:234` — "// string rather than crashing the delta render (rule 34 — never crash on"
- `packages/remnic-core/src/coding/session-delta.ts:235` — "// persisted state corruption)."
- `packages/remnic-core/src/coding/session-delta.ts:370` — "// Unchanged — short-circuit before the log call (saves a git invocation)."
- `packages/remnic-core/src/coding/session-delta.ts:375` — "// Use a unique ASCII separator unlikely to appear in commit subjects or"
- `packages/remnic-core/src/coding/session-delta.ts:376` — "// paths. NUL would be ideal but is awkward to pass through argv; unit"
- `packages/remnic-core/src/coding/session-delta.ts:377` — "// separator (\x1f) is the next-best thing and is rejected by sanitize if"
- `packages/remnic-core/src/coding/session-delta.ts:378` — "// it ever leaks into memory content."
- `packages/remnic-core/src/coding/session-delta.ts:380` — "// --reverse makes git emit oldest-first, so the commits array reads in"
- `packages/remnic-core/src/coding/session-delta.ts:381` — "// chronological order and capCommits' slice(-max) keeps the NEWEST entries"
- `packages/remnic-core/src/coding/session-delta.ts:382` — "// (the ones a returning agent cares about). Without --reverse, git log is"
- `packages/remnic-core/src/coding/session-delta.ts:383` — "// newest-first and slice(-max) would drop exactly the commits we want."
- `packages/remnic-core/src/coding/session-delta.ts:392` — "// Exit code 128 is git's "bad revision" / "object not found" — the prior"
- `packages/remnic-core/src/coding/session-delta.ts:393` — "// head is genuinely unreachable (force-push/rebase erased it). Return an"
- `packages/remnic-core/src/coding/session-delta.ts:394` — "// empty slice so the differ labels it `unreachable_head`; the state marker"
- `packages/remnic-core/src/coding/session-delta.ts:395` — "// advances so the next call sees the new head as the baseline."
- `packages/remnic-core/src/coding/session-delta.ts:399` — "// Other non-zero exit codes (127 = spawn failure / 2s timeout, 129+ ="
- `packages/remnic-core/src/coding/session-delta.ts:400` — "// signal, etc.) are TRANSIENT — the old head is probably still valid. Do"
- `packages/remnic-core/src/coding/session-delta.ts:401` — "// NOT treat these as unreachable and do NOT let the caller advance the"
- `packages/remnic-core/src/coding/session-delta.ts:402` — "// state marker. Return `git_failed` so the surface preserves the old"
- `packages/remnic-core/src/coding/session-delta.ts:403` — "// marker and the next session retries."
