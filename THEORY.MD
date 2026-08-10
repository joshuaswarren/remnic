# Theory: Durable Dependency Revalidation

## Problem

Remnic stores dependency links, but old lifecycle paths treated them as write-only metadata.

When support memory becomes invalid, a dependent claim can remain active and recallable.

The primary mutation and the dependent revalidation must also survive different crash windows.

## Operating theory

Dependency propagation is an orchestration task. Storage changes one memory atomically. The extraction engine judges dependent claims.

Each trigger captures the source before mutation. It prepares a durable job before the source changes.

After the primary mutation commits, the job becomes ready. A worker scans one namespace snapshot and one-hop link neighborhood.

The worker revalidates all bounded dependents in one LLM call. `still_valid` keeps the memory active. `invalidated` supersedes it.

Malformed, missing, or uncertain verdicts preserve active memory. This keeps the failure mode fail-open for user data.

## Durable state model

The queue uses explicit `prepared`, `ready`, `leased`, `retryable`, and terminal states.

Preparation records the exact source snapshot and replacement identity. Reservations prevent one caller from canceling another caller's job.

Recovery first proves whether the primary mutation committed. It replays missing primary effects only from the captured snapshot.

Recovered consolidation work also repairs index visibility. It uses the captured source path for deindex and gates temporal index work by capability.

The queue writes with atomic JSON replacement. Write failures return no preparation token, so callers do not report false durability.

## Trigger coverage

Contradiction resolution captures the active hot or cold source before supersession.

Temporal supersession prepares before mutation and retries preparation when a transient survivor lookup fails.

Consolidation invalidate and merge paths prepare before mutation. Merge recovery verifies the survivor fingerprint before replay.

Startup recovery scans durable jobs. Shutdown drains extraction first, then waits for propagation work.

## Rebase integration

Current `main` moved supersession side effects and recovery work into focused modules.

The branch now uses those boundaries instead of restoring old monolithic code.

Supersession remains active-only under the file lock. Exact replay repairs missing lifecycle, tombstone, audit, and cache effects.

The final branch must preserve the storage ratchet. `storage.ts` and `orchestrator.ts` stay below their enforced line limits.

## Verification state

Core type checks pass. The focused replay suite passes 170 tests.

The entity hardening gate passes. The lifecycle coverage suite passes 41 tests.

The complete second package shard passes 722 tests, with 17 skips and no failures.

The archive replay test and the active-state race regression both pass after the rebase fix.

The final sequential `preflight:quick` run passes.
