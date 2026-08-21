# PR20 Verified Episodic Recall Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the first verified episodic recall slice by retrieving recent episodic boxes, validating their cited source memories, and surfacing the verified result as a dedicated recall section and CLI diagnostic behind new config flags.

**Architecture:** Reuse the existing memory-box substrate instead of inventing a second episodic store. A new verified-recall module should score recent boxes against the query, resolve each box's `memoryIds` through storage, keep only verified episode memories, and format a bounded `## Verified Episodes` recall section. This slice stays additive: no semantic-rule promotion yet, no recall-time downgrade heuristics yet.

**Tech Stack:** TypeScript, Node.js, existing Engram storage/boxes/orchestrator/CLI patterns, node:test via `tsx --test`

---

### Task 1: Define the PR20 contract in tests

**Files:**
- Create: `tests/verified-recall.test.ts`
- Modify: `tests/config-eval-harness.test.ts`

**Step 1: Write the failing tests**

- Add a focused test file that seeds:
  - one recent episodic box with `goal`, `toolsUsed`, `memoryIds`
  - one verified `episode` memory referenced by the box
  - one non-episodic `note` memory to prove filtering
- Cover:
  - verified recall search returns only boxes with resolved episodic source memories
  - missing or note-only `memoryIds` do not count as verified support
  - CLI command returns bounded verified episodic results
  - recall injects `## Verified Episodes` only when the flag and pipeline section are enabled
- Extend config-contract tests for:
  - `verifiedRecallEnabled`
  - `semanticRulePromotionEnabled`
  - default recall-pipeline entry for `verified-episodes`

**Step 2: Run the targeted tests to verify they fail**

Run:
- `npx tsx --test tests/verified-recall.test.ts tests/config-eval-harness.test.ts`

Expected:
- FAIL because the new flags, module, and recall section do not exist yet.

### Task 2: Implement verified episodic retrieval

**Files:**
- Create: `src/verified-recall.ts`
- Modify: `src/storage.ts`

**Step 1: Write the minimal retrieval implementation**

- Add a verified-recall module that:
  - reads recent boxes via `BoxBuilder.readRecentBoxes`
  - resolves each `memoryId` via `StorageManager.getMemoryById`
  - counts only source memories with `frontmatter.memoryKind === "episode"` and non-archived status
  - scores boxes from query overlap over `topics`, `goal`, `toolsUsed`, and verified episode content
  - returns a typed result with:
    - `box`
    - `score`
    - `verifiedEpisodeCount`
    - `matchedFields`
    - `verifiedMemoryIds`
- Keep behavior fail-open when box files or memory lookups are malformed.

**Step 2: Run the new targeted tests**

Run:
- `npx tsx --test tests/verified-recall.test.ts`

Expected:
- PASS for the new retrieval contract.

### Task 3: Wire flags, CLI, and recall section

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Modify: `src/orchestrator.ts`
- Modify: `openclaw.plugin.json`

**Step 1: Add config and CLI wiring**

- Add flags:
  - `verifiedRecallEnabled`
  - `semanticRulePromotionEnabled` (declared but not behaviorally used yet)
- Add default recall-pipeline section:
  - `id: "verified-episodes"`
- Add CLI:
  - `openclaw engram verified-recall-search <query>`

**Step 2: Inject a dedicated recall section**

- Add a `verifiedRecallPromise` in the orchestrator that appends:
  - `## Verified Episodes`
- Format results with:
  - sealed timestamp
  - goal or topics
  - verified episode count
  - matched fields

**Step 3: Run targeted wiring tests**

Run:
- `npx tsx --test tests/verified-recall.test.ts tests/config-eval-harness.test.ts`

Expected:
- PASS with the new CLI/config/recall wiring.

### Task 4: Update docs and theory

**Files:**
- Modify: `README.md`
- Modify: `docs/config-reference.md`
- Modify: `CHANGELOG.md`
- Modify: `THEORY.MD`

**Step 1: Document the new slice**

- Describe verified episodic recall as:
  - recent episodic windows
  - source-memory verification
  - dedicated recall section
  - additive precursor to semantic rule promotion

**Step 2: Rewrite theory**

- Update `THEORY.MD` so the current theory explains why PR20 uses boxes plus source-memory verification instead of inventing a new episodic memory store.

### Task 5: Full verification and commit

**Files:**
- Verify only

**Step 1: Run the full verification set**

Run:
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`

Expected:
- All green.

**Step 2: Commit**

Run:
- `git add tests/verified-recall.test.ts tests/config-eval-harness.test.ts src/verified-recall.ts src/types.ts src/config.ts src/cli.ts src/orchestrator.ts openclaw.plugin.json README.md docs/config-reference.md CHANGELOG.md THEORY.MD docs/plans/2026-03-07-engram-pr20-verified-episodic-recall.md`
- `git commit -m "feat: add verified episodic recall"`

### Task 6: Open PR20 and run the same PR loop

**Files:**
- Verify only

**Step 1: Push and open PR**

Run:
- `git push -u origin feat/engram-memory-os-pr20-verified-recall`
- `gh pr create --repo joshuaswarren/openclaw-engram --base main --head feat/engram-memory-os-pr20-verified-recall --title "feat: add verified episodic recall" --body-file docs/plans/2026-03-07-engram-pr20-verified-episodic-recall.md`

**Step 2: Loop until merge-ready**

Run:
- full `pr-loop` workflow

Expected:
- all required checks green
- Cursor terminal and clean
- zero unresolved review threads
- manual merge, then branch immediately into PR21
