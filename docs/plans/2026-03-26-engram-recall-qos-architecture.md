# Engram Recall QoS Architecture Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve Engram's current recall quality and feature set while making prompt-time recall reliably fast enough to avoid user-visible latency spikes and 75s timeout failures.

**Architecture:** Split recall into a budgeted fast lane and an asynchronous enrichment lane. Move background summarization off the recall-critical local LLM lane, materialize slow query-agnostic sections ahead of time, and treat expensive enrichments as stale-cache-backed optional inputs instead of hard blockers for prompt assembly.

**Tech Stack:** TypeScript, OpenClaw plugin SDK, Engram orchestrator, QMD, better-sqlite3, local LLM endpoints, existing Engram caches.

---

## Problem Statement

Recent production evidence shows recall is no longer dominated by full-disk scans. The remaining failures come from architectural coupling:

1. `recall()` has a hard 75s outer timeout.
2. `recallInternal()` waits for every phase-1 promise before assembling prompt sections.
3. Optional slow sections still run inline at prompt time:
   - QMD hybrid retrieval
   - hourly summaries
   - local reranking
4. Background LCM summarization shares the same local LLM lane as prompt-time recall work.
5. Some hook paths still `await` LCM summarization directly, which amplifies contention.

The result is that core recall is already fast, but optional enrichment can still consume the full request budget and cause an empty recall result.

## Evidence Summary

- Outer recall timeout: `src/orchestrator.ts` lines 2710-2727
- All phase-1 work is awaited together: `src/orchestrator.ts` lines 4706-4791
- Summary recall reads and parses every summary markdown file on each recall: `src/orchestrator.ts` line 4579, `src/summarizer.ts` lines 440-462
- Optional local rerank still runs inline after QMD: `src/orchestrator.ts` lines 5026-5041
- LCM summarization uses the main local LLM client with `operation: "lcm-summarize"`: `src/orchestrator.ts` lines 1093-1106
- Slow local LLM warnings show 30s-200s `lcm-summarize` jobs: `src/local-llm.ts` lines 884-890
- LCM still awaits summarization inside `observeMessages()`: `src/lcm/engine.ts` lines 88-109
- `agent_end` still awaits `observeMessages()` synchronously: `src/index.ts` lines 562-574

## Root Cause

This is no longer a storage-read bottleneck. It is now a QoS and scheduling problem:

1. Core recall and optional enrichment share one prompt-time critical path.
2. Optional enrichment and background summarization share one local-LLM execution lane.
3. Some slow sections are recomputed on demand instead of read from a precomputed/materialized view.
4. The system has caches, but they are not applied consistently at the architectural boundary where the timeout risk lives.

## Architectural Target

Recall must become:

- **Fast lane:** always returns a useful prompt section within a small bounded budget.
- **Enrichment lane:** can improve the next turn or current cache state, but can never force recall failure.

The system should optimize for:

- deterministic prompt-time completion
- graceful degradation
- cache-first reads for query-agnostic sections
- explicit separation of recall-critical and background LLM workloads

## Proposed Architecture

### 1. Two-Lane Recall Pipeline

Replace the current "await everything, then assemble" model with two explicit lanes.

**Lane A: Core Recall**
- Hard budget: 2-5 seconds target, 8 seconds max
- Must be entirely cache-backed or locally deterministic
- Includes:
  - profile
  - identity continuity
  - verified recall / verified rules
  - transcript tail
  - artifacts / objective state / trust zone / native knowledge
  - cached conversation recall
  - cached summaries snapshot

**Lane B: Enrichment Recall**
- Runs concurrently, but is optional
- Includes:
  - QMD hybrid retrieval
  - graph expansion
  - harmonic retrieval
  - local reranking
  - uncached summary rebuilds

If Lane B misses its per-section budget, use stale cache or skip it for the current turn and write the fresh result back for the next turn.

### 2. Budgeted Section Scheduler

Replace the monolithic `Promise.all(...)` phase-1 barrier with a scheduler:

- Every recall section gets:
  - `priority`: core | enrichment
  - `deadlineMs`
  - `fallback`: stale-cache | skip | deterministic substitute
- The scheduler collects sections as they resolve.
- Prompt assembly begins once core sections are complete or their deadlines expire.
- Enrichment results that miss the current turn can still update a cache for the next turn.

This changes recall from "all-or-nothing" to "assemble best available context under budget."

### 3. Materialized Summary Snapshot

Current summary recall is too expensive because it scans and parses all summary markdown files for a session on every recall.

Replace `summarizer.readRecent()` prompt-time parsing with a materialized session summary snapshot:

- Write `state/summaries/<sessionKey>.json` or SQLite rowset on summary generation/update.
- Store:
  - recent hourly bullets
  - timestamps
  - already-truncated recall form
- Prompt-time recall reads one compact object, not N markdown files.

This preserves the summary feature while making it O(1) at recall time.

### 4. QMD as Cached Enrichment, Not Hard Blocker

QMD remains valuable, but it cannot remain a hard barrier for prompt assembly.

Refactor QMD integration into:

- **Hot cache layer**
  - key: normalized query + namespace + retrieval mode + topK
  - very short TTL for exact query reuse
- **Warm semantic working set**
  - precomputed candidate pools from recent hot facts / recent session activity / recent top entities
- **Async enrichment update**
  - if no hot hit, run QMD in background with a smaller budget and cache the result

Prompt-time behavior:
- if hot cache exists: use it
- else if warm working-set candidate exists: use deterministic lexical/vector subset
- else: skip QMD for this turn and schedule enrichment

This preserves QMD quality over time without forcing every turn to wait for cold search.

### 5. Separate Local LLM QoS Lanes

Background summarization and recall-critical work must stop contending for the same expensive local model endpoint.

Create separate LLM classes of service:

- **Recall-critical lane**
  - fast model only
  - bounded concurrency
  - only for prompt-time recall/rerank tasks
- **Background lane**
  - LCM summarization
  - extraction
  - TMT / consolidation / archival summarization
  - lower priority / separate worker / separate endpoint if available

If one endpoint must be shared, introduce an in-process priority queue so recall work preempts background jobs.

### 6. Make LCM Truly Asynchronous Everywhere

`access-service.ts` already fire-and-forgets, but the LCM engine itself still awaits summarization and the `agent_end` hook still awaits `observeMessages()`.

Refactor:

- `observeMessages()` should enqueue work, not await summarization
- `agent_end` should never await LCM summarization
- incremental LCM summarization should run in a dedicated worker loop with:
  - queue depth
  - coalescing
  - backpressure
  - max concurrent sessions

This preserves LCM fidelity while removing it as a recall amplifier.

### 7. Stale-Cache-Backed Fallbacks

For expensive enrichment sections:

- Keep last successful rendered section text
- Store metadata:
  - generatedAt
  - source query
  - namespace
  - quality/confidence markers
- If fresh computation misses deadline, use:
  - stale rendered section if not too old
  - otherwise omit section

This is better than returning an empty recall because one optional enrichment missed budget.

## Proposed Implementation Phases

### Phase 1: Instrumentation and Safe QoS Boundaries

- Add per-section recall metrics:
  - startedAt
  - completedAt
  - deadlineMet
  - source = fresh | stale | skipped
- Add queue metrics for:
  - LCM summarize
  - extraction
  - rerank
- Add cache-hit metrics for:
  - QMD
  - summaries snapshot
  - rerank cache

### Phase 2: Remove Known Prompt-Time Anti-Patterns

- Materialize summary snapshot and stop parsing markdown on recall
- Make `agent_end` LCM enqueue-only
- Make `observeMessages()` enqueue-only
- Add strict per-section deadlines for QMD, summaries, rerank

### Phase 3: Introduce Recall Scheduler

- Replace phase-1 `Promise.all` with a budget-aware scheduler
- Assemble prompt from completed core sections first
- Treat enrichment sections as optional late arrivals

### Phase 4: Split LLM QoS Lanes

- Route recall-critical rerank to fast lane
- Route LCM/extraction summarization to background lane
- Add priority-aware queueing if only one endpoint exists

### Phase 5: QMD Enrichment Cache

- Add rendered/candidate cache for QMD recall
- Precompute working-set candidates on write / background cycles
- Convert cold QMD from inline dependency to async enrichment producer

## Acceptance Criteria

### Reliability
- No empty recall result unless core recall itself fails
- Recall timeout rate reduced to near-zero under normal load

### Latency
- Core recall p50 < 3s
- Core recall p95 < 8s
- Full enriched recall p95 may exceed that internally, but must not block prompt assembly

### Quality
- Verified recall and rules remain present
- QMD quality remains available via cache/enrichment
- LCM fidelity preserved, but shifted out of the prompt-time hot path

### Observability
- Able to attribute recall latency to exact section classes
- Able to distinguish:
  - slow QMD
  - slow summaries snapshot generation
  - slow rerank
  - background LLM contention

## Recommendation

Implement this as a recall QoS redesign, not another round of micro-optimizations.

The current architecture still assumes that "optional but useful" recall sections can be awaited inline as long as each subsystem is somewhat faster. Production evidence now shows that assumption is false.

The right fix is to make recall deadline-aware by construction.
