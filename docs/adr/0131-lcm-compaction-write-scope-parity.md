# LCM compaction derives and authorizes its namespace through the same write-scoped plan as observe

Status: accepted

## Context
lcmCompactionFlush/lcmCompactionRecord pre-authorized `undefined => config.defaultNamespace` via resolveWritableNamespace BEFORE the scoped write key was computed. Under a deployment with a restrictive default WRITE policy where the principal can still write its self/project overlay, observe succeeds and archives LCM under the overlay key — yet compaction threw `namespace is not writable: default`, so the queue observe just wrote could never be flushed or recorded. Compaction is a write/maintenance op on the queue observe just wrote, so it must honor WRITE authorization even where the read gate would fall back.

## Decision
- Compaction must derive its namespace through the SAME write-scoped plan/gate observe uses (resolveMemoryScopePlan), authorizing the writable self base, and flush/record the SAME overlay key observe archived under — byte-for-byte, via the same lcmSessionKeyForNamespace helper.
- The write gate honors the overlay even when the principal is write-only and read-denied, and even when `self` is omitted from the recall set.
- When there is no overlay and the collapsed default store is unwritable, compaction must reject exactly as observe rejects (parity) — never succeed against a phantom queue.

## Consequences
Compaction no longer throws `not writable: default` for validly scoped queues; write-only principals can compact queues they can never read. The read gate and write gate remain intentionally different.

## Origin comments

Merged here: the compaction write-gate test records and the access-service compaction scoping records describe one write-parity rule.

- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2013` — "// The round-3 read-authorization gate is SHARED by lcmCompactionFlush/Record,"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2014` — "// but compaction is a WRITE/maintenance op on the queue observe just wrote."
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2015` — "// alice can WRITE her self namespace but NOT read it. observe archives under"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2016` — "// `alice-project-*:sess-1`; compaction must flush/record that SAME overlay key"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2017` — "// (gated by WRITE authorization), NOT fall back to the default/raw key — else"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2018` — "// the project-scoped LCM queue is never flushed/recorded."
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2026` — "// self deliberately omitted from the recall set too — read gate would fall"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2027` — "// back, but the WRITE gate must still honour the overlay."
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2033` — "// write-authorized self base."
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2436` — "// Companion: even with projectScope OFF (no overlay), an implicit observe by a"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2437` — "// principal that can write its self base archives under the default store ONLY"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2438` — "// when objective-state writes are off; with objective-state writes enabled the"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2439` — "// scope plan authorizes the self base. Here we keep objective-state off (the"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2440` — "// probe default) and projectScope off, so the write namespace collapses to the"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2441` — "// default store — but `default` is NOT writable. The scope plan's no-overlay"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2442` — "// branch still collapses to `config.defaultNamespace` via"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2443` — "// `resolveWritableNamespace(undefined)`, which DOES throw when default is"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2444` — "// unwritable — matching observe EXACTLY (if observe can't write, there is no"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2445` — "// queue to flush). This pins that compaction and observe agree on the throw."
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2458` — "// No overlay ⇒ implicit write collapses to the (unwritable) default store, so"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2459` — "// observe itself rejects. Compaction must reject identically (parity), NOT"
- `packages/remnic-core/src/access-service-observe-lcm-parity.test.ts:2460` — "// succeed against a phantom queue."
- `packages/remnic-core/src/access-service.ts:4395` — "// Authorize compaction against the same effective write namespace that"
- `packages/remnic-core/src/access-service.ts:4396` — "// observe archived under, not a premature default writable-namespace check."
- `packages/remnic-core/src/access-service.ts:4409` — "// Flush the same LCM session ID observe archived under."
- `packages/remnic-core/src/access-service.ts:4454` — "// Authorize compaction against the SCOPED WRITE TARGET — the SAME effective"
- `packages/remnic-core/src/access-service.ts:4455` — "// write namespace `observe` archived the LCM queue under — NOT a premature"
- `packages/remnic-core/src/access-service.ts:4456` — "// the writable-namespace resolver (undefined ⇒ config.defaultNamespace) (#1505"
- `packages/remnic-core/src/access-service.ts:4457` — "// thread NBHWs). See `lcmCompactionFlush` for the full rationale: under a"
- `packages/remnic-core/src/access-service.ts:4458` — "// restrictive `default` WRITE policy where the principal can still write its"
- `packages/remnic-core/src/access-service.ts:4459` — "// self/project overlay, the old premature default write-auth threw `namespace"
- `packages/remnic-core/src/access-service.ts:4460` — "// is not writable: default` before the scoped key was computed, leaving the"
- `packages/remnic-core/src/access-service.ts:4461` — "// overlay queue observe wrote unrecordable. `resolveMemoryScopePlan` is the"
- `packages/remnic-core/src/access-service.ts:4462` — "// ONE write-scoped plan/gate observe uses; it authorizes the self base for an"
- `packages/remnic-core/src/access-service.ts:4463` — "// overlay write and never throws `not writable: default` for a validly scoped"
- `packages/remnic-core/src/access-service.ts:4464` — "// observe's queue."
- `packages/remnic-core/src/access-service.ts:4477` — "// Record against the SAME LCM session_id `observe` archived under — encode"
- `packages/remnic-core/src/access-service.ts:4478` — "// the scope plan's EFFECTIVE write namespace through the SAME"
- `packages/remnic-core/src/access-service.ts:4479` — "// `lcmSessionKeyForNamespace` helper observe uses, so the record key is"
- `packages/remnic-core/src/access-service.ts:4480` — "// byte-for-byte the write key (#1495 thread 2 / #1505 thread NBHWs, rule 42)."
- `packages/remnic-core/src/access-service.ts:4481` — "// A write-only / self-omitted principal still records on the overlay queue"
- `packages/remnic-core/src/access-service.ts:4482` — "// because the scope plan authorized the write target by WRITE policy."
