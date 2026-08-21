# PR23: Work-Product Ledger Schema and Writes

## Goal

Start the creation-memory track with a deterministic, inspectable work-product
ledger that records what the agent explicitly created or updated.

This slice stays intentionally narrow:

- add the creation-memory feature flag
- add a typed work-product ledger schema
- persist dated ledger entries
- expose operator-facing record/status CLI commands

It does not yet add retrieval, commitments, or resume bundles.

## Why This Slice

The roadmap calls out creation memory as the next step after semantic-rule
verification. Agents need to remember what they created, not just what they
observed or inferred.

The smallest honest starting point is a ledger:

- durable
- typed
- timestamped
- source-aware
- easy to audit

That gives later PRs a real substrate for recovery and reuse.

## Flag Surface

- `creationMemoryEnabled`
- `workProductLedgerDir`

## Implementation Scope

1. Add `src/work-product-ledger.ts`
   - `validateWorkProductLedgerEntry`
   - `recordWorkProductLedgerEntry`
   - `getWorkProductLedgerStatus`
   - default root: `{memoryDir}/state/work-product-ledger`

2. Add CLI wrappers and commands
   - `openclaw engram work-product-status`
   - `openclaw engram work-product-record ...`

3. Extend config + plugin manifest
   - parse the new flag and store override
   - expose them in `openclaw.plugin.json`

4. Add tests
   - contract validation
   - dated persistence path
   - invalid-entry reporting
   - CLI gating on `creationMemoryEnabled`

## Expected Review Risks

- letting the ledger write when `creationMemoryEnabled` is off
- using an unsafe entry id or malformed timestamp in a persisted filename
- drifting the CLI surface away from the typed store contract

## Follow-On Slice

PR24 should add the first artifact recovery/reuse retrieval path on top of this
ledger instead of mixing recovery logic into PR23.
