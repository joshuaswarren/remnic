# Buffer-ingress counters are observation-only, identity-memoized, and capped — they change nothing the buffer does

Status: accepted

## Context
Issue #3444 wanted visibility into turn ingress outcomes without perturbing the hot path. Counting naively could retain turn content forever (a leak), miscount duplicates after arrays are replaced, or grow unbounded on pathological configs. An observation layer that changes behavior is worse than none.

## Decision
Counters observe and never act: (1) the counters change nothing the buffer does — accepted + filtered + refused == turns offered is the pinned invariant, with acceptedExactDuplicate an observational sub-count of accepted and `filtered` reserved for turns existing code drops; logging is zero-noise and process-local, one instance per buffer; (2) counting is O(1) amortized per turn: duplicate detection hashes role+content to a sha256 digest, and memo validity is the entry's ARRAY IDENTITY (WeakRef-compared) — after clearAfterExtraction replaces the entry arrays, old arrays must not stay reachable through the memo, and deref-compare keeps validity exact without retaining evicted turn content; (3) `observe` is called BEFORE the buffer push so a lazily rebuilt digest memo can only flag turns already in the entry, never the current one; (4) the per-entry digest set carries a hard FIFO cap (defense against configs beyond the session turn cap): a new unique content evicts the oldest digest, so the very first content is no longer recognized on re-offer — an under-count, never a behavior change; (5) the test-visible seam exposes digests only, and a disabled-control differential seam proves the counters do not alter buffer behavior; test fixtures never drain or correct, so an unexpected call fails loud rather than silently stubbing.

## Consequences
Duplicate detection is approximate under the FIFO cap — old repeats can be under-counted, which is acceptable because counting is observational. Memo validity by array identity means any refactor that swaps entry arrays mid-flight changes memo behavior; the WeakRef discipline must be preserved. A caller-side premise violation (an offered turn missing from entry.turns) is unconstructable against the real contract and is not tested.

## Origin comments
### memo validity by array identity
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:272` — "NOTE (not a test): an "offered turn missing from entry.turns" case cannot be"
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:273` — "constructed against the real contract — the buffer appends before counting,"
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:274` — "and fakeEntry arrays are caller-owned. The earlier draft of this file had"
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:275` — "such a test; it failed because the premise contradicts the layer's only"
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:276` — "valid input shape, not because counting was wrong. Memo validity therefore"
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:277` — "rests on entry-array identity (WeakRef-compared), covered by the"
- `packages/remnic-core/src/buffer-ingress-counters.test.ts:278` — "self-invalidating-memo and retained-deletion tests below."
- `packages/remnic-core/src/buffer-ingress-counters.ts:36` — "O(1) amortized per turn: memo validity is the entry's array references,"
- `packages/remnic-core/src/buffer-ingress-counters.ts:114` — "WeakRefs: after clearAfterExtraction replaces the entry arrays, the old"
- `packages/remnic-core/src/buffer-ingress-counters.ts:115` — "arrays must not stay reachable through the memo. Deref-compare keeps the"
- `packages/remnic-core/src/buffer-ingress-counters.ts:116` — "validity check exact without retaining evicted turn content."

### buffer-ingress observation-only scope
- `packages/remnic-core/src/buffer-ingress-counters.ts:2` — "Buffer-ingress counters (issue #3444) — OBSERVATION ONLY."

### ingress outcome taxonomy and invariants
- `packages/remnic-core/src/buffer-ingress-counters.ts:6` — "accepted: the turn was appended to a buffer entry (always the case for"
- `packages/remnic-core/src/buffer-ingress-counters.ts:8` — "acceptedExactDuplicate: observational SUB-COUNT of accepted — the"
- `packages/remnic-core/src/buffer-ingress-counters.ts:12` — "filtered: reserved for turns existing code drops before/at the buffer."
- `packages/remnic-core/src/buffer-ingress-counters.ts:17` — "(existing null-return and throw sites)."
- `packages/remnic-core/src/buffer-ingress-counters.ts:19` — "Invariant: accepted + filtered + refused == turns offered."

### counters lifecycle and zero-noise logging
- `packages/remnic-core/src/buffer-ingress-counters.ts:22` — "Counters are process-local and instance-owned (one instance per"

### duplicate-digest memory scheme
- `packages/remnic-core/src/buffer-ingress-counters.ts:27` — "duplicate detection hashes role+content to a sha256 digest (same"

### duplicate-digest cap policy
- `packages/remnic-core/src/buffer-ingress-counters.ts:30` — "the session turn cap) and additionally enforces a hard FIFO cap of"
- `packages/remnic-core/src/buffer-ingress-counters.ts:78` — "Hard cap on the per-entry duplicate-digest set (defense against configs"

### memo test seam exposes digests only
- `packages/remnic-core/src/buffer-ingress-counters.ts:106` — "Test-visible view of a per-entry digest memo: digest set only. The validity"

### disabled-control differential seam
- `packages/remnic-core/src/buffer-ingress-counters.ts:135` — "Test seam: the disabled control proves counting does not touch the buffer."

### observe-before-push ordering contract
- `packages/remnic-core/src/buffer-ingress-counters.ts:140` — "Observe an offered turn (called BEFORE the buffer pushes it, so a lazily"

### ingress-counters-observation-only-contract
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:16` — "/** * Issue #3444, observation-only contract: the counters change NOTHING the * buffer does. Two guarantees are pinned …"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:173` — "// Normalize wall-clock stamps the buffer itself writes (lastExtractionAt)"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:174` — "// so the two runs differ only where counters could possibly matter."

### buffer-ingress-fixture-deps
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:124` — "// `error` is `unknown`; the add path only throws Errors, so a non-Error would be a bug worth surfacing."
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:142` — "// SAFETY: the fixture never drains or corrects, so a call here would mean the"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:143` — "// fixture itself changed shape; fail loud rather than silently stub."
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:149` — "// Disabled observer: no bands means `observe` never triggers, so the fixture's"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:150` — "// replay path never consults persisted state."

### ingress-duplicate-digest-fifo-cap
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:276` — "// A new unique content FIFO-evicts the oldest digest…"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:278` — "// …so re-offering the very first content is no longer recognized, while"
- `packages/remnic-core/src/buffer-ingress-invariant.test.ts:279` — "// the still-tracked recent one is — an under-count, never a behavior change."

### digest-memo-observe-order
- `packages/remnic-core/src/buffer.ts:694` — "// #3444: observe BEFORE the push so a lazily rebuilt digest memo cannot"
- `packages/remnic-core/src/buffer.ts:695` — "// see the current turn (it must only flag turns already in the entry)."

### memory-walk-error-handling
- `packages/remnic-core/src/cli.ts:3368` — "// ENOENT (optional dir absent) is silent; containment/other errors log."

### memory-walk-symlink-safety
- `packages/remnic-core/src/cli.ts:3375` — "// Reject symlinked / non-directory roots and anything resolving outside the"
- `packages/remnic-core/src/cli.ts:3393` — "// never follow symlinked entries"
- `packages/remnic-core/src/cli.ts:3400` — "// poisoned entry — skip, keep walking the rest."

### memory-file-path-resolution
- `packages/remnic-core/src/cli.ts:7824` — "// Expand `~` first (gotcha #17 — Node's fs doesn't do this"
