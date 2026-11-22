# Effective validity intervals terminate for legacy data and degrade conservatively on corrupt timestamps

Status: accepted

## Context
Schema evolution left old records without `invalid_at`, and the new `as_of` filter bypasses the supersession-status check; without the fallback, every historical pin would surface legacy predecessors alongside successors. The chosen fallback intentionally over-shows rather than under-shows; new data is unaffected.

## Decision
A memory's validity is a half-open `[valid_at, invalid_at)` interval with deterministic fallbacks.

Rules:
- `created` is required on every memory, so the effective-`valid_at` fallback chain always terminates; whitespace-only overrides are trimmed against legacy tooling writes.
- Legacy records (pre-#680) with `status: superseded` and `supersededAt` but no `invalid_at` fall back to `supersededAt` as the interval end, so `as_of` filtering without a backfill migration still terminates legacy intervals. Accepted boundary approximation: the legacy predecessor may stay visible from `valid_at` through `supersededAt`, a bit past the successor's true `valid_at` — "show the legacy fact a bit too long" beats "drop legacy facts entirely from as_of"; successor-aware coordination would require threading the successor through every call site. New data writes `invalid_at` directly.
- An extracted end-only bound (eventTimeSource "extracted", no valid_at, has invalid_at) is an open-start interval, true from the indefinite past, gated on eventTimeSource so legacy memories keep the `created` anchor; without this, a historical as_of before ingestion hides a fact that was actually true until invalid_at.
- Unparseable `invalid_at` conservatively keeps the fact — we can read valid_at, so the fact was at some point true; corrupt data is not a reason to hide it.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/temporal-validity.ts:30` — "// `created` is required on every memory (see types.ts), so the fallback"
- `packages/remnic-core/src/temporal-validity.ts:31` — "// chain always terminates. Trimming guards against whitespace-only"
- `packages/remnic-core/src/temporal-validity.ts:32` — "// overrides written by legacy tooling."
- `packages/remnic-core/src/temporal-validity.ts:43` — "// Cursor Medium rounds 1+2 on PR #713: legacy data written before"
- `packages/remnic-core/src/temporal-validity.ts:44` — "// #680 has `status: superseded` and `supersededAt` populated, but"
- `packages/remnic-core/src/temporal-validity.ts:45` — "// no `invalid_at`. With the new `as_of` filter bypassing the"
- `packages/remnic-core/src/temporal-validity.ts:46` — "// supersession status check, those legacy predecessors would"
- `packages/remnic-core/src/temporal-validity.ts:47` — "// otherwise be treated as "always valid" and surface alongside"
- `packages/remnic-core/src/temporal-validity.ts:48` — "// their successors at every historical pin. Fall back to"
- `packages/remnic-core/src/temporal-validity.ts:49` — "// `supersededAt` so the half-open `[valid_at, invalid_at)`"
- `packages/remnic-core/src/temporal-validity.ts:50` — "// interval still terminates for legacy supersedes without"
- `packages/remnic-core/src/temporal-validity.ts:51` — "// requiring a backfill migration."
- `packages/remnic-core/src/temporal-validity.ts:52` — "//"
- `packages/remnic-core/src/temporal-validity.ts:53` — "// BOUNDARY APPROXIMATION: `supersededAt` is when the supersession"
- `packages/remnic-core/src/temporal-validity.ts:54` — "// write fired, which may post-date the successor's true"
- `packages/remnic-core/src/temporal-validity.ts:55` — "// `valid_at` (consolidation runs on its own cadence). So the"
- `packages/remnic-core/src/temporal-validity.ts:56` — "// legacy predecessor stays visible from `valid_at` through"
- `packages/remnic-core/src/temporal-validity.ts:57` — "// `supersededAt` rather than the tighter `valid_at` through"
- `packages/remnic-core/src/temporal-validity.ts:58` — "// successor-`valid_at` window. We accept this intentionally: the"
- `packages/remnic-core/src/temporal-validity.ts:59` — "// alternative — successor-aware coordination — would require"
- `packages/remnic-core/src/temporal-validity.ts:60` — "// threading the successor through every call site, and "show the"
- `packages/remnic-core/src/temporal-validity.ts:61` — "// legacy fact a bit too long" is a clear win over "drop legacy"
- `packages/remnic-core/src/temporal-validity.ts:62` — "// facts entirely from `as_of`". New data (post-#680) writes"
- `packages/remnic-core/src/temporal-validity.ts:63` — "// `invalid_at` directly and is unaffected."
- `packages/remnic-core/src/temporal-validity.ts:95` — "// Open-start bi-temporal interval (#1578 r3): an extracted end-only bound"
- `packages/remnic-core/src/temporal-validity.ts:96` — "// (eventTimeSource "extracted", no valid_at, has invalid_at) is true from"
- `packages/remnic-core/src/temporal-validity.ts:97` — "// the indefinite past. Without this, effectiveValidAt falls back to"
- `packages/remnic-core/src/temporal-validity.ts:98` — "// `created` and a historical as_of before ingestion hides a fact that was"
- `packages/remnic-core/src/temporal-validity.ts:99` — "// actually true up until invalid_at (chatgpt-codex thread on"
- `packages/remnic-core/src/temporal-validity.ts:100` — "// orchestrator.ts:15533). Gated on eventTimeSource so legacy memories"
- `packages/remnic-core/src/temporal-validity.ts:101` — "// (no bi-temporal provenance) keep the created-anchor fallback."
- `packages/remnic-core/src/temporal-validity.ts:119` — "// Unparseable invalid_at — conservatively keep the fact (we can read"
- `packages/remnic-core/src/temporal-validity.ts:120` — "// valid_at, so we know the fact was at some point true; corrupt"
- `packages/remnic-core/src/temporal-validity.ts:121` — "// invalid_at is not a reason to hide it)."
- `packages/remnic-core/src/temporal-validity.ts:154` — "// Unparseable invalid_at — conservatively keep the fact (do not filter on"
- `packages/remnic-core/src/temporal-validity.ts:155` — "// corrupt data; the as_of path already handles malformed bounds)."
