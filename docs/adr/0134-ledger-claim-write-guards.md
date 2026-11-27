# Claim writes check the tombstone block before readback and salvage oversized sealed-envelope attributes

Status: accepted

## Context
The belief ledger stores claims and audit records through sealed-envelope writes (issue #1989 PR4): system-serialized bodies with a value-length limit per attribute. Structured attributes such as ledger.sourceText and evidence excerpts can exceed that limit, and letting them abort the write would discard otherwise valid claims or audit corrections.

Independently, content that matches a tombstone cannot become an active claim: the write lands pending_review with no active copy, and getClaim hides pending_review (HIDDEN_REMNIC_STATUSES). A write-then-readback flow therefore reports "could not be read back" - an error that looks transient, so callers retry and multiply pending_review rows. The tombstone chokepoint hashes the enriched body (raw content plus the structured-attributes suffix writeMemory appends, storage.ts:3728-3749), so a tombstone computed from the raw body never matches the write. The store tests must wire the tombstone invariant exactly as the orchestrator does; without that wiring appendTombstone is a no-op and writeMemory never checks tombstones.

Theme consolidation: this record merges 2 sweep themes into one decision family (22 origin records): ledger-tombstone-invariant, sealed-envelope-salvage.

## Decision
- Check the tombstone block BEFORE readback and throw a distinct, honest error stating the content is permanently blocked; never emit the misleading "could not be read back" failure for tombstoned content.
- Compute tombstone content from the enriched body - the exact bytes the write path hashes at the chokepoint - never from the raw body.
- Sealed-envelope writes salvage rather than abort: fields exceeding the envelope's value-length limit are dropped with a warning log, for claim writes and system-built audit-trail corrections alike.
- Tests wire the tombstone invariant through the same path the orchestrator uses, so writeMemory actually consults tombstones.

## Consequences
Permanently blocked content is honest and non-retryable, but callers must distinguish the block error from transient failures. Oversized structured attributes are absent from the stored claim (warn-logged); nothing downstream may assume they were persisted. The invariant is only as real as the test wiring - a store constructed without it silently disables tombstone checks.

## Origin comments
- `packages/belief-ledger/src/remnic-store.test.ts:519` — "// Wire the tombstone invariant exactly as the orchestrator does — without"
- `packages/belief-ledger/src/remnic-store.test.ts:520` — "// this, appendTombstone is a no-op and writeMemory never checks tombstones."
- `packages/belief-ledger/src/remnic-store.test.ts:539` — "// Tombstone the exact body writeMemory receives — a blocked claim lands"
- `packages/belief-ledger/src/remnic-store.test.ts:540` — "// pending_review, which getClaim hides (HIDDEN_REMNIC_STATUSES). Without"
- `packages/belief-ledger/src/remnic-store.test.ts:541` — "// the pre-readback guard, createClaim throws a misleading \"could not be"
- `packages/belief-ledger/src/remnic-store.test.ts:542` — "// read back\" error that looks transient → callers retry → duplicate rows."
- `packages/belief-ledger/src/remnic-store.test.ts:543` — "// writeMemory enriches the content with a structured-attributes suffix"
- `packages/belief-ledger/src/remnic-store.test.ts:544` — "// before hashing for the tombstone chokepoint (storage.ts:3728-3749), so"
- `packages/belief-ledger/src/remnic-store.test.ts:545` — "// the tombstone rawContent must match the ENRICHED body, not the raw body."
- `packages/belief-ledger/src/remnic-store.ts:101` — "// Sealed-envelope write (issue #1989 PR4): claims are system-serialized"
- `packages/belief-ledger/src/remnic-store.ts:102` — "// but structured attributes (ledger.sourceText, evidence excerpts) may"
- `packages/belief-ledger/src/remnic-store.ts:103` — "// exceed the envelope's value-length limit — SALVAGE keeps oversized"
- `packages/belief-ledger/src/remnic-store.ts:104` — "// fields from aborting a valid claim; drops warn-logged."
- `packages/belief-ledger/src/remnic-store.ts:126` — "// #1645: a tombstone-blocked claim write lands pending_review (no active"
- `packages/belief-ledger/src/remnic-store.ts:127` — "// copy). getClaim hides pending_review (HIDDEN_REMNIC_STATUSES), so the"
- `packages/belief-ledger/src/remnic-store.ts:128` — "// readback below would throw a misleading \"could not be read back\" error"
- `packages/belief-ledger/src/remnic-store.ts:129` — "// that looks transient — callers retry and multiply pending_review rows."
- `packages/belief-ledger/src/remnic-store.ts:130` — "// Check the block BEFORE readback and throw a distinct, honest error so the"
- `packages/belief-ledger/src/remnic-store.ts:131` — "// caller knows this content is permanently blocked, not transiently failed."
- `packages/belief-ledger/src/remnic-store.ts:288` — "// Sealed-envelope write (issue #1989 PR4): system-built audit body."
- `packages/belief-ledger/src/remnic-store.ts:289` — "// Audit-trail correction — system-built body, salvage for the same"
- `packages/belief-ledger/src/remnic-store.ts:290` — "// attribute-limit reason as the claim write."
