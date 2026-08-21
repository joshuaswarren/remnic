# PR22: Semantic Rule Verifier and Confidence Downgrade

## Goal

Re-check promoted semantic rules against their cited episodic source memories at recall time so Engram can trust verified rules more than stale or orphaned ones.

## Scope

- Keep the slice behind a new explicit flag: `semanticRuleVerificationEnabled`
- Add a dedicated recall section:
  - `## Verified Rules`
- Verify only `rule` memories written by `semantic-rule-promotion`
- Re-check each promoted rule against `sourceMemoryId` at recall time
- Downgrade effective confidence when the source memory:
  - is missing
  - is archived
  - is no longer an `episode`
- Filter out downgraded rules below the default effective-confidence floor
- Add an operator-facing CLI preview:
  - `openclaw engram semantic-rule-verify <query>`

## Non-Goals

- No broad semantic-rule mining from free-form prose
- No automatic rule invalidation or mutation of stored rule memories yet
- No blending into generic `memories` recall
- No learned downgrade weights yet

## Why This Slice

PR21 proved that Engram can promote explicit `IF ... THEN ...` rules from verified episodes into durable rule memories. The immediate risk after promotion is overtrust: a promoted rule can outlive, drift away from, or lose the source episode that justified it.

This slice keeps the next step bounded:

- verify rule provenance at recall time
- surface only bounded verified-rule recall
- downgrade confidence rather than mutating memory

That matches the roadmap’s PR22 target without pulling in the larger invalidation and learning systems too early.

## Test Plan

1. Red:
   - verified semantic-rule search returns promoted rules whose source episode still verifies
   - archived or invalid source memories downgrade effective confidence below the default recall floor
   - CLI honors `semanticRuleVerificationEnabled`
   - recall injects `## Verified Rules` only when the flag and recall section are enabled
2. Green:
   - add `src/semantic-rule-verifier.ts`
   - wire `runSemanticRuleVerifyCliCommand(...)`
   - add `verified-rules` recall section in the orchestrator
   - add `semanticRuleVerificationEnabled` config wiring and recall-pipeline default
3. Verify:
   - targeted PR22 tests
   - config contract tests
   - `npm run check-types`
   - `npm test`
   - `npm run build`

## Expected Review Risks

- Treating promoted rules as verified without source-memory rechecks
- Letting downgraded rules still leak into recall through overly generous thresholds
- Missing or stale config/docs surface for the new flag and recall section

## Follow-On Slice

PR23 moves into creation-memory with a work-product ledger. Semantic-rule invalidation, learned downgrade weights, and broader rule retrieval can wait until the recoverability track is in place.
