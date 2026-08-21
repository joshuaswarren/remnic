# Engram Recall QoS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve Engram recall quality and existing features while eliminating prompt-time timeout failures by splitting recall into a fast deterministic core and an optional enrichment path.

**Architecture:** Implement this in six staged slices. First add observability and cheap materialization so we can see exactly where time is going. Then remove the two largest architectural amplifiers: prompt-time summary parsing and synchronous LCM summarize calls. Only after those are stable should we replace the phase-1 `Promise.all(...)` barrier with a budgeted recall scheduler, split local-LLM QoS lanes, and convert QMD into cached enrichment.

**Tech Stack:** TypeScript, Node `node:test`, Engram orchestrator, local LLM client, QMD integration, existing caches in `src/memory-cache.ts`, OpenClaw plugin hooks.

---

## Planning Rules For Spark Subagents

- Use **one Spark subagent per task**. Do not assign two subagents overlapping write ownership.
- Every task must end with fresh verification commands and pasted results in the subagent summary.
- Prefer **new helper modules** over editing huge files in multiple places when the helper can isolate complexity.
- Do not begin Stage 3 before Stages 1 and 2 are merged locally.
- Do not begin Stage 5 before Stage 3 is merged locally.
- `src/orchestrator.ts` is high-conflict. Only one active worker may own it at a time.

## Baseline Verification Before Any Code Changes

Run from repo root:

```bash
npm run check-types
npm test
```

Expected:
- `check-types` exits `0`
- `tsx --test` exits `0`

Capture a short runtime baseline before touching code:

```bash
rg -n "recall phase-1: parallel work done|recall timed out or failed|SLOW local LLM" /tmp/openclaw/openclaw-$(date +%F).log ~/.openclaw/logs/gateway.err.log ~/.openclaw/logs/gateway.log | tail -n 100
```

Expected:
- Enough evidence to compare before/after section latency and timeout counts

---

## Stage 1: Observability And Summary Snapshot Foundation

**Why first:** This stage is low-risk and gives the rest of the rollout hard evidence. It also removes one known O(N files) prompt-time cost without touching the recall scheduler yet.

### Task 1.1: Add Recall Section Metrics Types And Logging Helpers

**Owner:** Spark worker 1
**Files:**
- Create: `src/recall-qos.ts`
- Modify: `src/orchestrator.ts`
- Test: `src/recall-qos.test.ts`

**Implementation**
1. Create `src/recall-qos.ts` with small shared types:
   - `RecallSectionPriority = "core" | "enrichment"`
   - `RecallSectionSource = "fresh" | "stale" | "skip"`
   - `RecallSectionMetric`
   - helper for formatting metrics into logs
2. In `src/orchestrator.ts`, replace the ad hoc `timings` string map for the touched sections with structured metrics objects.
3. Emit one structured debug/info log for each recall section with:
   - `section`
   - `priority`
   - `durationMs`
   - `deadlineMs`
   - `source`
   - `success`
4. Keep current behavior unchanged. This task is instrumentation only.

**Verification**

```bash
npm run check-types
npm test -- src/recall-qos.test.ts
```

Expected:
- New unit test passes
- Existing runtime behavior unchanged

**Commit**

```bash
git add src/recall-qos.ts src/orchestrator.ts src/recall-qos.test.ts
git commit -m "feat: add structured recall qos metrics"
```

### Task 1.2: Materialize Hourly Summary Snapshot

**Owner:** Spark worker 2
**Files:**
- Create: `src/summary-snapshot.ts`
- Modify: `src/summarizer.ts`
- Test: `src/summary-snapshot.test.ts`

**Implementation**
1. Create `src/summary-snapshot.ts` with:
   - snapshot schema
   - read/write helpers
   - path helper under `memoryDir/state/summaries/<sessionKey>.json`
2. Modify `HourlySummarizer.saveSummary()` flow to update the snapshot every time a summary is written.
3. Modify `HourlySummarizer.readRecent()` to:
   - try snapshot first
   - fall back to current markdown parsing when snapshot is missing
   - optionally backfill snapshot after fallback read succeeds
4. Keep `formatForRecall()` unchanged.
5. Do not delete markdown summaries. Snapshot is an acceleration layer only.

**Verification**

```bash
npm run check-types
npm test -- src/summary-snapshot.test.ts
```

Expected:
- snapshot read path returns same recall bullets as markdown fallback for identical input

**Commit**

```bash
git add src/summary-snapshot.ts src/summarizer.ts src/summary-snapshot.test.ts
git commit -m "feat: add materialized summary snapshot for recall"
```

### Stage 1 Integration Check

Run:

```bash
npm run check-types
npm test
```

Manual runtime spot check after local build/install in the OpenClaw install happens later, but the code-level success condition for Stage 1 is:
- summary reads are snapshot-first
- no behavior regressions in existing tests

---

## Stage 2: Make LCM Truly Enqueue-Only

**Why second:** Recent logs show `lcm-summarize` jobs consuming the local LLM for tens to hundreds of seconds. The next biggest win is to stop waiting on them from `agent_end`.

### Task 2.1: Add A Small In-Process LCM Work Queue

**Owner:** Spark worker 3
**Files:**
- Create: `src/lcm/queue.ts`
- Modify: `src/lcm/engine.ts`
- Test: `src/lcm/queue.test.ts`

**Implementation**
1. Create `src/lcm/queue.ts` with a minimal queue:
   - keyed by `sessionId`
   - coalesces duplicate pending jobs per session
   - bounded concurrency default `1`
   - exposes queue depth and in-flight count
2. Modify `LcmEngine` to own the queue.
3. Split current behavior into:
   - `enqueueObserveMessages(sessionId, messages): void`
   - internal `processObserveMessages(sessionId, messages): Promise<void>`
4. Keep `summarizeIncremental()` inside the queue worker, not the caller.
5. Add metric/log helpers for queue depth and job latency.

**Verification**

```bash
npm run check-types
npm test -- src/lcm/queue.test.ts
```

Expected:
- duplicate enqueue calls for one session coalesce
- queue continues after worker failure

**Commit**

```bash
git add src/lcm/queue.ts src/lcm/engine.ts src/lcm/queue.test.ts
git commit -m "feat: queue lcm observation work"
```

### Task 2.2: Remove Synchronous LCM Await Sites

**Owner:** Spark worker 4
**Files:**
- Modify: `src/index.ts`
- Modify: `src/access-service.ts`
- Modify: `src/lcm/engine.ts`
- Test: `src/lcm-engine.test.ts`

**Implementation**
1. Change `agent_end` in `src/index.ts` to call the new enqueue-only method and never await summarization completion.
2. Confirm `src/access-service.ts` uses the same enqueue-only path so behavior is consistent.
3. Keep `preCompactionFlush()` synchronous for now; that is a separate explicit durability path.
4. Add tests covering:
   - `observeMessages` caller returns before summarize finishes
   - queue worker still appends archive rows and runs summarize in background

**Verification**

```bash
npm run check-types
npm test -- src/lcm-engine.test.ts
```

Expected:
- caller-facing path no longer blocks on summarization promise completion

**Commit**

```bash
git add src/index.ts src/access-service.ts src/lcm/engine.ts src/lcm-engine.test.ts
git commit -m "feat: make lcm observe path enqueue only"
```

### Stage 2 Integration Check

Run:

```bash
npm run check-types
npm test
```

Success criteria:
- no synchronous `await this.summarizer!.summarizeIncremental(...)` remains in the hot turn path
- queue metrics/logs exist

---

## Stage 3: Introduce A Budgeted Recall Scheduler

**Why third:** Once summary recall is O(1) and LCM contention is reduced, the next structural fix is removing the all-or-nothing phase-1 barrier.

### Task 3.1: Create Scheduler Primitive Without Switching Recall Yet

**Owner:** Main agent or one Spark worker with exclusive ownership of `src/orchestrator.ts`
**Files:**
- Create: `src/recall-scheduler.ts`
- Test: `src/recall-scheduler.test.ts`

**Implementation**
1. Create `src/recall-scheduler.ts` with:
   - `RecallSectionSpec<T>`
   - `runRecallSections(specs, abortSignal)`
   - per-section deadline handling
   - fallback source tagging: `fresh`, `stale`, `skip`
2. Test scheduler in isolation:
   - core sections resolve first
   - enrichment section timeout returns fallback
   - abort signal cancels pending sections
3. Do not wire it into `src/orchestrator.ts` yet.

**Verification**

```bash
npm run check-types
npm test -- src/recall-scheduler.test.ts
```

**Commit**

```bash
git add src/recall-scheduler.ts src/recall-scheduler.test.ts
git commit -m "feat: add recall section scheduler"
```

### Task 3.2: Move Recall Assembly To Core-First Scheduling

**Owner:** Same owner as Task 3.1
**Files:**
- Modify: `src/orchestrator.ts`
- Test: `src/orchestrator-recall-scheduler.test.ts`

**Implementation**
1. Replace the current phase-1 `Promise.all(...)` block with explicit section specs.
2. Tag sections:
   - `core`: profile, identity continuity, verified recall, verified rules, transcript, objective state, trust zone, summary snapshot, cached conversation recall
   - `enrichment`: QMD, harmonic retrieval, graph expansion, rerank, compounding, any uncached expensive extras
3. Build section fallbacks:
   - summaries: snapshot fallback
   - QMD: stale cached rendered section or skip
   - rerank: original order
   - conversation recall: empty result
4. Prompt assembly should begin from completed core sections even if enrichment remains pending or times out.
5. Preserve section ordering in final prompt.
6. Keep outer 75s timeout unchanged in this task; the success condition is that fewer sections can consume it.

**Verification**

```bash
npm run check-types
npm test -- src/orchestrator-recall-scheduler.test.ts
```

Expected:
- test proves a slow enrichment section does not block core prompt assembly

**Commit**

```bash
git add src/orchestrator.ts src/orchestrator-recall-scheduler.test.ts
git commit -m "feat: schedule recall with core and enrichment budgets"
```

### Stage 3 Integration Check

Run:

```bash
npm run check-types
npm test
```

Success criteria:
- no phase-1 `Promise.all(...)` barrier over every recall section remains
- logs show `source=fresh|stale|skip` and core vs enrichment timing

---

## Stage 4: Split Local LLM QoS Lanes

**Why fourth:** This stage reduces residual contention after the scheduler exists. It is easier and safer once the scheduler can already degrade gracefully.

### Task 4.1: Add Priority-Aware Local LLM Queueing

**Owner:** Spark worker 5
**Files:**
- Modify: `src/local-llm.ts`
- Create: `src/local-llm-qos.test.ts`

**Implementation**
1. Add an internal request queue with at least two priorities:
   - `recall-critical`
   - `background`
2. Default existing non-tagged calls to current behavior so the patch is non-breaking.
3. Add an optional `priority` field to local LLM request options.
4. Ensure a ready recall-critical request is selected before background work when both are queued.
5. Add metrics/log lines for queue wait time by priority.

**Verification**

```bash
npm run check-types
npm test -- src/local-llm-qos.test.ts
```

**Commit**

```bash
git add src/local-llm.ts src/local-llm-qos.test.ts
git commit -m "feat: add local llm qos priorities"
```

### Task 4.2: Tag Call Sites By Priority

**Owner:** Spark worker 6
**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/lcm/summarizer.ts`
- Modify: `src/extraction.ts`
- Modify: `src/semantic-consolidation.ts` if present and active
- Test: `src/local-llm-priority-callers.test.ts`

**Implementation**
1. Mark prompt-time recall/rerank calls as `recall-critical`.
2. Mark LCM summarize, extraction, consolidation, and other maintenance paths as `background`.
3. Verify all `operation: "lcm-summarize"` call sites are background-tagged.
4. Add tests or spies proving the expected priority reaches the client.

**Verification**

```bash
npm run check-types
npm test -- src/local-llm-priority-callers.test.ts
```

**Commit**

```bash
git add src/orchestrator.ts src/lcm/summarizer.ts src/extraction.ts src/local-llm-priority-callers.test.ts
git commit -m "feat: tag local llm calls by qos lane"
```

### Stage 4 Integration Check

Run:

```bash
npm run check-types
npm test
```

Success criteria:
- `lcm-summarize` is always background priority
- prompt-time rerank/recall calls are recall-critical

---

## Stage 5: Convert QMD To Cached Enrichment

**Why fifth:** This is valuable but high-risk. It should come after the scheduler and QoS work so cold QMD no longer defines system availability.

### Task 5.1: Add Rendered QMD Recall Cache

**Owner:** Spark worker 7
**Files:**
- Create: `src/qmd-recall-cache.ts`
- Modify: `src/qmd.ts`
- Modify: `src/orchestrator.ts`
- Test: `src/qmd-recall-cache.test.ts`

**Implementation**
1. Create a short-TTL in-process cache keyed by:
   - normalized query
   - namespace set
   - recall mode
   - topK/fetch limit
2. Cache rendered or nearly-rendered recall inputs, not just raw subprocess output.
3. In recall:
   - hot hit -> use as `source=stale|fresh` depending on TTL
   - miss -> scheduler fallback is skip or stale cache, not blocking
4. Keep existing direct QMD code path available behind the scheduler’s enrichment section.

**Verification**

```bash
npm run check-types
npm test -- src/qmd-recall-cache.test.ts
```

**Commit**

```bash
git add src/qmd-recall-cache.ts src/qmd.ts src/orchestrator.ts src/qmd-recall-cache.test.ts
git commit -m "feat: cache qmd recall enrichment"
```

### Task 5.2: Add Warm Working-Set Candidate Fallback

**Owner:** Spark worker 8
**Files:**
- Create: `src/recall-working-set.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/entity-retrieval.ts` if needed for candidate seeds
- Test: `src/recall-working-set.test.ts`

**Implementation**
1. Build a deterministic candidate pool from:
   - recent session artifacts
   - recent verified items
   - recent hot entities
2. When no hot QMD cache exists, use working-set results as the cheap enrichment fallback for the current turn.
3. Schedule actual cold QMD in background to refresh cache for the next turn.

**Verification**

```bash
npm run check-types
npm test -- src/recall-working-set.test.ts
```

**Commit**

```bash
git add src/recall-working-set.ts src/orchestrator.ts src/entity-retrieval.ts src/recall-working-set.test.ts
git commit -m "feat: add qmd working-set fallback for recall"
```

### Stage 5 Integration Check

Run:

```bash
npm run check-types
npm test
```

Success criteria:
- cold QMD no longer blocks prompt assembly
- QMD quality can still improve subsequent turns via cache refresh

---

## Stage 6: Tighten Budgets, Reduce Timeout Exposure, And Verify In OpenClaw

**Why last:** Only after architecture changes land should we tune thresholds and prove the install behavior improved.

### Task 6.1: Budget Tuning And Outer Timeout Review

**Owner:** Main agent
**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/config.ts`
- Modify: `openclaw.plugin.json`
- Test: `src/recall-budget-config.test.ts`

**Implementation**
1. Add explicit config for:
   - core recall max budget
   - enrichment per-section deadlines
   - stale-cache age thresholds
2. Re-evaluate whether the outer `75_000ms` timeout can be lowered after the scheduler is in place.
3. Keep defaults conservative for first rollout.

**Verification**

```bash
npm run check-types
npm test -- src/recall-budget-config.test.ts
```

### Task 6.2: Install-Level Verification In OpenClaw

**Owner:** Main agent after code is merged and built
**Files:** none in repo unless a follow-up issue/changelog is needed

**Run**

```bash
npm run build
npm test
openclaw gateway status
```

Then capture post-install evidence from the OpenClaw install:

```bash
rg -n "recall phase-1|source=|priority=|recall timed out or failed|SLOW local LLM" /tmp/openclaw/openclaw-$(date +%F).log ~/.openclaw/logs/gateway.log ~/.openclaw/logs/gateway.err.log | tail -n 200
```

Success criteria:
- core recall sections complete within budget in logs
- enrichment misses produce `source=stale` or `source=skip`, not empty recall
- recall timeout count drops materially
- `SLOW local LLM` still may exist for background work, but no longer correlates with recall failure

---

## Recommended Execution Order

1. Task 1.1
2. Task 1.2
3. Integrate and run full tests
4. Task 2.1
5. Task 2.2
6. Integrate and run full tests
7. Task 3.1
8. Task 3.2
9. Integrate and run full tests
10. Task 4.1
11. Task 4.2
12. Integrate and run full tests
13. Task 5.1
14. Task 5.2
15. Integrate and run full tests
16. Task 6.1
17. Task 6.2

## Parallelization Guidance

- Safe in parallel:
  - Task 1.1 and Task 1.2
  - Task 2.1 and a read-only prep review for Task 2.2
  - Task 4.1 and a read-only prep review for Task 4.2
- Not safe in parallel:
  - Any two tasks editing `src/orchestrator.ts`
  - Task 3.2 with any other implementation task
  - Task 5.1 with Task 5.2

## Subagent Handoff Template

Use this exact prompt shape for each Spark worker:

```text
Implement only Task X.Y from docs/plans/2026-03-26-engram-recall-qos-implementation.md.

Constraints:
- You own only the listed files for Task X.Y.
- Do not edit files owned by other pending tasks.
- Follow the repo's existing node:test + TypeScript patterns.
- Use minimal changes that satisfy the task.
- Run the listed verification commands.
- In your final response, include:
  1. files changed
  2. verification commands run
  3. any follow-up risks or integration notes
```

## Acceptance Criteria

- No single optional enrichment section can cause recall to return empty context.
- Summary recall is snapshot-backed and no longer reparses all markdown files on each recall.
- `agent_end` no longer waits on LCM summarization.
- Recall assembly is core-first with explicit deadlines and fallback sources.
- Local LLM requests distinguish recall-critical from background work.
- QMD remains feature-complete but behaves as cached enrichment instead of a hard blocker.
- OpenClaw runtime logs show lower recall timeout frequency and better phase attribution.
