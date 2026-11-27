# Destructive memory operations pass a gated controller that records its choice before dispatch, and subject classification is deterministic at write time

Status: accepted

## Context
The unified memory controller (#2345-#2348) dispatches effects through host-supplied collaborators, so a bad or absent recorder could let work happen with no audit trail; destructive changes needed a scope discipline before reaching active mode. Separately, memory subject (WHOM a memory is about) and optional local-model routing needed deterministic, drift-free rules shared across workflows.

## Decision
(1) The controller is host-free and gated: one state enters, one choice leaves; the choice record is shadowed BEFORE any active dispatch, and a failing recorder stops work entirely (no dispatch, no outcome event). (2) The first active scope permits reversible actions only - discard and any destructive change stay review-only in active mode; hosts supply plans through an adapter seam (#2347) and core only picks one; the #2345 report and #2346 paired-seed evidence are read through one port. (3) Subject classification runs at write time in one module: deterministic category defaults (user: preference/relationship/moment/commitment; agent: procedure/principle/skill) decide the subject - never an LLM; the subject guard (evaluateSubjectGuard) is shared by the spaces promotion workflow and scope-profile targets so they cannot drift (#2372). (4) Backfill is deterministic shadow/apply that stamps subject only via the category defaults and never reclassifies an existing subject; its storage interface mirrors the pattern-reinforcement structural interface so tests use an in-memory stub; runners take an io seam and the promotion-candidates surface stays read-only. (5) The promotion candidate key uses the same normalize pipeline as dedup so target-equivalence checks match; the tool is registered as engram.promotion_candidates with a canonical remnic alias. (6) The optional local-model endpoint requires model identity, not just a base URL; correction intent is an optional pointer with the rule-based path as default; the local classifier fails closed (null on any failure); batch signal forwarding is an optimization, not a correctness fix.

## Consequences
Record-before-dispatch makes a broken recorder a hard stop rather than degraded service; review-only destructive scope delays deletions behind human review; deterministic subject defaults misfile unusual memories rather than guessing; the optional model endpoint adds no routing value until configured with a model identity.

## Origin comments
- `packages/remnic-core/src/local-model-endpoint.ts:1` - "file header: design rationale dominates over issue #1585 mention"
- `packages/remnic-core/src/local-model-endpoint.ts:48` - "decision: batch signal forwarding is optimization not correctness fix"
- `packages/remnic-core/src/local-model-endpoint.ts:69` - "decision: base URL alone insufficient, model identity required"
- `packages/remnic-core/src/local-model-endpoint.ts:87` - "rationale: optional pointer, rule-based path stays default"
- `packages/remnic-core/src/local-model-endpoint.ts:107` - "contract: fail-closed null on any failure"
- `packages/remnic-core/src/local-model-endpoint.ts:127` - "implementation note: manual AbortSignal wiring, ES2024 forbidden"
- `packages/remnic-core/src/memory-controller.test.ts:88` - "Gate proof: the choice record must precede any dispatch."
- `packages/remnic-core/src/memory-controller.ts:8` - "Gated unified memory controller (#2348). One state enters, one choice leaves. Host-free: every effectful collaborator"
- `packages/remnic-core/src/memory-controller.ts:20` - "#2347 adapter seam: the host supplies plans, core only picks one."
- `packages/remnic-core/src/memory-controller.ts:36` - "#2345 report + #2346 paired-seed evidence, read through one port."
- `packages/remnic-core/src/memory-controller.ts:160` - "`discard` (and any destructive change) stays review-only in active mode."
- `packages/remnic-core/src/memory-controller.ts:406` - "Shadow records before any active dispatch."
- `packages/remnic-core/src/memory-controller.ts:414` - "Bad recorder stops work: no dispatch, no outcome event."
- `packages/remnic-core/src/memory-controller.ts:445` - "First active scope: reversible actions only."
- `packages/remnic-core/src/memory-subject-cli.ts:1` - "CLI surface: promotion-candidates is read-only; subjects backfill is deterministic shadow/apply; runners take an io seam"
- `packages/remnic-core/src/memory-subject.ts:1` - "Subject says WHOM a memory is about (user models one person; agent models how to operate). Module owns write-time classi"
- `packages/remnic-core/src/memory-subject.ts:44` - "Deterministic category defaults (user: preference/relationship/moment/commitment; agent: procedure/principle/skill); oth"
- `packages/remnic-core/src/memory-subject.ts:96` - "evaluateSubjectGuard shared by spaces promotion workflow and scope-profile targets so they cannot drift (issue #2372 acc"
- `packages/remnic-core/src/memory-subject.ts:153` - "promotionCandidateKey must use the same normalize pipeline as dedup so target-equivalence checks match"
- `packages/remnic-core/src/memory-subject.ts:220` - "Tool registered as engram.promotion_candidates; withToolAliases emits canonical remnic.promotion_candidates alias (dual-"
- `packages/remnic-core/src/memory-subject.ts:253` - "SubjectBackfillStorage mirrors pattern-reinforcement structural interface so tests pass an in-memory stub; writeMemoryFr"
- `packages/remnic-core/src/memory-subject.ts:277` - "Backfill stamps subject ONLY via deterministic category defaults — never an LLM, never reclassifies an existing subject "
