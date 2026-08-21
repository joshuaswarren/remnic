# PR25: Commitment Ledger

## Goal

Start the commitment-memory track with a deterministic, inspectable ledger for
explicit promises, follow-ups, deadlines, and unfinished obligations.

## Scope

This slice should:

- add a typed commitment-ledger schema
- persist dated ledger entries under a dedicated store
- expose operator-facing status and record commands
- keep the feature behind config flags

This slice should not yet:

- infer commitments automatically from transcripts
- add recall injection
- add fulfillment or stale-commitment lifecycle rules
- build resume bundles

## Why This Slice

The roadmap calls out commitments as a first-class part of creation memory and
recoverability. Work products answer "what did the agent create?" Commitments
answer "what does the agent still owe?"

PR25 should establish the durable substrate before PR26 adds fulfillment and
lifecycle policy.

## Proposed Contract

Add `src/commitment-ledger.ts` with:

- `resolveCommitmentLedgerDir(memoryDir, overrideDir?)`
- `validateCommitmentLedgerEntry(raw)`
- `recordCommitmentLedgerEntry({ memoryDir, commitmentLedgerDir?, entry })`
- `getCommitmentLedgerStatus({ memoryDir, commitmentLedgerDir?, enabled })`

Entry shape:

- `schemaVersion: 1`
- `entryId`
- `recordedAt`
- `sessionKey`
- `source: tool_result | cli | system | manual`
- `kind: promise | follow_up | deadline | deliverable`
- `state: open | fulfilled | cancelled | expired`
- `scope`
- `summary`
- optional `dueAt`
- optional `entityRefs`
- optional `workProductEntryRefs`
- optional `objectiveStateSnapshotRefs`
- optional `tags`
- optional `metadata`

## Flags

- `creationMemoryEnabled`
- `commitmentLedgerEnabled`
- `commitmentLedgerDir`

## CLI Surface

- `openclaw engram commitment-status`
- `openclaw engram commitment-record ...`

## Tests

- `tests/commitment-ledger.test.ts`
- extend `tests/config-eval-harness.test.ts`

## Acceptance

- status command reports valid/invalid counts and latest entry
- record command writes only when creation memory and commitment ledger are both enabled
- contract is typed, dated, and ready for PR26 lifecycle integration
