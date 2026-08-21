# PR21: Semantic Rule Promotion

## Goal

Turn verified episodic memories into reusable semantic rules without adding a new semantic-memory substrate or requiring model inference on the hot path.

## Scope

- Keep the slice behind `semanticRulePromotionEnabled`
- Add a deterministic promotion path for explicit `IF ... THEN ...` rules found in verified episodic memories
- Add an operator-facing CLI entry point:
  - `openclaw engram semantic-rule-promote --memory-id <id> [--dry-run]`
- Persist promoted rules as normal `rule` memories with:
  - `memoryKind: note`
  - `source: semantic-rule-promotion`
  - `sourceMemoryId`
  - `lineage`
  - `supports` link back to the source episode
- Suppress duplicates by normalized rule content

## Non-Goals

- No automatic rule mining from arbitrary free-form causal prose yet
- No bulk promotion runner yet
- No recall-time confidence downgrade logic yet
- No semantic-rule retrieval blending yet

## Why This Slice

PR20 established verified episodic recall as the bounded episodic substrate. The next step is to extract durable semantic rules from those verified episodes in a small, inspectable way. The lowest-risk first move is deterministic promotion of already-explicit `IF ... THEN ...` rules.

This lines up with the roadmap thesis from `docs/plans/2026-03-06-engram-agentic-memory-roadmap.md`:

- retrieve episodic traces
- verify them
- separately extract reusable semantic rules

## Test Plan

1. Red:
   - dry-run extracts a normalized `IF ... THEN ...` rule from a verified episodic memory
   - persisted promotion writes a `rule` memory with lineage and support link
   - non-episodic sources are rejected
   - duplicate promoted rules are suppressed
   - CLI honors `semanticRulePromotionEnabled`
2. Green:
   - add `src/semantic-rule-promotion.ts`
   - wire `runSemanticRulePromoteCliCommand(...)`
   - expose `openclaw engram semantic-rule-promote`
3. Verify:
   - targeted PR21 tests
   - `npm run check-types`
   - `npm test`
   - `npm run build`

## Expected Review Risks

- Overpromoting note-like material as rules
- Inconsistent canonicalization causing duplicate rules with punctuation drift
- Missing provenance back to the source episode

## Follow-On Slice

PR22 will add recall-time verification and confidence downgrade paths so promoted rules can be re-checked against source evidence rather than treated as permanently equivalent to hand-authored principles.
