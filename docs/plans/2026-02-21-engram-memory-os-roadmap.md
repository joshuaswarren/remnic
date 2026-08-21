# Engram Memory OS 1.0 Implementation Plan

> Status note (2026-03-08): The GitHub Project is the source of truth for current roadmap sequencing, blockers, and contributor priority: [Engram Feature Roadmap](https://github.com/users/joshuaswarren/projects/1). This file remains as historical roadmap/design context and is not the authoritative execution queue.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate all requested memory-research concepts/papers into openclaw-engram with high utility, predictable latency, and strict token-budget controls.

**Architecture:** Evolve Engram from retrieval-centric memory into a policy-driven memory OS. Keep existing reliable substrate (local markdown memories, QMD hybrid retrieval, extraction/consolidation) and add layered capabilities: continuity structures, intent/temporal indexing, artifact grounding, graph reasoning, and agent-controlled context operations. Default behavior remains safe and affordable via gated flags and budget-aware planners.

**Tech Stack:** TypeScript, OpenClaw plugin hooks/tools, QMD, markdown frontmatter stores, optional local LLM, cron workflows.

---

## 0) Research Synthesis (What We Are Applying)

The roadmap implements all requested paper concepts, grouped by the capability they contribute.

### Continuity + Episodic Structure
- REMem (episodic graph + iterative retrieval)
- E-mem (episodic context reconstruction)
- HiMem (episode/note split + reconsolidation)
- Membox (topic continuity memory boxes)
- TiMem (temporal memory tree)
- EverMemOS (lifecycle OS framing)

### Intent + Efficient Retrieval
- STITCH (contextual intent indexing)
- SwiftMem (query-aware temporal/tag indexes)
- ACE (retrieve vs think policy)

### Compression + Context Curation
- Focus (active context compression)
- CAT (context as callable tool)
- SimpleMem (semantic structured compression)
- ACON (compression guideline optimization)
- MemAct (context curation actions)

### Graph + Reasoning Fidelity
- MAGMA (multi-graph memory representation)
- SYNAPSE (spreading activation + inhibition/decay)
- CogCanvas (verbatim artifact extraction)
- ProMem (self-questioning extraction loop)

### Overall Taxonomy Guidance
- Memory in the Age of AI Agents (survey)

## 1) Non-Negotiables (Budget + Safety + Utility)

1. Default mode must remain close to today’s Engram cost profile.
2. All advanced capabilities are behind explicit config flags and presets.
3. Retrieval and compression must be observable with per-turn cost/latency metrics.
4. Every new write path must preserve provenance and be reversible.
5. Rollouts happen in phases with kill switches and migration scripts.

## 2) Major Release Structure

### Release A: `v8.0` (Memory OS Core) — **shipped as npm v8.0.0–v8.0.3**
- Memory Boxes + Trace Weaving (v8.0.1, PR #12)
- Episode/Note dual store (v8.0.2, PR #13)
- Verbatim Artifacts + Recall Planner v1 (v8.0.0, PR #11)
- Docs IA overhaul foundation (v8.0.3, PR #14)

### Release B: `v8.1` (Intent + Temporal Indexing) — **shipped as npm v8.1.0 (PR #15, was initially tagged v8.0.4)**
- Intent-indexed retrieval (goal/action/entity types)
- Temporal index + semantic tag DAG
- Adaptive retrieval pipeline (prefilter -> hybrid -> rerank)

### Release C: `v8.2` (Tree + Graph Reasoning)
- Temporal Memory Tree
- Multi-graph memory (entity/time/causal/semantic)
- Graph recall mode + explainability tool
- Recommended delivery split:
  - PR 19A: planner + `graph_mode` gating only
  - PR 19B: spreading-activation retrieval integration
  - PR 19C: explainability tools + snapshot state
  - PR 19D: hardening + rollout docs

### Release D: `v8.3` (Proactive + Policy Learning)
- Proactive extraction self-questioning
- Compression guideline optimizer
- Memory actions telemetry and policy tuning loop
- Delivery split (post-PR20 lifecycle completion):
  - PR 21A: proactive/policy foundation (config + schema + typed state stores)
  - PR 21B: proactive extraction self-questioning integration (bounded, fail-open)
  - PR 21C: context compression action tools + memory action telemetry
  - PR 21D: compression guideline learner + rollout docs + hardening gate
- Recommended delivery split:
  - PR 20A: lifecycle data model + config
  - PR 20B: lifecycle engine module
  - PR 20C: consolidation wiring + lifecycle metrics
  - PR 20D: retrieval policy integration + docs

## 3) Data Model Changes

### 3.1 New Stores
- `memory/boxes/YYYY-MM-DD/box-<id>.md`
- `memory/artifacts/YYYY-MM-DD/artifact-<id>.md`
- `memory/tmt/{day,week,month,persona}/...`
- `memory/state/index_time.json`
- `memory/state/index_tags.json`
- `memory/state/graphs/{entity,time,causal,semantic}.jsonl`
- `memory/state/memory-actions.jsonl`
- `memory/state/compression-guidelines.md`

### 3.2 Frontmatter Extensions (Non-breaking)
- `memoryKind: episode|note|artifact|summary|box|tmt-node`
- `intent: { goal, actionType, entityTypes[] }`
- `episodeSpan: { start, end }`
- `views: { gist, constraints[], evidenceRefs[], keywords[] }`
- `provenance: { transcriptId, turnId, charSpan }`
- `graphRefs: { entity[], temporal[], causal[], semantic[] }`

### 3.3 Compatibility
- Existing files stay valid.
- Missing new fields are treated as optional and inferred lazily.
- Backfill CLI migrates old memories incrementally.

## 4) Feature Flags and Presets

### 4.1 New Flags (all default `false` unless noted)
- `memoryBoxesEnabled`
- `traceWeaverEnabled`
- `verbatimArtifactsEnabled`
- `episodeNoteModeEnabled`
- `intentIndexingEnabled`
- `queryAwareIndexingEnabled`
- `temporalMemoryTreeEnabled`
- `multiGraphMemoryEnabled`
- `graphRecallEnabled`
- `proactiveExtractionEnabled`
- `contextCompressionActionsEnabled`
- `compressionGuidelineLearningEnabled`
- `recallPlannerEnabled` (default `true`, lightweight heuristic)

### 4.2 Budget Controls
- `maxRecallMs`
- `maxRecallTokens`
- `maxCompressionTokensPerHour`
- `maxGraphTraversalSteps`
- `maxArtifactsPerSession`
- `maxProactiveQuestionsPerExtraction`
- `indexRefreshBudgetMs`

### 4.3 Presets
- `preset: conservative` (default)
- `preset: balanced`
- `preset: research-max`
- `preset: local-llm-heavy`

## 5) Retrieval Pipeline Overhaul

### 5.1 Recall Planner (ACE-inspired)
1. Classify request: `fact_lookup`, `temporal_reasoning`, `multi_hop`, `workflow_state`, `creative`.
2. Decide mode: `no_recall`, `minimal`, `full`, `graph`.
3. Allocate budget from per-turn token/latency budget.

### 5.2 Candidate Generation
1. Intent prefilter (STITCH).
2. Temporal/index prefilter (SwiftMem).
3. QMD hybrid retrieval on narrowed set.
4. Optional graph activation expansion (MAGMA/SYNAPSE).

### 5.3 Context Assembly
1. Artifacts first (CogCanvas anchors).
2. Notes + TMT high-level node.
3. Episodes/boxes for narrative continuity.
4. Graph rationale path (if graph mode).

## 6) Write/Consolidation Overhaul

### 6.1 Memory Boxes (Membox)
- Sliding topic window forms an open box.
- Seal on topic shift or time gap.
- Trace Weaving links recurring topic boxes.

### 6.2 Episode + Note (HiMem)
- Episodes preserve event fidelity.
- Notes represent stable beliefs/decisions.
- Reconsolidation updates notes when conflicts emerge.

### 6.3 Verbatim Artifacts (CogCanvas)
- Extract exact decisions/constraints/reminders with transcript spans.
- Use as high-trust retrieval anchors.

### 6.4 Proactive Extraction (ProMem)
- Second-pass self-questioning to recover omitted details.
- Bounded by `maxProactiveQuestionsPerExtraction`.

### 6.5 Temporal Memory Tree (TiMem)
- Hourly -> Daily -> Weekly -> Persona nodes.
- Complexity-aware recall chooses depth.

## 7) Context Compression as Agent Capability

### 7.1 New Tools
- `context_checkpoint`
- `memory_action_apply`
- `memory_graph_explain_last_recall`
- `memory_intent_debug`

### 7.2 Action Space (AgeMem/AtomMem/MemAct)
- `store_episode`
- `store_note`
- `update_note`
- `create_artifact`
- `summarize_node`
- `discard`
- `link_graph`

### 7.3 Learning Loop (ACON-inspired)
- Log failures where compressed context underperformed full context.
- Generate updated compression guidelines nightly.
- Apply via prompt templates for compressors/planners.

## 8) Token and Latency Budget Strategy

### 8.1 Hard Budgets
- Enforce max recall tokens + max recall wall-clock.
- Abort lower-priority retrieval stages before deadlines.

### 8.2 Tiered Fallback
1. Full plan
2. Minimal artifacts + top notes
3. Profile + last critical decision only
4. Empty recall (safe fail-open)

### 8.3 Cost-Aware Defaults
- Keep graph traversal and proactive extraction off by default.
- Enable intent indexing and artifacts first for best utility/cost ratio.

## 9) Docs + README Complete Reorganization

### 9.1 Problems to Fix
- README is overloaded (setup + architecture + tuning + migration + internals mixed).
- Feature chronology dominates discoverability.
- Operational defaults vs advanced/research modes are unclear.

### 9.2 New Docs Information Architecture
- `README.md` (short): value prop, quick install, 5-minute setup, minimal config.
- `docs/getting-started.md`
- `docs/operations.md`
- `docs/config-reference.md` (single source of truth for flags/presets)
- `docs/architecture/overview.md`
- `docs/architecture/retrieval-pipeline.md`
- `docs/architecture/memory-lifecycle.md`
- `docs/architecture/graph-reasoning.md`
- `docs/guides/local-llm.md`
- `docs/guides/cost-control.md`
- `docs/guides/migrations.md`
- `docs/research/paper-mapping.md` (paper -> implementation mapping)

### 9.3 README Rewrite Principles
1. Keep under ~300 lines.
2. Link out to deep docs instead of embedding all details.
3. Add two operator personas: "conservative production" and "research mode".
4. Include exact token/cost knobs and recommended defaults.

## 10) Benchmarks and Acceptance Criteria

### 10.1 Quality
- Long-horizon QA accuracy uplift on LoCoMo/LongMemEval-style internal harness.
- Reduced retrieval mismatch rate (intent-incompatible recalls).

### 10.2 Efficiency
- P95 recall latency stable as memory grows.
- Per-turn recall token usage reduced in conservative mode.

### 10.3 Reliability
- No increase in failed hooks/timeouts under production load.
- All new components fail-open to baseline recall path.

### 10.4 Explainability
- Every injected memory section can show provenance and retrieval path.

## 11) Implementation Plan by Workstream

### Workstream 1: Data Model + Migrations
1. Add new schemas/frontmatter parsers.
2. Add migration/backfill CLI.
3. Add compatibility tests against old memory files.

### Workstream 2: Retrieval Planner + Indexes
1. Implement planner heuristic mode.
2. Add temporal + tag indexes.
3. Integrate prefilter before QMD.
4. Add observability metrics.

### Workstream 3: Continuity + Artifacts
1. Add box builder + trace weaver.
2. Add artifact extractor and storage.
3. Update context formatter ordering.

### Workstream 4: Tree + Graph
1. Implement TMT node writers.
2. Build multi-graph indices.
3. Add spreading activation traversal.
4. Add graph explain tool.

### Workstream 5: Proactive + Policy Learning
1. Add self-questioning extraction pass.
2. Add memory actions logging.
3. Add compression guideline optimizer job.

### Workstream 6: Docs Overhaul
1. Move/normalize existing docs into new IA.
2. Rewrite README.
3. Add paper-to-feature mapping doc.
4. Add config presets and examples.

## 12) Rollout and Risk Controls

1. Ship each workstream behind flags.
2. Add `shadow mode` for planner and graph retrieval.
3. Compare baseline vs new mode on mirrored traffic logs.
4. Promote defaults only after latency/cost/quality gates pass.

## 13) Paper-to-Feature Mapping (Explicit)

- REMem -> episodic graph + iterative retrieval tools
- E-mem -> local episodic reconstruction helper pass
- STITCH -> intent indexing and compatibility scoring
- SwiftMem -> temporal/tag indexes + prefilter
- ACE -> retrieve-vs-think planner
- AtomMem/AgeMem/MemAct -> memory actions and policy tuning
- Focus/CAT -> context checkpoint/compression tooling
- HiMem -> episode/note split and reconsolidation
- Membox -> memory boxes + trace weaver
- TiMem -> temporal memory tree
- MAGMA/SYNAPSE -> multi-graph + spreading activation retrieval
- EverMemOS -> lifecycle framing and operational orchestration
- SimpleMem -> structured multi-view compression
- CogCanvas -> verbatim artifacts with provenance
- ProMem -> self-questioning extraction loop
- ACON -> compression guideline optimization from failures
- Survey -> taxonomy and evaluation rubric

## 14) First 90-Day Execution Recommendation

### Days 1-30
- Ship artifacts + intent indexing + planner v1.
- Build new config reference and README rewrite draft.

### Days 31-60
- Ship memory boxes + episode/note + proactive extraction.
- Introduce temporal/tag indexes.

### Days 61-90
- Ship TMT + graph retrieval (shadow mode first).
- Enable conservative defaults and publish migration guide.
