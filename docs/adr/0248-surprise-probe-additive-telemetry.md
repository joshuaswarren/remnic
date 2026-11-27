# The surprise probe is additive-only, soft-failing, and fully observed: it can promote flushing, never suppress or stall it

Status: accepted

## Context
A D-MEM-style novelty probe scores turns to decide whether to flush early (#563). It depends on an external embedder that can hang, return non-numeric garbage, or throw non-Errors, and its threshold must be tuned from real traffic. An early design would have let a slow probe prevent persistence and let a probe verdict override explicit operator modes.

## Decision
The probe is a promoter with a hard ceiling of influence: (1) it only ever promotes keep_buffering to extract_now — if the trigger rules already say flush, surprise must not demote it; enabling surprise cannot reduce extraction frequency; if the probe is disabled, unavailable, or below threshold, the existing decision stands; novelty scoring runs only in smart mode — every_n and time_based are explicit operator choices and are never overridden; (2) the probe runs outside the mutation lock (no reentrancy deadlocks) under a soft timeout raced against the probe; a timeout is "probe unavailable, fall through", never a surfaced error, so a hung embedder cannot stall addTurn before save; (3) scores are clamped at every boundary — empty corpus is maximally surprising (novelty by default: an empty recent-memory buffer is the clearest case of "no basis to call this redundant"), missing similarities are maximally surprising rather than NaN, cosine is clamped per pair, and a misbehaving probe cannot inject an out-of-range value into the threshold comparison; candidate embeddings run in parallel so a slow embedder does not serialize the pass, and rejections propagate to the caller; (4) telemetry records EVERY scored turn, triggering or not — below-threshold scores are required to fit the threshold to real distributions; rows are fire-and-forget (addTurn never awaits the ledger append) but serialized through a promise chain so appends settle in wall-clock order; each row snapshots the decision-time timestamp and the threshold actually used, so write-chain backpressure or a concurrent config change cannot retroactively shift what the row claims; only the needed fields are queued (never the full turn content) so a backed-up chain cannot retain large strings; (5) the report path treats `triggeredFlush` as a strict boolean — a string "false" from an upstream JSON bug must not count as triggered and inflate the rate; the "current" threshold shown is the one the most recent rows were judged against (from the ledger, not current config), percentiles use nearest-rank for stable small windows; (6) non-Error rejections (throw null, reject("x")) are described safely — the telemetry helper must never itself throw, and a non-Error on the add path is surfaced as a bug rather than swallowed; (7) boolean config flags accept the literal string "true" from parseConfig — a strict ===true would silently drop the operator's intent; the disabled-control seam proves counting does not touch the buffer; the mock embedder returns defensive copies so callers cannot observe mutations across calls.

## Consequences
Surprise can only increase flush frequency, so miscalibration costs extra extractions, never lost buffering. The fire-and-forget ledger can lag or back up on slow filesystems; ordering is guaranteed but durability of the last rows is not. Strict typing on report fields trades tolerance for honesty — malformed rows must be fixed at the source. Operators tuning thresholds read the ledger's threshold, which may differ from the live config.

## Origin comments
### triggered-flush-strict-boolean
- `packages/remnic-core/src/buffer-surprise-report.ts:93` — "// `triggeredFlush` must be a real boolean — not a string or other"
- `packages/remnic-core/src/buffer-surprise-report.ts:94` — "// truthy value. A row with `triggeredFlush: "false"` (string from a"
- `packages/remnic-core/src/buffer-surprise-report.ts:95` — "// JSON-parsing bug upstream) would otherwise be counted as"
- `packages/remnic-core/src/buffer-surprise-report.ts:96` — "// triggered, inflating the rate and misleading operators tuning the"
- `packages/remnic-core/src/buffer-surprise-report.ts:97` — "// threshold from real traffic."
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:574` — "// A row with `triggeredFlush: "false"` (string) is truthy in"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:575` — "// JavaScript. Without strict type-checking, it would be counted as"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:576` — "// triggered and silently inflate the rate reported to operators."

### nearest-rank-percentiles
- `packages/remnic-core/src/buffer-surprise-report.ts:130` — "// Nearest-rank percentiles keep the output stable for small windows."

### current-threshold-from-ledger
- `packages/remnic-core/src/buffer-surprise-report.ts:134` — "// "Current" threshold is whichever was in force for the most recent row"
- `packages/remnic-core/src/buffer-surprise-report.ts:135` — "// — not necessarily the one configured right now, but the value the"
- `packages/remnic-core/src/buffer-surprise-report.ts:136` — "// ledger rows were judged against. That's what operators need to reason"
- `packages/remnic-core/src/buffer-surprise-report.ts:137` — "// about the distribution."

### surprise-telemetry-records-all
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:107` — "// The whole point of telemetry is tuning the threshold from real"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:108` — "// distributions, so below-threshold scores must also be recorded."

### surprise-probe-additive-only
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:199` — "// Additive invariant: existing batch flush does not consult the probe."
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:229` — "// If the turn-count rule already says flush, surprise must not demote to"
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:230` — "// keep_buffering. Documented as additive-only in buffer.ts."

### telemetry-ordered-appends
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:221` — "// Reviewer concern: fire-and-forget appends could settle out of"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:222` — "// order on slow filesystems. Simulate this with a storage double"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:223` — "// whose append latency decreases with each call via microtask"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:224` — "// hops — without serialization, the later appends would land first."
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:225` — "// Using microtask chains instead of setTimeout keeps the test"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:226` — "// deterministic and does not leak timers into the node:test teardown."
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:236` — "// First append hops the microtask queue more times than later"
- `packages/remnic-core/src/buffer-surprise-telemetry.test.ts:237` — "// ones, mimicking variable latency deterministically."

### surprise-smart-mode-only
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:259` — "// D-MEM-style novelty only makes sense inside the smart decision tree."
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:260` — "// `every_n` / `time_based` are explicit operator choices — do not override."

### boolean-config-coercion
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:400` — "// `--config bufferSurpriseTriggerEnabled=true` passes the literal"
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:401` — "// string "true" through parseConfig. The strict `=== true` form would"
- `packages/remnic-core/src/buffer-surprise-trigger.test.ts:402` — "// leave the flag off and silently drop the operator's intent."

### surprise-mock-embedder-purity
- `packages/remnic-core/src/buffer-surprise.test.ts:47` — "// Defensive copy so callers can't see mutations across calls."

### surprise-embeddings-parallel
- `packages/remnic-core/src/buffer-surprise.ts:128` — "// Embed the turn and every candidate. Rejections propagate — that's the"
- `packages/remnic-core/src/buffer-surprise.ts:129` — "// caller's decision to handle. Run candidate embeddings in parallel so a"
- `packages/remnic-core/src/buffer-surprise.ts:130` — "// slow embedder does not serialize the whole pass."

### surprise-score-defensive-guards
- `packages/remnic-core/src/buffer-surprise.ts:147` — "// Defensive — with `candidates.length >= 1` and `kClamped >= 1`, we"
- `packages/remnic-core/src/buffer-surprise.ts:148` — "// should always have at least one similarity. If we somehow do not,"
- `packages/remnic-core/src/buffer-surprise.ts:149` — "// treat as maximally surprising rather than returning NaN."
- `packages/remnic-core/src/buffer-surprise.ts:158` — "// Numerical safety: clamp the final value. Cosine is clamped to [0, 1]"
- `packages/remnic-core/src/buffer-surprise.ts:159` — "// per-pair already, so the mean cannot escape that range under normal"
- `packages/remnic-core/src/buffer-surprise.ts:160` — "// arithmetic, but floating-point drift is cheap to guard against."
- `packages/remnic-core/src/buffer.ts:860` — "// Defensive clamp: formula lives in buffer-surprise.ts, but we never"
- `packages/remnic-core/src/buffer.ts:861` — "// want a misbehaving probe to inject an out-of-range value into the"
- `packages/remnic-core/src/buffer.ts:862` — "// threshold comparison."

### probe-outside-mutation-lock
- `packages/remnic-core/src/buffer.ts:585` — "/** Run probes outside the mutation lock to avoid reentrancy deadlocks. */"

### surprise-additive-only
- `packages/remnic-core/src/buffer.ts:594` — "// Surprise-gated flush (issue #563). Additive only: if the probe is"
- `packages/remnic-core/src/buffer.ts:595` — "// disabled, unavailable, or the score is below threshold, the decision"
- `packages/remnic-core/src/buffer.ts:596` — "// from the existing trigger logic stands. The probe only ever *promotes*"
- `packages/remnic-core/src/buffer.ts:597` — "// `keep_buffering` → `extract_now`; it never suppresses an existing"
- `packages/remnic-core/src/buffer.ts:598` — "// flush. This preserves the invariant that enabling surprise cannot"
- `packages/remnic-core/src/buffer.ts:599` — "// *reduce* extraction frequency."
- `packages/remnic-core/src/buffer.ts:604` — "// Matching the existing "smart" branch: surprise is a lower-tier"
- `packages/remnic-core/src/buffer.ts:605` — "// novelty signal that should not second-guess a high-signal hit"
- `packages/remnic-core/src/buffer.ts:606` — "// (which already flushes) or fight `every_n` / `time_based` modes."

### surprise-flush-durability
- `packages/remnic-core/src/buffer.ts:627` — "// Issue #1909 (review): the record mutation for a `keep_buffering`"
- `packages/remnic-core/src/buffer.ts:628` — "// turn only SCHEDULED a debounced save. Surprise now promotes it to"
- `packages/remnic-core/src/buffer.ts:629` — "// extract_now AFTER that mutation, so force the buffer durable before"
- `packages/remnic-core/src/buffer.ts:630` — "// the caller runs extraction — otherwise state/buffer.json lags the"
- `packages/remnic-core/src/buffer.ts:631` — "// extracted turns by up to the debounce window on a crash. Safe to"
- `packages/remnic-core/src/buffer.ts:632` — "// await here: we are outside the record mutation (deadlock-free)."
- `packages/remnic-core/src/buffer.ts:633` — "// throwOnFailure (round 7 finding 5): match the built-in extract"
- `packages/remnic-core/src/buffer.ts:634` — "// triggers — a failed durability write must NOT silently proceed to"
- `packages/remnic-core/src/buffer.ts:635` — "// extract_now on a non-durable turn."

### surprise-telemetry-write-chain
- `packages/remnic-core/src/buffer.ts:643` — "// Emit telemetry on every scored turn — both triggering and"
- `packages/remnic-core/src/buffer.ts:644` — "// non-triggering — so operators can fit the threshold to real"
- `packages/remnic-core/src/buffer.ts:645` — "// traffic distributions. Fire-and-forget: `addTurn` does NOT"
- `packages/remnic-core/src/buffer.ts:646` — "// await the ledger append, so slow/contended filesystems cannot"
- `packages/remnic-core/src/buffer.ts:647` — "// add JSONL-append latency to every `processTurn`. But we DO"
- `packages/remnic-core/src/buffer.ts:648` — "// serialize writes through a promise chain so concurrent"
- `packages/remnic-core/src/buffer.ts:649` — "// appends settle in wall-clock order — the report path assumes"
- `packages/remnic-core/src/buffer.ts:650` — "// chronological tail rows and reads the most recent as the"
- `packages/remnic-core/src/buffer.ts:651` — "// "current" threshold."
- `packages/remnic-core/src/buffer.ts:652` — "//"
- `packages/remnic-core/src/buffer.ts:653` — "// Project only the fields we need into the queue entry rather"
- `packages/remnic-core/src/buffer.ts:654` — "// than capturing the full `BufferTurn` — under slow filesystem"
- `packages/remnic-core/src/buffer.ts:655` — "// latency the chain can back up, and we must not retain the"
- `packages/remnic-core/src/buffer.ts:656` — "// (potentially large) `turn.content` string for every pending"
- `packages/remnic-core/src/buffer.ts:657` — "// append."

### telemetry-decision-time-snapshot
- `packages/remnic-core/src/buffer.ts:666` — "// Stamp at decision time so backpressure on the write chain"
- `packages/remnic-core/src/buffer.ts:667` — "// does not shift the event's apparent moment away from when"
- `packages/remnic-core/src/buffer.ts:668` — "// the turn was actually scored."
- `packages/remnic-core/src/buffer.ts:670` — "// Snapshot the threshold used to compute `triggered` so a"
- `packages/remnic-core/src/buffer.ts:671` — "// concurrent config mutation cannot retroactively change"
- `packages/remnic-core/src/buffer.ts:672` — "// what the ledger row claims the decision was against."
- `packages/remnic-core/src/buffer.ts:800` — "// Use the decision-time stamp captured when the event was"
- `packages/remnic-core/src/buffer.ts:801` — "// queued, NOT `Date.now()` here — backpressure on the write"
- `packages/remnic-core/src/buffer.ts:802` — "// chain could otherwise shift timestamps into the future relative"
- `packages/remnic-core/src/buffer.ts:803` — "// to when the turn was scored."

### telemetry-nonerror-guard
- `packages/remnic-core/src/buffer.ts:819` — "// Same guard as `computeSurpriseSafe`: non-Error rejections must"
- `packages/remnic-core/src/buffer.ts:820` — "// not crash the telemetry helper, which would defeat the whole"
- `packages/remnic-core/src/buffer.ts:821` — "// point of isolating the ledger write from the hot path."
- `packages/remnic-core/src/buffer.ts:867` — "// `err` may be any thrown value — `throw null` and"
- `packages/remnic-core/src/buffer.ts:868` — "// `Promise.reject("x")` are both legal. Accessing `.message` on a"
- `packages/remnic-core/src/buffer.ts:869` — "// non-Error would itself throw and defeat the failure-isolation"
- `packages/remnic-core/src/buffer.ts:870` — "// contract, so describe the value safely."

### probe-timeout-soft-bound
- `packages/remnic-core/src/buffer.ts:842` — "// Hard timeout around the probe so a hung embedder cannot stall"
- `packages/remnic-core/src/buffer.ts:843` — "// `addTurn()` before `save()`. A slow probe would otherwise"
- `packages/remnic-core/src/buffer.ts:844` — "// prevent the just-appended turn from ever being persisted. The"
- `packages/remnic-core/src/buffer.ts:845` — "// timeout is a soft bound — we race it against the probe, take"
- `packages/remnic-core/src/buffer.ts:846` — "// whichever settles first, and treat the timeout as"
- `packages/remnic-core/src/buffer.ts:847` — "// "probe unavailable, fall through" rather than an error that"
- `packages/remnic-core/src/buffer.ts:848` — "// surfaces to the caller."
