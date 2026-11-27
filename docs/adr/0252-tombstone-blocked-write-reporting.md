# Tombstone-blocked writes are reported as queued/rejected, never as successful active writes

Status: accepted

## Context
Re-storing retired content hits the tombstone gate and lands in pending_review with no active copy. Reporting such writes as applied misleads callers and telemetry into believing an active memory was stored that recall will never return (issue #1645, review threads yG-, Yhp, yGr).

## Decision
A tombstone-blocked explicit capture lands pending_review: skip query-aware indexing and report it as queued for review. Telemetry must flag when a write landed tombstone-blocked so post-switch reports treat it as queued for review rather than a successful active write. In agent-action accounting, a tombstone-blocked write is NOT an active application — record it as skipped with the blocked id, and status must agree with outcome: a blocked write is not "applied"; "rejected" reflects that the tombstone gate refused the active write (row is pending_review).

## Consequences
Callers cannot mistake blocked re-stores for successful captures; blocked ids surface in skipped/queued accounting instead of applied counts.

## Origin comments
- `src/tools.ts:513` — "#1645 (review thread yG-): a tombstone-blocked explicit capture lands"
- `src/tools.ts:514` — "pending_review (no active copy). Skip query-aware indexing and report it"
- `src/tools.ts:515` — "as queued for review so the caller doesn't believe an active memory was"
- `src/tools.ts:516` — "stored."
- `src/tools.ts:1751` — "#1645 (review thread Yhp): set when a write landed tombstone-blocked"
- `src/tools.ts:1752` — "(pending_review) so the post-switch telemetry reports it as queued for"
- `src/tools.ts:1753` — "review rather than a successful active write."
- `src/tools.ts:1921` — "#1645 (review thread Yhp): a tombstone-blocked write is NOT an"
- `src/tools.ts:1922` — "active application — record it as skipped with the blocked id so an"
- `src/tools.ts:1923` — "agent action that re-stores retired content is not reported as a"
- `src/tools.ts:1924` — "successful active write (recall will not use it)."
- `src/tools.ts:1926` — "#1645 (review thread yGr): status must agree with outcome — a"
- `src/tools.ts:1927` — "blocked write is not \"applied\"; \"rejected\" reflects that the"
- `src/tools.ts:1928` — "tombstone gate refused the active write (row is pending_review)."
