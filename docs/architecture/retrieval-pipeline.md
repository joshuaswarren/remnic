# Retrieval Pipeline

## Overview

Retrieval runs before each agent session (`before_agent_start` hook). It injects relevant memories and profile context into the system prompt.

## Pipeline Stages

```
before_agent_start
       │
       ▼
┌─────────────────────────────────┐
│  1. Recall Planner              │  classify request intent
│     → no_recall / minimal /     │  gate unnecessary recalls
│       full / graph_mode         │
└──────────────┬──────────────────┘
               │ (if recall needed)
               ▼
┌─────────────────────────────────┐
│  2. Profile read                │  profile.md (direct file read, instant)
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  3. Candidate generation        │
│  a. Artifact anchors (v8.0)     │  high-trust verbatim memories first
│  b. QMD hybrid search           │  BM25 + vector subprocess calls in parallel
│  c. Embedding fallback          │  when QMD unavailable or returns empty results
│  d. Namespace filter (v3.0)     │  filter to allowed namespaces
│  e. Procedural recall (opt.)    │  intent-gated `procedure` files; see docs/procedural-memory.md
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  4. Scoring & filtering         │
│  - Recency boost (default-on)   │
│  - Importance weight            │
│  - Intent compatibility (v8.0)  │
│  - Temporal index boost (v8.1)  │  score boost for time-matching memories
│  - Tag index boost (v8.1)       │  score boost for #tag-matching memories
│  - Access frequency boost       │
│  - Negative example penalty     │
│  - Namespace / artifact filter  │
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  5. LLM reranking (opt-in)      │  timeboxed, fail-open
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  6. Context assembly            │
│  0. Shared context (opt-in)     │  cross-agent shared context (if enabled)
│  1. Profile                     │  behavioral context
│  2. Identity continuity (v8.4)  │  mode-gated anchor/incident signals
│  3. Knowledge Index             │  entity/topic index (default-on)
│  4. Artifacts (v8.0)            │  high-confidence anchors
│  5. Memory boxes                │  recent topic windows
│  6. Notes + memories            │  search results
│  7. Checkpoint / transcripts    │  working context recovery
│  8. Hourly summaries            │  recent activity digest
└──────────────┬──────────────────┘
               ▼
         inject into system prompt
         (capped at recallBudgetChars)
```

## Recall Planner (v8.0)

The planner classifies each request and selects a recall mode before any search:

| Mode | When Used | Behavior |
|------|-----------|----------|
| `no_recall` | Acknowledgements, simple acks | Skip search entirely |
| `minimal` | Short operational commands | QMD capped at `recallPlannerMaxQmdResultsMinimal` |
| `full` | Normal requests | Standard pipeline |
| `graph_mode` | Timeline / history queries | Extended graph traversal + provenance snapshot (seed/hop/type) |

Config: `recallPlannerEnabled` (default `true`).

### Heuristic vs LLM planning (issue #1367, Option C)

By default the mode above is chosen by a fast regex heuristic (`planRecallMode()` in `intent.ts`). Operators can opt into **LLM-based planning** with `recallPlannerLlmEnabled: true` (requires `recallPlannerEnabled`). The LLM classifier:

- Routes through the gateway/fallback chain, so it is **provider-agnostic** — OpenAI, Anthropic, Ollama, Codex, or gateway agent personas all work. The configured `recallPlannerModel` is tried first; `taskModelChain` / gateway defaults are resilient fallbacks.
  - `recallPlannerModel` must be a **`provider/model`** string (e.g. `openai/gpt-5.5`, `anthropic/claude-haiku-4-5`) — a bare model name cannot be resolved and is ignored (routing then relies on the gateway chain). The legacy default `gpt-5.5` is bare, so to enable LLM planning you must either set a `provider/model` value **or** have a gateway model chain / agent persona configured. If you opt in but nothing routable resolves, the planner logs a one-time warning and stays on the heuristic.
- Is bounded by `recallPlannerTimeoutMs` and **always falls back to the heuristic** on timeout, error, empty response, or an unavailable backend — recall never fails because of the planner.
- Honors `recallPlannerShadowMode` (run the LLM for comparison/telemetry but keep the heuristic's effective decision) and `recallPlannerTelemetryEnabled` (log planned-vs-heuristic mode, model, latency, and fallback).
- Is skipped entirely when the caller forces a `mode`, when the planner is disabled, when the recall is already aborted, or for empty prompts. It also participates in the recall cancellation contract — an aborted/timed-out outer recall cancels the planner call.
- Classifies on the prompt alone today. `recallPlannerMaxMemoryHints` is **reserved**: the planner accepts optional recent-memory hints, but the default recall path runs before search and does not gather them, so none are sent yet.

The `src/index.ts` active-recall preflight stays heuristic-only (it runs before recall and is latency-sensitive); the LLM decision is authoritative for the main recall path.

> `recallPlannerUseResponsesApi` is reserved: the chat-vs-Responses API dialect is chosen per-provider by the gateway/fallback client based on each provider's `api` field, so this flag does not override routing.

## QMD Retrieval

The current QMD architecture is documented in [QMD 2.0 Integration Decision](./qmd-2-integration-decision.md).

Recall uses `QmdClient.search()` first (shared stdio MCP session when healthy, subprocess fallback otherwise) and supplements underfilled results with `QmdClient.hybridSearch()` (BM25 + vector merge). This keeps recall fail-open while reducing subprocess contention under load.

- `qmdCollection` specifies which QMD collection to search.
- `qmdMaxResults` caps the number of candidates returned.
- `qmdIntentHintsEnabled` passes Engram's inferred recall intent into QMD unified search when supported.
- When an intent hint is active, Engram skips its own hybrid top-up so QMD's unified `query` path remains authoritative.
- `qmdExplainEnabled` requests QMD explain traces and persists them to `state/last_qmd_recall.json` for operator inspection.
- Optional `rerankEnabled` runs an additional LLM reranking pass over the merged candidates. This adds latency — enable only if QMD's built-in scoring is insufficient.

## Artifact Anchors (v8.0)

Verbatim artifacts are injected first in the context window, before regular search results. They represent high-confidence, high-importance memories (decisions, corrections, principles, commitments) extracted at write time. See `verbatimArtifactsEnabled`.

## Intent Routing (v8.0)

When `intentRoutingEnabled` is on, extraction captures `intent.goal`, `intent.actionType`, and `intent.entityTypes` for each memory. At recall time, memories whose intent is compatible with the current request receive a small score boost (`intentRoutingBoost`).

## Context Budget & Assembly

All retrieved content is capped at `recallBudgetChars` before injection. If `recallBudgetChars` is not set, the budget defaults to `maxMemoryTokens * 4` (8,000 chars with the default `maxMemoryTokens` of 2000). **For modern large-context models (200K+ token windows), set `recallBudgetChars` explicitly to 64,000–128,000.**

### Budget-Aware Assembly (v9.0.66+)

Sections are assembled in pipeline order. The assembler tracks cumulative character usage and reserves space for protected sections (currently `memories`). Each non-protected section receives `budget - usedChars - reservedChars` available characters. If a section exceeds its available space, it is truncated or omitted.

**Default pipeline order:**

| Position | Section ID | Default | Typical Size |
|----------|-----------|---------|--------------|
| 1 | `shared-context` | enabled when `sharedContextEnabled: true` | 2,000–6,000 chars |
| 2 | `profile` | enabled by default | 4,000–8,000 chars |
| 3 | `identity-continuity` | off by default | 0–1,200 chars |
| 4 | `entity-retrieval` | enabled by default | 0–2,400 chars |
| 5 | `knowledge-index` | enabled by default | 0–4,000 chars |
| 6 | `verbatim-artifacts` | off by default | variable |
| 7 | `memory-boxes` | off by default | variable |
| 8 | `temporal-memory-tree` | off by default | variable |
| 9–14 | various opt-in sections | off by default | variable |
| 15 | **`memories`** (protected) | enabled by default | variable |
| 16 | `compression-guidelines` | off by default | variable |
| 17 | `native-knowledge` | off by default | 0–2,400 chars |
| 18 | `transcript` | enabled by default | 0–4,000 chars |
| 19 | `summaries` | enabled by default | variable |
| 20 | `conversation-recall` | off by default | 0–2,500 chars |
| 21 | `compounding` | off by default | variable |
| 22 | `questions` | off by default | variable |

**Common pitfall:** With the default budget of 8,000 chars, profile (~7,500 chars) and shared context (~4,000 chars) together consume the entire budget. The `memories` section is protected and always included, but under tight budgets it may be truncated to heading-only (~24 chars) with no actual memory content. Memories are still retrieved (visible in `lastRecall` state), but the agent sees only the section heading. See [Recall Budget Tuning](../config-reference.md#recall-budget-tuning) for sizing guidance.

Identity continuity section behavior:
- `recovery_only`: inject only when prompt has explicit recovery/continuity intent.
- `minimal`: inject compact identity signals.
- `full`: inject structured anchor/loops/incidents block (downgraded to compact form when recall planner mode is `minimal`).
- `identityMaxInjectChars`: per-section cap with explicit trim marker when exceeded.

Recall telemetry (`recall_summary`) includes identity fields:
- `identityInjectionMode`
- `identityInjectedChars`
- `identityInjectionTruncated`

Graph recall explainability (`memory_graph_explain_last_recall`):
- snapshot persists bounded seed and expanded path sets (max 64 each)
- expanded entries include provenance: `seed`, `hopDepth`, `decayedWeight`, `graphType`
- output remains concise by honoring `maxExpanded` and rendering a compact per-entry provenance line

Retrieval debug artifacts (`state/last_graph_recall.json`, `state/last_intent.json`, `state/last_qmd_recall.json`):
- `memory_graph_explain_last_recall` reads `state/last_graph_recall.json`
- the companion `memory_intent_debug` surface reads `state/last_intent.json` when the runtime exposes intent-debug snapshots
- `memory_qmd_debug` reads `state/last_qmd_recall.json` when QMD recall snapshots are available
- `last_intent.json` is the planner-side snapshot: query text, inferred intent, selected recall mode, and any classifier reasons the runtime records
- `last_graph_recall.json` is the graph-side snapshot: mode, namespaces, seed paths, expanded paths, and graph provenance for each expansion
- `last_qmd_recall.json` is the QMD-side snapshot: fetch limits, intent hint, explain capture state, top ranked results, and whether Engram used or skipped hybrid top-up
- richer graph snapshots may also include skip or fallback metadata and final ranked result summaries; explain tooling should tolerate those extra fields even when older builds only emit the core seed/expanded schema

## Namespace Routing (v3.0)

With namespaces enabled, retrieval filters candidates to allowed namespaces (local and shared) and returns results in score order. See [Namespaces](../namespaces.md).

## Configuration Quick Reference

| Setting | Default | Notes |
|---------|---------|-------|
| `recallBudgetChars` | `maxMemoryTokens * 4` | **Total character budget for recall context. Set this explicitly.** |
| `recallPlannerEnabled` | `true` | Lightweight request classifier |
| `recallPlannerMaxQmdResultsMinimal` | `4` | QMD cap in minimal mode |
| `maxMemoryTokens` | `2000` | Legacy token cap; prefer `recallBudgetChars` |
| `identityContinuityEnabled` | `false` | Enables identity continuity injection path |
| `identityInjectionMode` | `recovery_only` | Identity injection behavior (`recovery_only|minimal|full`) |
| `identityMaxInjectChars` | `1200` | Max characters for identity continuity section |
| `qmdEnabled` | `true` | Enable QMD hybrid search |
| `qmdMaxResults` | `8` | Max QMD candidates |
| `qmdIntentHintsEnabled` | `false` | Forward inferred recall intent into QMD unified search |
| `qmdExplainEnabled` | `false` | Persist bounded QMD explain traces for debug tooling |
| `intentRoutingEnabled` | `false` | Intent-compatible recall boost |
| `verbatimArtifactsEnabled` | `false` | Inject artifact anchors first |
| `rerankEnabled` | `false` | LLM reranking pass over QMD/embedding results |
| `queryAwareIndexingEnabled` | `false` | Temporal + tag index boost at scoring (v8.1) |

→ Full settings: [Config Reference](../config-reference.md)
