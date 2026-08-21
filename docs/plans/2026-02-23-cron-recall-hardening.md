# Cron Recall Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make cron recall robust for all open-source users by normalizing instruction-heavy cron prompts before retrieval, reducing expensive retrieval paths for those prompts, and adding regression tests that prevent QMD query instability regressions.

**Architecture:** Add a dedicated recall-query policy layer that derives a retrieval query from the raw prompt and session context. For instruction-heavy cron prompts, use a compact normalized query and skip conversation semantic recall. Keep existing recall behavior for normal interactive/chat-like prompts. This preserves compatibility while protecting QMD from oversized/noisy query payloads.

**Tech Stack:** TypeScript, OpenClaw Engram orchestrator/config pipeline, Node test runner (`tsx --test`).

---

### Task 1: Add cron-safe recall query policy primitives

**Files:**
- Create: `src/recall-query-policy.ts`
- Modify: `src/types.ts`
- Test: `tests/recall-query-policy.test.ts`

**Step 1: Write failing tests for query policy classification and normalization**
- Add tests that verify:
  - instruction-heavy cron prompt is detected
  - normalized query is compact and stable (caps, path stripping)
  - non-cron prompts preserve near-raw behavior

**Step 2: Implement query policy module**
- Add:
  - prompt-shape classifier (`instruction_heavy` vs `standard`)
  - query normalization helpers (whitespace collapse, path removal, token extraction)
  - policy resolver returning:
    - `retrievalQuery`
    - `skipConversationRecall`
    - `retrievalBudgetMode` (`full`/`minimal`)

**Step 3: Run focused tests**
- Run: `npx tsx --test tests/recall-query-policy.test.ts`

**Step 4: Commit**
- `git add src/recall-query-policy.ts src/types.ts tests/recall-query-policy.test.ts`
- `git commit -m "feat(recall): add cron-safe recall query policy primitives"`

### Task 2: Wire policy into recall pipeline

**Files:**
- Modify: `src/orchestrator.ts`
- Test: `tests/recall-no-recall-short-circuit.test.ts`

**Step 1: Add failing integration tests for cron policy wiring**
- Add tests that verify when prompt is instruction-heavy cron:
  - QMD receives normalized compact query (not raw prompt blob)
  - conversation semantic recall path is skipped
- Add a control test for standard prompt where behavior remains unchanged.

**Step 2: Implement orchestration wiring**
- In `recallInternal`:
  - compute policy once using prompt + sessionKey
  - use `retrievalQuery` for:
    - qmd/hybrid search
    - embedding fallback search
    - rerank query
    - cold fallback query
  - use raw prompt for user-facing heuristics that should stay semantic to intent-routing only when needed; otherwise use normalized query in retrieval path
  - gate conversation recall on `skipConversationRecall`
  - enforce minimal recall cap only when policy says `minimal`

**Step 3: Run focused recall tests**
- Run: `npx tsx --test tests/recall-no-recall-short-circuit.test.ts`

**Step 4: Commit**
- `git add src/orchestrator.ts tests/recall-no-recall-short-circuit.test.ts`
- `git commit -m "feat(recall): apply cron query policy in recall pipeline"`

### Task 3: Add user-configurable policy controls (safe defaults)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `openclaw.plugin.json`
- Test: `tests/config-cron-recall-policy.test.ts`

**Step 1: Add failing config tests**
- Verify defaults:
  - policy enabled
  - reasonable query caps
- Verify explicit values including `0` semantics where intended.

**Step 2: Implement config fields**
- Add fields (default-on safe behavior):
  - `cronRecallPolicyEnabled`
  - `cronRecallNormalizedQueryMaxChars`
  - `cronRecallInstructionHeavyTokenCap`
  - `cronConversationRecallMode` (`auto`/`always`/`never`)
- Ensure parse symmetry and compatibility with existing config.

**Step 3: Run config tests**
- Run: `npx tsx --test tests/config-cron-recall-policy.test.ts tests/config-cold-qmd.test.ts`

**Step 4: Commit**
- `git add src/types.ts src/config.ts openclaw.plugin.json tests/config-cron-recall-policy.test.ts`
- `git commit -m "feat(config): add cron recall policy controls with safe defaults"`

### Task 4: Document and harden operations guidance

**Files:**
- Modify: `docs/setup-config-tuning.md`
- Modify: `docs/operations.md`
- Modify: `docs/ops/pr-review-hardening-playbook.md` (only if checklist entry needed)

**Step 1: Update tuning docs**
- Document new cron recall policy knobs and recommended defaults.
- Add guidance for instruction-heavy cron prompts and retrieval behavior.

**Step 2: Update operations doc**
- Add troubleshooting matrix:
  - oversized cron prompt symptoms
  - normalization behavior
  - how to toggle `cronConversationRecallMode`

**Step 3: Commit docs**
- `git add docs/setup-config-tuning.md docs/operations.md`
- `git commit -m "docs(cron): document recall policy and troubleshooting"`

### Task 5: Run verification + hardening gate

**Files:**
- Modify: `.claude/napkin.md` (learned behavior)

**Step 1: Build + targeted tests**
- Run:
  - `npm run build`
  - `npx tsx --test tests/recall-query-policy.test.ts tests/config-cron-recall-policy.test.ts tests/recall-no-recall-short-circuit.test.ts`

**Step 2: Run mandatory hardening gate**
- Follow `docs/ops/pr-review-hardening-playbook.md` and execute required checks for touched subsystems (`orchestrator.ts`, `config.ts`, retrieval paths).

**Step 3: Runtime smoke validation**
- Validate in running instance:
  - allowlisted cron still recalls
  - non-allowlisted cron still skips recall
  - instruction-heavy cron logs normalized policy path and avoids conversation recall when `auto` mode applies

**Step 4: Final status summary**
- Report what changed, verification evidence, residual risks, and next steps.

