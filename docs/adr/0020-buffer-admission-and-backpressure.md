# Admission refuses at capacity and never evicts accepted work; caps bound entries and sessions, buffered turn data is never the release valve

Status: accepted

## Context
Buffers grow without bound during provider outages: failed extractions keep their turns for retry, and a busy backlog worker can starve live captures. Early policies ("never prune non-empty entries", a fixed 200-session cap) either OOMed the daemon or dropped live captures at busy hours (#3303, w9C). The tension: never lose buffered or accepted content, yet never grow unbounded.

## Decision
Bound the structure, not the data: (1) admission is atomic and refuses at capacity — accepted captures exit via refusal/backpressure, never eviction, and the refusal happens before acceptance so accepted-capture non-eviction holds; (2) backlog is active turns OR retained retry turns — only an entry holding neither is empty; empty entries are evicted first, already-admitted sessions keep buffering, and a NEW session is refused (retryable backpressure) when non-empty backlog fills the entry cap; (3) the session-entry cap bounds entry COUNT only; because retained failed turns can exceed it inside one entry, a second per-session retained-turn cap refuses new turns for a full session while healthy sessions keep admitting; the per-session cap sits far above the extraction trigger so healthy sessions never touch it, covers direct constructions predating the knob, and fails closed (cap 0 refuses rather than admits one turn); (4) the default session cap leaves enough headroom that live captures survive a backlog drain (raised from 200 in #3303); parseConfig defaults, validates, and floors it at the I/O boundary, with a fallback for pre-knob configs; (5) config parsing rejects invalid user input explicitly (no flooring fractions, no clamping negatives to 0 or oversized values to a timer max); (6) the per-turn mutation retains snapshots lazily rather than building priorTurns + activeTurnsSnapshot eagerly.

## Consequences
A sustained outage fills the caps and new sessions/turns are refused until extraction drains — callers must treat admission refusal as retryable backpressure. Raising the default session cap trades memory headroom for fewer busy-hour refusals. Direct constructions bypass parseConfig, so caps are re-checked defensively at use sites.

## Origin comments
### buffer-eviction-invariants
- `packages/remnic-core/src/buffer-eviction-backpressure.test.ts:88` — "// Accepted captures are subject to the same no-backlog-loss limit: refusal"
- `packages/remnic-core/src/buffer-eviction-backpressure.test.ts:89` — "// happens before acceptance, preserving accepted-capture non-eviction."
- `packages/remnic-core/src/buffer-eviction.ts:8` — "/** Accepted captures exit via refusal/backpressure, never eviction (#3251). */"
- `packages/remnic-core/src/buffer-eviction.ts:37` — "// Backlog = active turns OR retained retry turns (#1908); only an entry"
- `packages/remnic-core/src/buffer-eviction.ts:38` — "// holding neither counts as empty."

### buffer-session-cap-admission
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:168` — "// Clear one persisted entry to make it genuinely empty. Accepted-capture"
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:169` — "// admission may reclaim this slot, but never a session with buffered turns."
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:189` — "// w9C: live session captures were dropped when the extraction worker was busy"
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:190` — "// on a backlog doc and the 200-session default cap refused new sessions. The"
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:191` — "// default must leave enough headroom that live captures survive a backlog."
- `packages/remnic-core/src/buffer-incremental-persistence.test.ts:291` — "// Cap lowered below the accepted backlog: admission must refuse without dropping native work."
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:114` — "// Refusal: session-entry cap — accepted-capture entries are pinned, so a"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:115` — "// new live session beyond the cap throws (the implicit "default" entry is"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:116` — "// protected too, hence cap 3 for 2 pins)."

### snapshot-retention-lazy-copy
- `packages/remnic-core/src/buffer-record-snapshots.test.ts:2` — "/** * recordTurnUnlocked snapshot retention — issue: the per-turn mutation built * `priorTurns` + `activeTurnsSnapshot` "

### per-session-turn-cap
- `packages/remnic-core/src/buffer-session-cap.ts:1` — "/** Per-session retained-turn cap (#3415 bound). Split from buffer.ts (1200-line ratchet). */"
- `packages/remnic-core/src/buffer-session-cap.ts:5` — "// Far above the extraction trigger (bufferMaxTurns, default 5), so healthy"
- `packages/remnic-core/src/buffer-session-cap.ts:6` — "// sessions never touch it. Covers direct constructions predating the knob."
- `packages/remnic-core/src/buffer-session.test.ts:730` — "// A sustained outage with retention on keeps every failed turn. The"
- `packages/remnic-core/src/buffer-session.test.ts:731` — "// session-entry cap does not bound turns inside one entry, so a second"
- `packages/remnic-core/src/buffer-session.test.ts:732` — "// cap refuses new turns for a full session (retryable backpressure) while"
- `packages/remnic-core/src/buffer-session.test.ts:733` — "// a healthy session keeps admitting."
- `packages/remnic-core/src/buffer-session.test.ts:787` — "// A hand-built config can carry cap 0 (parseConfig itself rejects it, but"
- `packages/remnic-core/src/buffer-session.test.ts:788` — "// direct constructions must still fail closed rather than admit one turn)."

### buffer-entry-cap-backpressure
- `packages/remnic-core/src/buffer-session.test.ts:646` — "// Pre-#1908 this contract was "never prune non-empty entries". With retry"
- `packages/remnic-core/src/buffer-session.test.ts:647` — "// retention (failed extractions keep their turns), unbounded non-empty"
- `packages/remnic-core/src/buffer-session.test.ts:648` — "// growth during a provider outage would eventually OOM the daemon — the"
- `packages/remnic-core/src/buffer-session.test.ts:649` — "// documented policy (#1908 step 7) bounds the ENTRY COUNT, not by dropping"
- `packages/remnic-core/src/buffer-session.test.ts:650` — "// buffered turns: a NEW session is refused (retryable backpressure) when"
- `packages/remnic-core/src/buffer-session.test.ts:651` — "// only non-empty backlog fills the cap. Empty entries are still evicted"
- `packages/remnic-core/src/buffer-session.test.ts:652` — "// first, and already-admitted sessions keep buffering."
- `packages/remnic-core/src/buffer-session.test.ts:698` — "// Retained failed extractions keep their turns in the buffer, so during a"
- `packages/remnic-core/src/buffer-session.test.ts:699` — "// provider outage non-empty entries can exceed MAX_BUFFER_ENTRY_COUNT (200)."
- `packages/remnic-core/src/buffer-session.test.ts:700` — "// The cap is still the documented bound: buffered turn data is never the"
- `packages/remnic-core/src/buffer-session.test.ts:701` — "// release valve — a NEW session is refused (retryable backpressure) until"
- `packages/remnic-core/src/buffer-session.test.ts:702` — "// extraction drains an entry, so the daemon cannot OOM on unbounded growth"
- `packages/remnic-core/src/buffer-session.test.ts:703` — "// and no buffered turn is dropped (codex review)."

### parse-config-strict-validation
- `packages/remnic-core/src/buffer-session.test.ts:993` — "// Review round 8: reject invalid user input explicitly instead of silently"
- `packages/remnic-core/src/buffer-session.test.ts:994` — "// flooring fractions / clamping negatives to 0 / clamping oversized to the"
- `packages/remnic-core/src/buffer-session.test.ts:995` — "// timer max (AGENTS.md #1/#39)."

### buffer-types-file-split
- `packages/remnic-core/src/buffer-types.ts:1` — "/** Types split out of buffer.ts (structural ratchet, issue #1995). */"

### buffer-max-sessions-3303
- `packages/remnic-core/src/buffer.ts:49` — "// Raised from 200 in #3303: live captures were being dropped at busy hours"
- `packages/remnic-core/src/buffer.ts:50` — "// while the single extraction worker drained a backlog."
- `packages/remnic-core/src/buffer.ts:134` — "// parseConfig defaults, validates, and floors bufferMaxSessions at the I/O"
- `packages/remnic-core/src/buffer.ts:135` — "// boundary; FALLBACK_MAX_BUFFER_SESSIONS covers direct constructions with"
- `packages/remnic-core/src/buffer.ts:136` — "// configs from before the knob existed."

### admit-refuse-not-evict
- `packages/remnic-core/src/buffer.ts:493` — "/** Admit atomically; refuse at capacity rather than evict accepted work. */"
