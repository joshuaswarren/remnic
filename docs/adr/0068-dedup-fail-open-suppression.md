# Dedup Never Suppresses on Failure or Disablement

Status: accepted

## Context
Dedup is a suppression mechanism: a false positive silently loses a fact,
while a failed lookup does not prove a duplicate exists. An outage or a
degraded embedding backend must not turn every subsequent fact into a
suppressed write, and a disabled deployment must behave as if dedup does not
exist. Backfill helpers that mutate an existing fact on a dedup hit can
corrupt a different connector's temporal bounds if a scan error is treated as
a hit.

## Decision
Rules:

- Never suppress a write via dedup when dedup is disabled, when the lookup
  failed or did not complete, or when no matching active fact was confirmed.
  If the matching-fact lookup threw before resolving, fall through to the
  write path; only a CONFIRMED duplicate skips the write.
- When dedup is enabled, a lookup failure falls back to the full corpus
  confirm rather than trusting the index miss.
- Once the embedding backend is unavailable within a batch (any fact gets
  reason="backend_unavailable"), subsequent facts skip the semantic-dedup
  lookup entirely and proceed to write. The flag resets per batch, so a
  transient hiccup never permanently disables dedup.
- On a scan error during temporal-bounds backfill, skip the backfill
  conservatively (fail-closed) — a fail-open could select a different
  connector's fact and corrupt its temporal bounds.
- A dedup-hit short-circuit still runs temporal supersession and bounds
  backfill (see the temporal supersession ADR) so suppression never strands
  stale state.

## Consequences
Degraded backends cost full writes instead of dedup — that is the intended
trade: extra duplicates are cheaper than silent loss. The per-batch backend
flag means one batch can pay N timeouts before the signal is set.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-persist.ts:269` — "// UUI2: short-circuit semantic dedup after first backend-unavailable signal"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:270` — "// within this batch. Once any fact in the batch gets reason=\"backend_unavailable\""
- `packages/remnic-core/src/orchestration/extraction-persist.ts:271` — "// (meaning the embedding backend is degraded), subsequent facts skip the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:272` — "// lookup entirely and proceed directly to write. This prevents N-fact batches"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:273` — "// from paying N × timeout when the backend is down. The flag resets per-batch"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:274` — "// (declared here, inside persistExtraction) so a transient hiccup in one"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:275` — "// batch does not permanently disable dedup in future batches."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:667` — "// Review f1b89fe9: on scan error, conservatively skip backfill"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:668` — "// instead of fail-opening. A fail-open here still calls the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:669` — "// helper, which selects the first hash/entity match — and if"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:670` — "// that match is a different connector's fact, the mutation"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:671` — "// corrupts its temporal bounds. Skipping is the safe choice."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:717` — "// PR #402 round-7 (Fix #2 / Codex P1 PRRT_kwDORJXyws56VALC):"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:718` — "// Track whether matchingFact lookup completed before the try block"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:719` — "// so the catch block can distinguish an early-lookup failure (where"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:720` — "// we don't know if a duplicate exists) from a post-lookup supersession"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:721` — "// failure (where we confirmed a duplicate and must skip the write)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:808` — "// No active same-entity shared fact found with this content hash."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:809` — "// This can happen when the previously-written shared fact has since"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:810` — "// been superseded (e.g. Austin → NYC → Austin reversion): the hash"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:811` — "// index still records the hash but the fact is no longer active."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:812` — "// Fall through to the write path below so a new active shared"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:813` — "// memory is created, then supersession fires post-write as usual."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:821` — "// PR #402 round-7 (Fix #1 / cursor Medium PRRT_kwDORJXyws56U_ig):"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:822` — "// Only skip the write if we CONFIRMED a matching active shared fact"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:823` — "// before the error occurred (hashDedupLookupComplete is true AND"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:824` — "// hashDedupMatchingFact is set). If the error was thrown before"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:825` — "// matchingFact was resolved — e.g. readAllMemories() threw — we"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:826` — "// cannot assume a duplicate exists, and unconditionally returning"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:827` — "// would permanently lose the shared promotion. Fall through to the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:828` — "// write path so the fact is not silently dropped."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:830` — "// A matching active shared fact was confirmed — skip the write to"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:831` — "// avoid duplicating content that is already present. The existing"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:832` — "// fact remains active and the supersession failure is logged above."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:835` — "// Lookup did not complete or no candidate was found — we cannot"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:836` — "// confirm a duplicate. Fall through to the write + post-write"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:837` — "// supersession path so the shared promotion is not lost."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1682` — "// Dedup lookup failed (e.g. the authoritative rebuild could not run)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1683` — "// When dedup is enabled the confirm below still scans the corpus; when"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1684` — "// it is disabled, never suppress a write via dedup (PR #2016 SD-nH)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1699` — "// Fact dedup disabled → skip the authority check AND the corpus"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1700` — "// confirmation, so a disabled deployment never suppresses a write via"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1701` — "// dedup (PR #2016 thread SD-nH)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1924` — "// UUI2: skip embedding lookup for the rest of this batch once we know"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1925` — "// the backend is unavailable. The flag is reset per-batch (set to false"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1926` — "// at the top of persistExtraction), so a transient hiccup in one call"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1927` — "// does not permanently disable dedup in subsequent calls."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2413` — "// Register chunked content in the target storage hash index too. // Thread 3 fix: canonicalize by stripping any pre-ex…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2422` — "// #1645: do NOT register a tombstone-blocked fact's content in the // dedup index — writeMemory already skipped it (ru…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2615` — "// Register the dedup hash inside the same commit window: writeMemory // indexes facts only (rule 44 #1579), so non-fac…"
