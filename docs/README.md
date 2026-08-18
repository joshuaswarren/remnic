# Remnic documentation

Remnic is an open-source, local-first memory and context layer for AI agents. One
memory store, every agent: OpenClaw, Claude Code, Codex CLI, Cursor, ChatGPT
(developer mode), Hermes, Replit, Pi, omp, and any MCP client. All data lives on
your machine as plain markdown with YAML frontmatter. MIT licensed.

This is the map of everything under `docs/`. New here? Read the
[quickstart](guides/quickstart.md), then come back for the rest.

## Start here

- [Quickstart](guides/quickstart.md) — Install the CLI, start the daemon, connect one tool, and get your first recall in about five minutes.
- [Getting started](getting-started.md) — The full install and first-run guide: every install option, minimal config, verification, and next steps.
- [Enable all features](enable-all-v8.md) — A single config profile that turns on every major feature family at once.
- [Search backends](search-backends.md) — Choose and configure a search engine (six backends behind one interface), plus upgrade and version-gate notes.
- [All guides](guides/README.md) — Task-focused walkthroughs for installing, running, tuning, and migrating Remnic.

## Connect your tools

Point any tool at a running Remnic server. See the [integration index](integration/README.md)
for all wiring guides and the [plugins index](plugins/README.md) for what each
packaged adapter is.

- [Connector setup guide](integration/connector-setup.md) — Wire Claude Code, Codex, Cursor, Copilot, Cline, Roo Code, Windsurf, Amp, Replit, Hermes, and any MCP client to Remnic.
- [ChatGPT (developer mode)](integration/chatgpt.md) — Give ChatGPT persistent, governed memory on your own infrastructure via MCP and OAuth 2.1.
- [Pi coding agent](integration/pi.md) — Native Pi extension using Pi's hooks, slash commands, and compaction coordination.
- [Oh My Pi (omp)](integration/omp.md) — omp rules, MCP server config, and the native omp extension.
- [Prime Agent](integration/prime-agent.md) — Pi-fork coding agent; `remnic connectors install prime-agent` and the shared Pi-family extension.
- [Hermes setup](integration/hermes-setup.md) — Hermes Agent via the `remnic-hermes` package or session-id auto-detection.
- [Deployment topologies](integration/deployment-topologies.md) — Localhost, LAN, remote, containerized, and standalone layouts.
- [Plugin ID and memory namespaces](integration/plugin-id-and-memory-namespaces.md) — The OpenClaw plugin id split, the memory-slot gate, and namespace isolation.
- [Per-host plugins](plugins/README.md) — Adapter docs for OpenClaw, Claude Code, Codex, Hermes, Replit, and more.

**Migrating from an earlier setup:**

- [OpenClaw Engram to Remnic](guides/openclaw-engram-to-remnic.md) — Move from the legacy `openclaw-engram` package to `@remnic/plugin-openclaw`.
- [Platform migration guide](guides/platform-migration.md) — Move from the single-package Engram plugin to the multi-package Remnic platform.
- [Migrating from lossless-claw](lcm-to-remnic-migration.md) — Bring memory over from the lossless-claw context plugin.

## Features

### Recall and retrieval

- [Advanced retrieval](advanced-retrieval.md) — Reranking, query expansion, and the relevance feedback loop.
- [Retrieval explain](retrieval-explain.md) — Tier-annotated recall so you can see which retrieval tier produced each result.
- [Recall disclosure depth](recall-disclosure.md) — Three-tier progressive disclosure (chunk / section / raw) and its cost/quality tradeoffs.
- [Recall X-ray](xray.md) — Per-result attribution: provenance, safety, and why each memory surfaced.
- [Temporal recall](temporal-recall.md) — `valid_at` / `invalid_at` fact lifecycle and the `as_of` recall filter.
- [Contradiction review](contradiction-review.md) — Nightly scan that finds contradictory memory pairs and queues them for resolution.
- [Tags](tags.md) — Free-form tag filters on recall and propose, and how tags differ from taxonomy.
- [External compiled wikis](external-wikis.md) — Keep compiled knowledge outside automatic recall and hot facts; search it on demand.

### Memory OS

- [What Helps Me support passport](support-passport.md) — Owner-approved support cards, timed sharing, grounded helper questions, and immediate revocation.
- [Dreams](dreams.md) — Named, phased consolidation (light sleep / REM / deep sleep) over the maintenance pipeline.
- [Compounding engine](compounding.md) — Turns feedback into persistent institutional learning through weekly synthesis.
- [Procedural memory](procedural-memory.md) — First-class `procedure` memories mined from recurring task trajectories.
- [Pattern reinforcement](pattern-reinforcement.md) — Merges observations that recur across sessions into reinforced primitives.
- [Graph edge decay](graph-edge-decay.md) — Confidence decay model, the maintenance job, and traversal pruning.
- [Identity continuity](identity-continuity.md) — Recovery artifacts that let an assistant regain stable behavior after drift or incidents.
- [Peers](peers.md) — A peer registry generalizing the singular identity anchor to many known parties.
- [User-aware agents](user-aware-agents.md) — The typed user-model contract, context scopes, and boundary principles.
- [Shared context](shared-context.md) — File-based coordination layer for cross-agent collaboration.
- [Namespaces](namespaces.md) — Multi-agent memory isolation with a curated shared namespace.
- [Inductive rule consolidation (IRC)](irc.md) — Synthesizes explicit preference state from signals in stored conversations.
- [Context retention](context-retention.md) — Transcript indexing and richer hourly summaries for long-running systems.
- [Local session summaries](local-session-summaries.md) — Privacy-first harvesting of local AI session transcripts into sanitized drafts.

### Coding agents

- [Coding agent mode](coding-agent.md) — Auto-scope memory by git project (and optionally branch) so coding context stays where it belongs.
- [Coding knowledge (Track A)](coding-knowledge.md) — Durable, project-scoped coding knowledge inside `@remnic/core`, no extra dependencies.
- [Coding graph (Track B)](coding-graph.md) — The optional `@remnic/coding-graph` package that indexes a native codebase graph.
- [Developer workflow demo](developer-workflow-demo.md) — How user-aware memory helps coding agents plan, edit, check, and review.

### Wearables and connectors

- [Wearable transcripts](wearables.md) — Ingest Limitless, Bee, and Omi recordings into searchable day transcripts under strict trust gates.
- [Desktop capture](desktop-capture.md) — On-screen activity, desktop audio, and meeting intelligence: the daemon model, privacy charter, and what has shipped versus what is planned.
- [Live connectors](live-connectors.md) — The continuous, scheduled ingest path for external services.
- [Connectors CLI](connectors.md) — Inspect and manually control the live connectors from the operator surface.

### Import, export, and portability

- [Import / export / backup](import-export.md) — Portable exports, imports, and safe backups of the plain-file store.
- [Memory importers](importers.md) — Optional importer packages that pull memory out of external platforms.
- [Capsules](capsules.md) — Portable, shareable memory capsules for moving a slice of memory between stores.

### Dashboards and consoles

- [Admin console](admin-console.md) — Local operator UI served by the access server for inspection and actions.
- [Operator console](console.md) — Live `remnic console` engine introspection with trace recording and replay.
- [Live graph dashboard](graph-dashboard.md) — Optional sidecar for graph observability and a live patch stream.

### Demos

- [What Helps Me walkthrough](hackathons/build-for-good-2026.md) — Synthetic video, live proof commands, and the Build for Good 2026 entry.
- [Agentic commerce demo](agentic-commerce-demo.md) — Buyer-aware recommendations, checkout boundaries, and commerce eval coverage.
- [ChatGPT Apps demo](chatgpt-apps-demo.md) — A local ChatGPT Apps-compatible memory inspector on the MCP runtime.
- [Coding agent memory demo](../examples/coding-agent-memory-demo/) — No-key, cross-tool walkthrough for scoped coding-agent project memory.

## Operations

- [Operations](operations.md) — Backups, exports, hourly summaries, logs, and day-to-day CLI.
- [Retention policy](retention-policy.md) — Hot/cold tiers, the value-score model, `remnic forget`, and tier inspection.
- [At-rest encryption](encryption.md) — AES-256-GCM transparent storage encryption, the secure-store CLI, and its threat model.
- [Namespaces](namespaces.md) — Isolate memory across agents and tenants.
- [Capsules](capsules.md) — Export, import, and share portable memory capsules.
- [Import / export](import-export.md) — Portable backups and migration between stores.
- [Model lab](model-lab.md) — Reproducible recipes to fine-tune the small local classification models the extraction pipeline can use.
- [Codex credit reconciliation](benchmarks/codex-credit-reconciliation.md) — Conservative recovery for blocked bounded-benchmark ledgers.

### Benchmarking and evaluation

- [Memory evals](memory-evals.md) — Why agent memory needs evals, and how Remnic's eval surface works.
- [Evaluation harness](evaluation-harness.md) — The storage contract and status tooling for AMA-Bench-style evaluation.
- [Published benchmarks](benchmarks.md) — The full published benchmark suite, artifact expectations, and leaderboard safety.
- [Benchmark readiness](benchmarks/sota-readiness.md) — Audit checklist for running Remnic against published memory benchmarks.
- [Benchmark runbook](benchmarks/runbook.md) — How to produce and publish full benchmark numbers.
- [Benchmark integrity](bench/integrity.md) — Anti-gaming and integrity rules for the externally published suite.
- [Assistant rubric](bench/assistant-rubric.md) — The sealed LLM-judge rubric and its rotation policy for the assistant tier.
- [Single-flag ablations](benchmarks/ablations.md) — The LoCoMo single-flag ablation matrix.
- [MemCorrect](benchmarks/memcorrect.md) — Open correction / steerability benchmark.
- [Procedural recall benchmark](benchmarks/procedural-recall.md) — Scores how well stored procedures are injected into recall.
- [Aged-dataset retention bench](benchmarks/retention-aged-dataset.md) — Retention behavior over an aged dataset.
- [LoCoMo profile diagnosis](benchmarks/locomo-profile-diagnosis.md) — Runtime-profile regression diagnosis on the LoCoMo comparison.

## Reference

- [CLI reference](cli.md) — Every standalone `remnic` command, plus the hosted `openclaw engram` surface.
- [Config reference](config-reference.md) — Every setting with defaults, recommended values, and operator guidance.
- [API reference](api.md) — HTTP and MCP surface, headers, and the standalone command contract.
- [Setup, configuration, and tuning](setup-config-tuning.md) — The operational runbook for enabling and tuning features.
- [Tags](tags.md) — Tag frontmatter and the recall/propose tag filter.
- [Conventions](CONVENTIONS.md) — Conventions and patterns used throughout the codebase.

## Architecture and internals

- [Architecture map](ARCHITECTURE.md) — The top-level walkthrough and pointers into every internals doc.
- [Architecture index](architecture/README.md) — Core design, retrieval and extraction pipelines, the knowledge model, and decision records.
- [Trace to Observation to Primitive](trace-to-primitive.md) — How noisy session traces become durable memory primitives.
- [Tech stack](tech-stack.md) — Runtime, language, storage, and dependency choices at a glance.
- [Writing a search backend](writing-a-search-backend.md) — Implement a custom `SearchBackend` adapter.
- [Ingestion benchmark frontmatter schema](bench-ingestion-schema.md) — The canonical page frontmatter the schema-completeness rubric scores.

## Contributing and development

- [Contributing](development/contributing.md) — How to set up, build, and contribute to Remnic.
- [Plugin development guide](development/plugin-development.md) — Build a Remnic plugin for a new AI agent platform.
- [Release process](development/release-process.md) — Independent per-package versioning with Changesets.
- [PR review hardening playbook](ops/pr-review-hardening-playbook.md) — Review checklist for PRs that touch behavior, performance, safety, or compatibility.
- [Plugin engineering patterns](ops/plugin-engineering-patterns.md) — Engineering patterns for retrieval, intent, and cache work.
- [Rule graduation ledger](ops/rule-graduations.md) — How prose rules graduate into machine-enforced checks.
- [Memory-extraction threat model](security/memory-extraction-threat-model.md) — The threat Remnic's memory surface faces and the hardening approach.
- [Support passport threat model](security/support-passport-threat-model.md) — The owner, helper, grant, model, and browser security boundaries for What Helps Me.
- [Entity isolation audit](security/entity-isolation-audit.md) — Audit of cross-entity memory isolation guarantees.
- [Example memory extension](extensions/example-github-issues/README.md) — A worked example of publishing a third-party memory extension.

## Project history and research

Point-in-time records, kept for provenance. These are not current how-to docs.

- [Plans index](plans/README.md) — Historical design and roadmap plans, plus the archive layout.
- [Research paper](paper/README.md) — The Glass-Box Memory working-draft paper and appendices.
- [Research paper mapping](research/paper-mapping.md) — How shipped feature families map to the papers that inspired them.
- [Ideas backlog](ideas/README.md) — Exploratory ideas not yet on the roadmap.
- [Requirements and product specs](requirements/README.md) — Historical requirements documents.
- [Rename record](RENAME.md) — The Engram to Remnic rename plan and status (explains remaining `engram` identifiers).
- [Superpowers specs and plans](superpowers/) — Benchmark-suite design specs and implementation plans (April 2026).
- [Hackathon materials](hackathon/) — Build Week demo script and Devpost submission text.
- [RCA: PR #11 review churn](ops/rca-pr11-review-churn-2026-02-21.md) — Root-cause analysis behind the plugin engineering patterns.
- [ADAM baseline (April 2026)](security/adam-baseline-2026-04.md) — Point-in-time attack-success-rate measurements for the extraction attack harness.
- [Bounded memory contracts experiment](experiments/bounded-memory-contracts.md) — Ablation of memory/context strategies under a controlled harness.
- [Bug 001: agents hang after `before_agent_start`](bugs/001-agents-hang-after-before-agent-start-hook.md) — Historical bug report.
- Dated benchmark runs: [Gemma LM Studio baseline](bench/2026-04-19-gemma-lmstudio-baseline.md) and [full-suite attempt](bench/2026-04-20-gemma-lmstudio-full-suite-attempt.md).

For live priorities, see the [Remnic feature roadmap](https://github.com/users/joshuaswarren/projects/1).
