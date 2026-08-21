# PR26: Commitment Lifecycle Integration

## Goal

Add the first deterministic lifecycle layer for the typed commitment ledger so
creation-memory obligations can be fulfilled, expired, and eventually cleaned
up instead of remaining append-only `open` records forever.

## Scope

- add explicit lifecycle config behind feature flags
- add typed lifecycle metadata for commitment entries
- add operator-facing state transitions for existing commitment entries
- report overdue, stale, and decay-eligible counts in commitment status
- add a deterministic lifecycle runner for overdue expiry and aged resolved-entry cleanup
- wire the lifecycle runner into consolidation when the slice is enabled

## Non-Goals

- transcript-based commitment inference
- commitment recall injection
- resume-bundle generation from commitments
- probabilistic prioritization or ranking of obligations

## Why This Slice Exists

PR25 proved that commitments should be stored explicitly. PR26 turns that store
into an actual lifecycle substrate:

- fulfilled work can be marked done,
- overdue commitments can deterministically expire,
- old resolved commitments can age out using the existing decay horizon,
- operators can inspect the lifecycle health of the ledger without reading raw JSON.

## Planned Changes

### Data Model

Extend `src/commitment-ledger.ts` with optional lifecycle fields:

- `stateChangedAt`
- `resolvedAt`

Keep `open` as the unresolved state. Use `fulfilled`, `cancelled`, and
`expired` as resolved states.

### Config Surface

Add:

- `commitmentLifecycleEnabled` (default `false`)
- `commitmentStaleDays` (default `14`)

Reuse:

- `commitmentDecayDays`

### Ledger Operations

Add:

- `transitionCommitmentLedgerEntryState(...)`
- `applyCommitmentLedgerLifecycle(...)`

Behavior:

- overdue `open` commitments with a past `dueAt` transition to `expired`
- resolved commitments older than `commitmentDecayDays` are deleted
- deadline-free `open` commitments older than `commitmentStaleDays` are counted as stale in status

### CLI

Add:

- `openclaw engram commitment-set-state`
- `openclaw engram commitment-lifecycle-run`

Update:

- `openclaw engram commitment-status`

So it reports lifecycle counters when the lifecycle slice is enabled.

### Runtime Wiring

During consolidation, when:

- `creationMemoryEnabled`
- `commitmentLedgerEnabled`
- `commitmentLifecycleEnabled`

are all enabled, run the same deterministic lifecycle pass used by the CLI.

## Tests

Add regression coverage for:

- config defaults and overrides for the new lifecycle flags
- operator state transitions gated by `commitmentLifecycleEnabled`
- status reporting of overdue, stale, and decay-eligible counts
- lifecycle runner expiring overdue commitments
- lifecycle runner deleting aged resolved commitments
- lifecycle CLI command gating and behavior

## Exit Criteria

- targeted lifecycle tests pass
- `npm run check-types` passes
- full test suite and build pass
- docs and config surface match the implementation
