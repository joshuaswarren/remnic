# Architecture and internals

How Remnic is built: the host-agnostic core, the pipelines that turn conversation
into durable memory, and the extension points you hook into. Start with the
[overview](overview.md), then dive into the subsystem you care about. For the
top-level map, see [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md); to return to the
docs hub, see [`docs/README.md`](../README.md).

## Core

- [Architecture overview](overview.md) — The whole system: local-first, host-agnostic `@remnic/core`, storage layout, and how components fit together.
- [Monorepo structure](monorepo-structure.md) — How the 25+ packages are organized around the core, and what each layer owns.
- [Memory lifecycle](memory-lifecycle.md) — A memory from conversation turn through consolidation to expiry.
- [Shared memory architecture](shared-memory.md) — One memory owner on disk; how every agent reads and writes the same files.
- [Embedded vs delegate mode](embedded-vs-delegate.md) — The two ways the OpenClaw bridge runs, and when to pick each.
- [Binary lifecycle](binary-lifecycle.md) — Mirror, redirect, and clean stages for images, PDFs, audio, and video in the memory directory.

## Retrieval and extraction pipelines

- [Retrieval pipeline](retrieval-pipeline.md) — What happens on recall, end to end, before each agent session.
- [Enrichment pipeline](enrichment-pipeline.md) — Importance-tiered external API spend for entity enrichment.
- [Extraction judge](extraction-judge.md) — Optional LLM-as-judge gate that scores candidate facts against a durability rubric before write.
- [Semantic chunking](semantic-chunking.md) — Smoothing-based topic-boundary detection for splitting memory into chunks.
- [Graph reasoning](graph-reasoning.md) — The opt-in graph layer: explicit storage plus bounded traversal on top of normal recall.
- [Citations](citations.md) — Codex-compatible `<oai-mem-citation>` blocks for memory attribution.
- [Page-level versioning](page-versioning.md) — How memory pages are versioned over time.

## Knowledge model and extensions

- [MECE taxonomy](mece-taxonomy.md) — The knowledge directory and resolver decision tree.
- [Memory extensions architecture](memory-extensions.md) — How third-party tools supply structured instructions that influence consolidation.
- [Memory extension publishers](memory-extension-publishers.md) — The mechanism that installs host-specific instruction files into each agent host.
- [Authentication model](auth-model.md) — Per-plugin/connector auth tokens and where they are stored.

## Decision records

- [QMD 2.0 integration decision](qmd-2-integration-decision.md) — Dated ADR for adopting the QMD 2.0 search substrate (issue #231).
- [EMO/OEO architecture split](emo-oeo-split.md) — Decision record for the memory-orchestrator / observer split.

## Related internals (top level)

- [Trace to Observation to Primitive](../trace-to-primitive.md) — Canonical walkthrough of the observation pipeline (issue #685).
- [Tech stack](../tech-stack.md) — Runtime, language, storage, and dependency choices at a glance.
- [Writing a search backend](../writing-a-search-backend.md) — Implement a custom `SearchBackend` adapter.
- [Ingestion benchmark frontmatter schema](../bench-ingestion-schema.md) — The canonical page frontmatter the schema-completeness rubric scores against.
