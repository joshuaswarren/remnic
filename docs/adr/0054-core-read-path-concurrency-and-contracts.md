# Recall coalescing shares flights with per-caller abort semantics; read-path contracts stay uniform

Status: accepted

## Context
Recall coalescing and concurrency limiting interact: a keyed single-flight leader queued behind the concurrency cap runs on the flight's controller with race=false, so a caller's abort was never observed while queued; followers joining an unkeyed leader's flight had no persisted gate to race; and Promise.race settles already-resolved members in array order, so a pre-aborted signal could slip past the abort racer. Meanwhile the active-memory bridge propagated resolver throws for bad handles, crashing OpenClaw callers, and the active-context transform needed stable, text-free plan identities.

## Decision
- Single-flight registration is synchronous: the leader registers its flight in the same turn recall sees the miss, so later identical arrivals join by map lookup.
- Abort is checked at every non-racing wait: a slot-granted caller re-checks its signal before starting work; a follower's await on the leader's persisted gate races its own abort signal and rejects promptly; an existing-join rechecks abort before returning success. A follower's abort releases only its OWN reservation, never the leader's persisted event.
- Every queued caller is counted in the flight's live refcount while queued; only when ALL callers disconnect does live reach zero and cancel the not-yet-committed flight.
- raceAbort rejects synchronously for an already-aborted signal (never relies on race ordering).
- A `[m:handle]` that misses, collides, or has no session key yields the SAME not_found contract as a bad raw id — never a thrown error out of the active-memory path.
- Active-context plans carry hashes and counts, never raw message text; namespace routing is data routing, never authorization; canonical JSON is deterministic (sorted keys); trusted-scope checks run before any ID selection or model work; filter thresholds are explicit, never silently defaulted; replacement IDs derive from the same stable inputs as planId; ledger errors surface in the result, never as an apply failure.

## Consequences
Disconnected callers never cause work to execute or persist, but shared flights continue for remaining callers. Costs: refcount and recheck bookkeeping on every queued/coalesced path.

## Origin comments

Merged here: the active-context transform invariants and the active-memory handle contract were folded into the nearest neighbour, the recall read-path contract decision.

- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:33` — "// Coalescing is deterministic: the leader registers its flight synchronously in"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:34` — "// the same turn recall() sees the miss, so every later identical arrival joins"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:35` — "// by map lookup — no wall-clock waits."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1567` — "// The queued waiter's abort listener is removed by `take()` the instant a slot"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1568` — "// is granted. If the signal fires in the microtask gap between the grant and"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1569` — "// the recall function running, withRecallConcurrency must re-check the signal"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1570` — "// and release the slot instead of starting work for a disconnected caller."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1599` — "// A keyed single-flight leader queued behind the concurrency cap runs its"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1600` — "// pipeline on the FLIGHT controller with race=false, so its caller's abort was"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1601` — "// previously never observed: the flight would still execute + reserve + persist"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1602` — "// once a slot freed, even though its only caller had disconnected while queued."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1652` — "// Shared-flight semantics for ADDITIONAL callers: when a second caller has"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1653` — "// joined, one caller's abort must not cancel the shared pipeline."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1710` — "// A keyed follower coalescing through leadRecallFlight's existing-join awaits"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1711` — "// the leader's `persisted` gate. That await must RACE the follower's own abort"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1712` — "// signal: a client that disconnects while the leader's put is pending must get"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1713` — "// AbortError promptly — not block until the put settles."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1772` — "// Companion to the promptness test: the abort must release exactly the"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1773` — "// follower's OWN cross-namespace reservation and never touch the leader's,"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1774` — "// whose event legitimately stands because it persisted."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1826` — "// A keyed leader queued behind the concurrency cap runs race=false; a keyed"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1827` — "// existing-join follower is also non-racing. The follower's abort must still"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1828` — "// be COUNTED in the flight's live refcount while the flight is only queued:"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1829` — "// otherwise, when both callers disconnect before a slot frees, the leader's"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1830` — "// abort drops live 2 -> 1 but the follower's is never counted, so the flight"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1831` — "// executes + reserves + persists with no caller connected."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1875` — "// Both callers disconnect while the flight is still queued. Only when BOTH"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1876` — "// are counted does live reach 0 and cancel the not-yet-committed flight."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1894` — "// Promise.race settles already-resolved members in array order, so a fulfilled"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1895` — "// p (index 0) would beat a synchronously-rejected abort racer (index 1). Without"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1896` — "// a pre-check, a caller that aborted before raceAbort is called (e.g. the keyed"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1897` — "// follower persistence wait) would proceed past the helper. raceAbort must"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1898` — "// reject synchronously for an already-aborted signal."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1919` — "// A keyed caller can coalesce onto a flight started by an UNKEYED leader"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1920` — "// (the idempotencyKey is excluded from the flight key). That flight carries"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1921` — "// NO `persisted` gate, so the keyed follower's existing-join could not await"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1922` — "// it. Because a keyed join is non-racing (race=false), the follower's abort"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1923` — "// is never observed during the shared-pipeline wait, so without a recheck the"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1924` — "// follower would return success — persisting its idempotency key and keeping"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1925` — "// its own cross-namespace budget event — even though its client disconnected."
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1926` — "// The existing-join must recheck the abort before returning: the follower must"
- `packages/remnic-core/src/access-service-recall-concurrency.test.ts:1927` — "// reject with AbortError, release its reservation, and never run its own put."
- `packages/remnic-core/src/active-context-transform.test.ts:172` — "// Plans carry hashes and counts, never message text."
- `packages/remnic-core/src/active-context-transform.ts:67` — "/** Data routing only — never authorization. */"
- `packages/remnic-core/src/active-context-transform.ts:137` — "/** Filled by prepare — plans never carry raw text. */"
- `packages/remnic-core/src/active-context-transform.ts:275` — "/** Deterministic JSON: sorted keys, so field order never changes a hash. */"
- `packages/remnic-core/src/active-context-transform.ts:397` — "// Trusted-scope checks run before any ID selection or model work."
- `packages/remnic-core/src/active-context-transform.ts:696` — "// fixed limit in [0,1], never defaulted"
- `packages/remnic-core/src/active-context-transform.ts:755` — "// planId is derived inside finalizePlan; the replacement ID must be stable"
- `packages/remnic-core/src/active-context-transform.ts:756` — "// relative to it, so derive from the same stable inputs."
- `packages/remnic-core/src/active-context-transform.ts:942` — "// ledger errors surface in the result, never as an apply"
- `packages/remnic-core/src/active-memory-bridge.test.ts:514` — "// A missing session key, unknown handle, or ambiguous handle makes the"
- `packages/remnic-core/src/active-memory-bridge.test.ts:515` — "// orchestrator resolver THROW. The active-memory get path must yield the SAME"
- `packages/remnic-core/src/active-memory-bridge.test.ts:516` — "// not_found contract a bad raw id gets — not propagate the throw and crash an"
- `packages/remnic-core/src/active-memory-bridge.test.ts:517` — "// OpenClaw active-memory caller."
- `packages/remnic-core/src/active-memory-bridge.ts:291` — "// Issue #1582 — resolve a `[m:xxxx]` handle to its memory id against the"
- `packages/remnic-core/src/active-memory-bridge.ts:292` — "// caller's session before the storage read, so OpenClaw active-memory agents"
- `packages/remnic-core/src/active-memory-bridge.ts:293` — "// can cite injected handles through the SAME shared path as memory_get /"
- `packages/remnic-core/src/active-memory-bridge.ts:294` — "// correction (cursor review). Raw ids pass through unchanged."
- `packages/remnic-core/src/active-memory-bridge.ts:295` — "//"
- `packages/remnic-core/src/active-memory-bridge.ts:296` — "// A handle that misses, collides, or has no session key becomes not_found —"
- `packages/remnic-core/src/active-memory-bridge.ts:297` — "// the SAME behavior a bad raw id yields below — instead of throwing, so an"
- `packages/remnic-core/src/active-memory-bridge.ts:298` — "// active-memory caller gets a uniform not-found contract (cursor review)."
