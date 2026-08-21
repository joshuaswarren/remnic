# GraphRAG Evaluation for `openclaw-engram`

Date: 2026-02-22
Repo evaluated: `openclaw-engram`

## Executive Summary

GraphRAG can add value to Engram, but only if scoped to **graph-assisted recall and explainability**, not full “replace QMD with graph DB” architecture.

Engram already contains much of the substrate needed for GraphRAG-like behavior:
- graph extraction/write path (`src/graph.ts`, `GraphIndex.onMemoryWritten`)
- multi-hop traversal primitive (`GraphIndex.spreadingActivation`)
- intent-based planner mode (`graph_mode` in `planRecallMode`)
- relationship/link metadata in extraction + storage

However, the main recall path currently does **not** use graph expansion. So today, GraphRAG-style capability is mostly latent.

**Recommendation:** pursue an **optional sidecar integration path** first (shadow-mode graph expansion + metrics), then promote to default-on-for-graph-mode only if it demonstrably improves recall quality without unacceptable latency/cost.

---

## 1) Concrete Integration Points

## A. Recall candidate generation (highest leverage)

Current state:
- `planRecallMode()` can return `graph_mode` for timeline/history/root-cause style prompts.
- `orchestrator.recallInternal()` currently treats non-`no_recall` modes as standard QMD/embedding flow; no graph expansion branch observed.

Integration:
1. Use top QMD results as seeds.
2. Run `graphIndex.spreadingActivation(seeds, maxGraphTraversalSteps)`.
3. Merge graph-expanded candidates with QMD candidates.
4. Re-score with provenance-aware blending (e.g., qmdScore + activationScore + recency/importance).
5. Keep strict cap (`recallResultLimit`) and fail-open fallback to QMD-only.

Why this matters:
- This is the direct GraphRAG value path: retrieve semantically near + structurally connected memories.
- Minimal schema changes; mostly orchestration/ranking logic.

## B. Graph explainability/debug tooling (high trust, low complexity)

Current state:
- No `memory_graph_explain_last_recall` tool currently registered.
- Existing `memory_last_recall` only tracks IDs, not retrieval path/provenance.

Integration:
- Persist `state/last_graph_recall.json` when graph expansion runs.
- Add tool to expose seed nodes, traversed edges, expanded hits, and final rank rationale.

Why this matters:
- Critical for safe rollout and user trust.
- Enables rapid tuning and easier false-positive diagnosis.

## C. Extraction quality upgrades (medium leverage)

Current state:
- Entity relationships are extracted and persisted.
- Memory linking (`supports`, `follows`, etc.) exists, but not used in retrieval ranking/traversal.
- Causal edges rely on phrase heuristics; entity graph depends on `entityRef` consistency.

Integration:
- Improve canonical entity resolution and alias handling before edge writes.
- Optionally incorporate memory links into traversal graph (with conservative weights).

Why this matters:
- Better edges improve graph recall quality more than deeper traversal tricks.

## D. Consolidation/maintenance hooks (lower leverage)

Potential:
- Periodically compact/dedupe graph edges.
- Backfill edges for legacy memories.

Useful but secondary to A/B.

---

## 2) Fit, Risks, Complexity vs Expected Value

## Fit with Engram architecture: **Good (for partial GraphRAG)**

Engram is local-first, file-based, fail-open, and cost-sensitive. A lightweight GraphRAG layer on top of current markdown + JSONL graph files fits this design.

Full external GraphRAG stacks (graph DB + heavy extraction pipeline) are less aligned with Engram’s operational simplicity.

## Key risks

1. **Edge quality risk**
   - Heuristic causal edges + imperfect entity normalization can add noisy hops.
2. **Latency risk**
   - Graph expansion + additional disk reads can increase recall latency.
3. **Over-retrieval/context pollution**
   - Multi-hop expansion may surface loosely related memories.
4. **Ops complexity risk (if deep integration)**
   - External graph infra adds failure modes and maintenance burden.

## Complexity/value assessment

- Graph-assisted expansion in existing recall path: **Medium complexity, high potential value**
- Explainability tooling: **Low-medium complexity, high rollout value**
- Full GraphRAG infra replacement: **High complexity, uncertain incremental value over QMD hybrid + existing boosts**

---

## 3) Realistic Options

## Option 1 — No integration (status quo)

What it means:
- Keep graph writing/traversal as internal substrate only.
- Continue QMD-centric recall.

Pros:
- Zero implementation risk.
- Keeps latency profile predictable.

Cons:
- `graph_mode` remains mostly nominal.
- Leaves existing graph investment underutilized.

When this is right:
- Team capacity is constrained or retrieval quality is already satisfactory.

---

## Option 2 — Optional sidecar integration (recommended)

What it means:
- Add graph expansion as an **optional augmentation** to current retrieval.
- Start in shadow mode (compute + log, do not inject) then controlled rollout.

Scope:
- Trigger only in `graph_mode` initially.
- Use existing JSONL graph + `GraphIndex.spreadingActivation`.
- Add `last_graph_recall` snapshot and explain tool.

Pros:
- Uses current architecture; no new external infra required.
- Measurable, reversible, and safe (fail-open to baseline).
- Highest ROI path for validating GraphRAG benefit.

Cons:
- Still needs careful ranking/provenance design.
- Requires instrumentation discipline.

Complexity: **Medium**
Expected value: **Medium-high**

---

## Option 3 — Deeper integration (Graph-first retrieval)

What it means:
- Promote graph traversal and relation reasoning to first-class retrieval backbone.
- Potentially introduce richer relation extraction and/or external graph store.

Pros:
- Max theoretical GraphRAG capability.
- Better support for complex multi-hop queries (if edge quality is excellent).

Cons:
- Significant engineering + ops complexity.
- Hard to justify before proving sidecar gains.
- Risk of diverging from Engram’s local-first simplicity and reliability profile.

Complexity: **High**
Expected value: **Uncertain until sidecar metrics prove uplift**

---

## 4) Recommended Path

Choose **Option 2: Optional sidecar integration**, with staged rollout.

## Phase 0 — Baseline + instrumentation (1 sprint)
- Add retrieval metrics capture for baseline:
  - recall latency p50/p95
  - number of retrieved memories
  - negative-feedback rate (`memory_feedback_last_recall` signals)
  - disagreement prompt frequency after recall
- Define golden query set (timeline, root-cause, entity-history prompts).

Exit criteria:
- Stable baseline metrics and evaluation harness.

## Phase 1 — Shadow graph expansion (1 sprint)
- In `graph_mode`, compute graph-expanded candidates but do not inject.
- Log overlap and novelty:
  - % of graph candidates already in QMD top-N
  - % novel candidates
  - manual quality sample of novel candidates
- Write `last_graph_recall.json` for offline analysis.

Exit criteria:
- Evidence of meaningful novel candidates with acceptable compute overhead.

## Phase 2 — Controlled injection (1–2 sprints)
- Inject top-K graph-expanded candidates only when confidence gates pass:
  - seed quality threshold
  - max hop cap (start 1–2)
  - activation threshold
- Add provenance labels in recall assembly (`qmd`, `graph`, `qmd+graph`).
- Add `memory_graph_explain_last_recall` tool.

Exit criteria:
- Non-regressive latency (e.g., p95 increase <20%).
- Quality uplift on golden set and/or lower negative feedback.

## Phase 3 — Hardening + optional defaults
- Tune weights/thresholds.
- Consider expanding graph augmentation beyond `graph_mode` only if proven.
- Evaluate whether deeper integration is warranted.

---

## 5) Success Metrics

Primary:
1. **Quality uplift on graph-like prompts**
   - Human-rated relevance@K on timeline/root-cause/entity-history queries
   - Target: +10–20% vs baseline
2. **User correction pressure**
   - Rate of “that’s not right / why did you say that” after recall-enabled responses
   - Target: reduction vs baseline
3. **Negative memory feedback rate**
   - Fraction of recalled IDs marked not useful
   - Target: reduction vs baseline

Guardrail metrics:
1. **Recall latency**
   - p95 recall latency increase capped (target <20%)
2. **Context budget pressure**
   - No increase in context overflows/truncation incidents
3. **Fail-open reliability**
   - Graph errors never break memory write or baseline recall path

---

## Bottom Line

GraphRAG is a **good tactical enhancement** for Engram if implemented as an optional, measured layer on top of existing QMD retrieval—not as a wholesale architectural replacement.

Engram already has 60–70% of the building blocks. The missing piece is integrating graph expansion into recall with strong provenance, metrics, and fail-open controls.
