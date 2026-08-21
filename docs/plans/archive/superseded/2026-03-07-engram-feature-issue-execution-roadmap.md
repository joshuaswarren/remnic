# Engram Feature Issue Execution Roadmap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Execute the open Engram feature-request issue set in an order that respects technical dependencies, avoids overlap with in-flight work, and makes parallel work possible without destabilizing the repo.

**Architecture:** Treat the backlog as layered workstreams rather than a flat numeric queue. Build foundational storage, namespace, and source-adapter contracts first; then complete retrieval/reasoning features; then add learning loops, source-specific adapters, and operator surfaces on top. Use explicit merge gates between phases so high-churn files such as `src/orchestrator.ts`, `src/config.ts`, `src/tools.ts`, `openclaw.plugin.json`, and docs are not rewritten by multiple agents at once.

**Tech Stack:** TypeScript, OpenClaw plugin hooks/tools, markdown storage, QMD and future backends, shared-context filesystem artifacts, projected read models, MCP/HTTP adapters, GitHub issues.

---

## Execution Rules

1. Do not start roadmap items that overlap the current in-flight implementation from the `2026-03-06` and `2026-03-07` plan work until that branch lands or is explicitly abandoned.
2. `src/orchestrator.ts`, `src/config.ts`, `src/types.ts`, `src/tools.ts`, `openclaw.plugin.json`, and architecture docs are merge-hot files. At most one active branch should make broad changes to those files at a time unless the work is narrowly scoped and coordinated.
3. Foundations first. Any issue that defines a contract for later issues should land before its dependents.
4. Parallel work is allowed only when write scope is mostly disjoint or when the dependent interface has already been frozen in a merged PR.
5. Documentation and preset cleanup should be last, after the capability surface is stable enough to document honestly.

## Status Legend

- `Must wait`: do not start until blockers are merged.
- `Can run in parallel`: safe to run beside other work if each branch has a disjoint write scope or a frozen interface.
- `Merge gate`: finish and merge before opening the next dependent band.

## Phase 0: Integration Gate

**Purpose:** Avoid colliding with the currently in-flight agent work.

**Must wait:**
- Current work implementing the `2026-03-06` and `2026-03-07` plan-derived PRs

**Exit criteria:**
- In-flight branch merged or explicitly shelved
- Working tree audited for drift
- Open issues rechecked so the roadmap still reflects reality

## Phase 1: Core Foundations

### 1A. Lifecycle and projection substrate

- `#159` Lifecycle Ledger and Derived Projection Store

**Why first:**
- Establishes event schema, rebuild semantics, and fast read models needed by later APIs, review tooling, consoles, and health tooling.

**Blocks:**
- `#160`
- `#161`
- `#164`
- `#166`
- strengthens `#162`, `#179`, `#180`

**Marker:**
- `Must wait` for most operator/control-plane work

### 1B. Namespace completion

- `#176` Complete Namespace-Aware Retrieval and Migration Tooling

**Why early:**
- Namespace read/write and retrieval semantics should be stable before external access, native knowledge adapters, and richer recall sources are added.

**Blocks:**
- `#160` final access semantics
- `#162` final privacy/namespace integration
- `#179`
- `#180`
- `#164`

**Can run in parallel with:**
- late work on `#159` only if the ledger/projection schema is already frozen and branches avoid broad orchestrator rewrites

**Recommended gate:**
- Merge `#159`, then `#176`

## Phase 2: Shared Knowledge Substrate

### 2A. Native knowledge base layer

- `#162` Native Knowledge Sync

**Why here:**
- This is the shared substrate for curated non-memory sources. It should exist before source-specific adapters.

**Blocks:**
- `#179`
- `#180`
- contributes to `#165`

**Must wait for:**
- `#176` namespace/privacy semantics to be stable

### 2B. Universal access layer

- `#160` Universal Agent Access Layer (HTTP + MCP)

**Why here:**
- Once lifecycle/projection and namespace behavior are stable, expose one service layer through OpenClaw, HTTP, and MCP.

**Blocks:**
- `#161`
- much of `#166`

**Must wait for:**
- `#159`
- `#176`

**Can run in parallel with:**
- `#162` if the internal service contracts are frozen and each branch avoids overlapping adapter/service files

### 2C. Explicit memory capture

- `#163` Structured Explicit Capture Modes

**Why here:**
- Can land after the foundational write/read semantics are stable and before audit/review features that need explicit-capture state.

**Blocks:**
- contributes to `#164`

**Can run in parallel with:**
- `#160` or `#162` if the branch is kept mostly to extraction/tooling/persistence paths

## Phase 3: Retrieval and Reasoning Core

### 3A. Complete query-aware retrieval

- `#167` Complete v8.1 Query-Aware Retrieval

**Why first in this band:**
- Finishes the retrieval pipeline before graph expansion and entity-specific behaviors stack on top.

**Blocks:**
- contributes to `#165`
- improves the base for `#169`

### 3B. Multi-graph substrate

- `#168` Multi-Graph Memory Index

**Blocks:**
- `#169`
- contributes to `#165`

**Must wait for:**
- `#167` if graph seeding should benefit from finished query-aware retrieval

### 3C. Graph recall and explainability

- `#169` Graph Recall Mode, Explainability, and Shadow Evaluation

**Must wait for:**
- `#168`

**Merge gate:**
- finish the whole retrieval/reasoning band before moving to docs/presets work in `#173`

## Phase 4: Adaptive Extraction and Compression

### 4A. Proactive extraction

- `#170` Proactive Extraction Self-Questioning

### 4B. Memory action telemetry

- `#171` Context Compression Actions and Memory Action Telemetry

**Blocks:**
- `#172`

### 4C. Policy learning loop

- `#172` Compression Guideline Learning and Policy Tuning Loop

**Must wait for:**
- `#171`

**Can run in parallel with:**
- `#170`, after `#171` is merged

## Phase 5: Coordination and Long-Horizon Learning

### 5A. Local conversation-index backend abstraction

- `#175` Add Pluggable Local Conversation Index Backend (FAISS First)

**Why here:**
- It is valuable but does not need to block the higher-priority storage, namespace, or retrieval-core work.

**Can run in parallel with:**
- `#177`
- early `#178`

**Caution:**
- touches conversation-index and recall code paths, so avoid overlap with active retrieval-core branches

### 5B. Shared-context cross-signals

- `#177` Shared Context Cross-Signal Engine and Daily Synthesis

**Blocks:**
- improves inputs for `#178`

### 5C. Full compounding artifacts and rubrics

- `#178` Expand Compounding Into Full Outcome, Mistake, and Rubric Artifacts

**Must wait for:**
- ideally `#177`, or at least the shared-context artifact contract should be frozen first

## Phase 6: Source-Aware Intelligence and Adapters

### 6A. Entity retrieval intelligence

- `#165` Entity Retrieval Intelligence

**Must wait for:**
- `#162`
- `#167`
- strongly benefits from `#168`

### 6B. OpenClaw workspace artifact adapter

- `#179` Ingest OpenClaw Workspace Artifacts as Native Knowledge Sources

**Must wait for:**
- `#162`
- `#176`
- strongly benefits from `#159`

### 6C. Obsidian vault adapter

- `#180` Backend-Agnostic Obsidian Vault Adapter

**Must wait for:**
- `#162`
- `#176`
- strongly benefits from `#159`

**Can run in parallel with:**
- `#179`, once the native-knowledge adapter contract is merged and frozen

## Phase 7: Operator Surfaces

### 7A. Review and audit pipeline

- `#164` Memory Quality Review and Audit Pipeline

**Must wait for:**
- `#159`
- `#163`
- benefits from `#178`

### 7B. Admin console

- `#161` Admin Console

**Must wait for:**
- `#159`
- `#160`
- `#164`

### 7C. Setup, health, and benchmarking

- `#166` Setup, Health, and Benchmarking Toolkit

**Must wait for:**
- `#159`
- `#160`
- benefits from `#175`, `#177`, `#178`

**Can run in parallel with:**
- late work on `#161` if UI and CLI/doctor scopes are kept separate

## Phase 8: Presets, Budgets, and Documentation

- `#173` Finish v8 Memory OS Presets, Budgets, and Documentation IA

**Why last:**
- This issue should document the truth, not the aspiration. It must follow the stabilization of the major capability bands.

**Must wait for:**
- `#167`
- `#169`
- `#170`
- `#172`
- `#175`
- `#176`
- `#177`
- `#178`
- `#179`
- `#180`
- `#160`
- `#166`

## Recommended Single-Agent Order

Use this when one agent is executing the backlog end-to-end with minimal branch overlap:

1. `#159`
2. `#176`
3. `#162`
4. `#160`
5. `#163`
6. `#167`
7. `#168`
8. `#169`
9. `#170`
10. `#171`
11. `#172`
12. `#175`
13. `#177`
14. `#178`
15. `#165`
16. `#179`
17. `#180`
18. `#164`
19. `#161`
20. `#166`
21. `#173`

## Recommended Multi-Agent Lanes

Use this only after Phase 1 is merged and contracts are stable.

### Lane A: Platform and access

- `#159` -> `#160` -> `#161` -> `#166`

### Lane B: Retrieval intelligence

- `#167` -> `#168` -> `#169` -> `#165`

### Lane C: Adaptive memory

- `#163` -> `#170` -> `#171` -> `#172`

### Lane D: Coordination and learning

- `#177` -> `#178`

### Lane E: Source adapters

- `#162` -> `#179`
- `#162` -> `#180`
- `#175` can run as a sidecar lane after retrieval-core churn settles

### Hard merge gates between lanes

- Lane E must wait for `#176` before final merge.
- Lane A should not merge `#160` before `#159` and `#176`.
- Lane B should not merge `#169` before `#168`.
- Lane C should not merge `#172` before `#171`.
- `#173` waits for all lanes to finish.

## Highest-Risk Merge Hotspots

Expect recurring conflicts in:

- `src/orchestrator.ts`
- `src/config.ts`
- `src/types.ts`
- `src/tools.ts`
- `openclaw.plugin.json`
- `docs/config-reference.md`
- `docs/architecture/retrieval-pipeline.md`

When two candidate issues touch more than two of those files, prefer serial execution even if the roadmap says they are theoretically parallelizable.

## Practical Recommendation

If one agent is doing the work, do not use raw numeric order. Use the single-agent order above.

If multiple agents are doing the work, do not start more than three lanes at once:

1. foundation/access lane
2. retrieval lane
3. source-adapter or coordination lane

Anything more than that will create merge churn in the orchestrator/config surface faster than it creates progress.
