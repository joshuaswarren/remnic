# Remnic Docs

## Getting Started

- [Getting Started](getting-started.md) — Install, setup, first-run verification
- [Search Backends](search-backends.md) — Choosing and configuring search engines (v9.0)
- [Enable All Features](enable-all-v8.md) — Full-feature config profile
- [Config Reference](config-reference.md) — Every setting with defaults, recommended values, and operator guidance

## Architecture

- [Overview](architecture/overview.md) — System design, components, storage layout
- [Trace → Observation → Primitive](trace-to-primitive.md) — How Remnic compresses noisy session traces into durable memory primitives (issue #685)
- [Retrieval Pipeline](architecture/retrieval-pipeline.md) — How recall works end-to-end
- [Memory Lifecycle](architecture/memory-lifecycle.md) — Write, consolidation, expiry
- [Dreams: phased consolidation](dreams.md) — Light sleep / REM / deep sleep phase mapping over the existing maintenance pipeline (issue #678)
- [Graph Reasoning](architecture/graph-reasoning.md) — Opt-in graph traversal, assist, and explainability
- [Graph Edge Decay](graph-edge-decay.md) — Confidence decay model, maintenance job, traversal pruning, and `--include-low-confidence` (issue #681)
- [Writing a Search Backend](writing-a-search-backend.md) — Build your own search adapter (v9.0)

## Guides

- [Local LLM Guide](guides/local-llm.md) — Setup and tune local-first extraction/rerank flows
- [Cost Control Guide](guides/cost-control.md) — Budget mappings, presets, and rollout discipline
- [Migration Guide](guides/migrations.md) — Move from manual tuning and historical roadmap docs to the current config surface

## Operations

- [Operations](operations.md) — Backup, export, hourly summaries, CLI, logs
- [Published Benchmarks](benchmarks.md) — Full published benchmark suite, artifact expectations, and leaderboard safety
- [Benchmark Readiness](benchmarks/sota-readiness.md) — #841-#850 cue-recall audit for published memory benchmarks
- [Retention Policy](retention-policy.md) — Hot/cold tier substrate, value-score model, `remnic forget`, `remnic tier list/explain` (issue #686)
- [Import / Export](import-export.md) — Portable backups and migration
- [ops/pr-review-hardening-playbook.md](ops/pr-review-hardening-playbook.md) — Pre-push review checklist
- [ops/plugin-engineering-patterns.md](ops/plugin-engineering-patterns.md) — Engineering patterns for retrieval/intent/cache

## Feature Guides

- [At-Rest Encryption](encryption.md) — AES-256-GCM transparent storage encryption, secure-store CLI, threat model (issue #690)
- [Advanced Retrieval](advanced-retrieval.md) — Reranking, query expansion, feedback loop
- [Pattern Reinforcement](pattern-reinforcement.md) — Cross-session pattern detection: reinforced primitives, `remnic patterns list/explain` CLI, recall boost (issue #687)
- [Recall X-ray](xray.md) — Per-result retrieval attribution, provenance, safety, and why each memory surfaced (issue #570)
- [Recall Disclosure](recall-disclosure.md) — Three-tier progressive disclosure (chunk / section / raw): cost/quality tradeoffs, auto-escalation policy, and the disclosure-vs-retrieval-tier distinction (issue #677)
- [User-Aware Agents](user-aware-agents.md) — User-model dimensions, context scopes, and boundary principles
- [Temporal Recall](temporal-recall.md) — `valid_at` / `invalid_at` fact lifecycle and `as_of` recall filter (issue #680)
- [Tags](tags.md) — Free-form tag filter on recall and propose; tags vs taxonomy (issue #689)
- [Live Connectors](live-connectors.md) — Continuous-sync framework for external sources (issue #683)
- [Operator Console](console.md) — Live engine introspection: `remnic console` TUI, `--record-trace`, `--trace` replay (issue #688)
- [Context Retention](context-retention.md) — Transcript indexing, hourly summaries
- [Namespaces](namespaces.md) — Multi-agent memory isolation (v3.0)
- [Shared Context](shared-context.md) — Cross-agent shared intelligence (v4.0)
- [Compounding](compounding.md) — Weekly synthesis and mistake learning (v5.0)
- [Identity Continuity](identity-continuity.md) — Continuity artifacts, templates, and rollout safety model (v8.4)
- [Graph Dashboard](graph-dashboard.md) — Optional live graph observability server + patch stream (v8.8)

## Plans / Roadmaps

- [Remnic Feature Roadmap (GitHub Project)](https://github.com/users/joshuaswarren/projects/1) — Current priority order, blockers, and next work
- [Plans Index](plans/README.md) — Historical design plans and archive layout
- [Research Paper Mapping](research/paper-mapping.md) — How live features map to the papers and concepts that inspired them
