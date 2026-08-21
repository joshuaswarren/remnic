# GitHub Issue: Comprehensive Benchmarking & Evaluation Suite

**Title:** Comprehensive Benchmarking & Evaluation Suite

**Body:**

## Summary

Build a comprehensive benchmarking and evaluation suite for Remnic that provides lab-grade, reproducible measurements of memory system quality. The suite supports published community benchmarks (9), Remnic-specific benchmarks (5), and user-defined benchmarks, with flexible LLM provider support for both the system-under-test and the evaluation judge. Results are viewable via a local interactive React dashboard, exportable as static HTML reports, and publishable to Remnic.ai.

**Full design spec:** `docs/superpowers/specs/2026-04-17-bench-suite-design.md`

## Motivation

- **Quantitative tracking** — evaluate Remnic over time and across configurations to know if memory, recall, and agentic effectiveness are improving or regressing
- **Agent-friendly** — agents can run `--quick` benchmarks in auto-improvement loops and get machine-parseable results
- **ArXiv-ready** — lab-grade statistical rigor (bootstrap CIs, effect sizes, seed control) for publishing papers on Remnic's techniques
- **Reproducibility** — full config snapshots, environment metadata, and seed control so others can reproduce and compare against other memory systems
- **Public credibility** — auto-updated benchmarks page on Remnic.ai

## Architecture

Two-package split:

- **`@remnic/bench`** — engine (runners, providers, stats, CLI, results schema). Expanded from existing `packages/bench`, absorbing `/evals/`
- **`@remnic/bench-ui`** — React + Tailwind + Recharts dashboard. Fully optional

Contract: `BenchmarkResult` JSON schema is the interface between them.

## Key Features

### LLM Provider Layer
- **Judge** and **system-under-test** independently configurable
- 4 built-in providers: OpenAI-compatible (Z.ai/GLM, LM Studio, vLLM), Anthropic, Ollama, LiteLLM
- LM Studio auto-discovery via `/v1/models` endpoint + `lms` CLI
- Config via `bench.config.yaml` with env var interpolation

### Benchmark Tiers

**Tier 1 — Published (9):**
| Benchmark | Tests | Status |
|-----------|-------|--------|
| AMA-Bench | Long-horizon agentic memory | Existing |
| MemoryArena | Interdependent multi-session | Existing |
| AMemGym | Interactive personalization | Existing |
| LongMemEval | 5 core memory abilities | Existing |
| LoCoMo | Long conversation memory | Existing |
| BEAM | 10M token scale, 10 abilities | **New** |
| PersonaMem-v2 | Implicit preference learning | **New** |
| MemoryAgentBench | Selective forgetting | **New** |
| MemBench | Factual vs reflective | **New** |

**Tier 2 — Remnic-Specific (5):** Taxonomy accuracy, entity consolidation, extraction judge calibration, page versioning, enrichment fidelity

**Tier 3 — User-Defined:** YAML-based custom benchmarks from user's own memory data

### Statistical Engine
- **Full mode** (default): N runs (default 5), bootstrap 95% CIs, Cohen's d, paired comparisons, cost/latency tracking
- **Quick mode** (`--quick`): single run, no stats, exit code regression gate — for automated loops

### Dashboard UI
- React + Tailwind + Recharts
- 5 views: Overview, Runs, Compare, Benchmark Detail, Providers
- 3 output surfaces: local web UI, static HTML export, Remnic.ai JSON feed

### CLI
```bash
remnic bench run --quick longmemeval    # Quick mode
remnic bench run --all                  # Full suite
remnic bench compare --baseline main    # Regression check
remnic bench ui                         # Dashboard
remnic bench export --format html       # Static report
remnic bench publish --target remnic-ai # Public feed
remnic bench providers discover         # Auto-detect models
```

## Implementation Phases

### Phase 1 — Engine Foundation (~400 LOC)
- Expand `@remnic/bench` with new structure
- `LlmProvider` interface + OpenAI-compatible provider
- `BenchmarkResult` schema
- Migrate `/evals` into `benchmarks/published/`
- `remnic bench run` + `remnic bench list` CLI
- Quick mode end-to-end
- **Ship:** `remnic bench run --quick longmemeval` works

### Phase 2 — Statistical Rigor + New Benchmarks (~400 LOC)
- Multi-run orchestration + seed control
- Bootstrap CI, Cohen's d, paired comparisons
- Anthropic + Ollama + LiteLLM providers + LM Studio discovery
- 4 new benchmark runners (BEAM, PersonaMem-v2, MemoryAgentBench, MemBench)
- `remnic bench compare`
- **Ship:** Full-mode 5-run with CIs, compare with effect sizes

### Phase 3 — Remnic Benchmarks + Custom Framework (~300 LOC)
- 5 Remnic-specific runners
- Custom YAML loader
- Baseline save/list, CI gate update, JSON/CSV export
- **Ship:** All 3 tiers runnable, CI gate passes

### Phase 4 — Dashboard & Publishing (~500 LOC)
- `@remnic/bench-ui` package
- All 5 views
- Static HTML export + Remnic.ai JSON feed
- **Ship:** Dashboard renders real results, exports work

### Phase 5 — Remnic.ai Integration (separate repo)
- Benchmarks page in Astro site
- Public leaderboard
- CI-driven auto-update

## References

- BetterBench (NeurIPS 2024): betterbench.stanford.edu — 46 best practices for benchmark quality
- ABC Checklist: arxiv.org/abs/2507.02825 — agent benchmarking standards
- Design spec: `docs/superpowers/specs/2026-04-17-bench-suite-design.md`
