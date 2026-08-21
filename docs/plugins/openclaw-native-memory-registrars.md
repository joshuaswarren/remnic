# OpenClaw Native Memory Registrar Spike

Checked on 2026-05-04 against:

- `openclaw/openclaw` `9eed48fde5a9e742b69803b4895bd6f3f45ca821`
- `openclaw/kitchen-sink` `f57a0fc7c430c928bbe8049e5d69e6c7b806ed12`

The OpenClaw kitchen-sink plugin exercises three native memory-related
registrars that are adjacent to Remnic:

- `registerMemoryEmbeddingProvider()`
- `registerMemoryCorpusSupplement()`
- `registerCompactionProvider()`

## Decision

Keep `registerMemoryCapability()` as Remnic's primary OpenClaw integration
point, but also register the compatible split memory surfaces that map directly
to Remnic's existing adapter:

- `registerMemoryRuntime()` receives the same runtime object exposed through
  `registerMemoryCapability({ runtime })`.
- `registerMemoryFlushPlan()` receives the same resolver exposed through
  `registerMemoryCapability({ flushPlanResolver })`.
- `registerMemoryCorpusSupplement()` exposes read-only Remnic search/get access
  as an additive corpus surface.

Do not register OpenClaw embedding or compaction providers yet. Those surfaces
make OpenClaw call Remnic as an embedding backend or transcript summarizer,
which reverses the current ownership model and needs a separate product
decision.

## Surface Map

| OpenClaw surface | Current upstream contract | Remnic mapping | Decision |
|---|---|---|---|
| `registerMemoryEmbeddingProvider()` | Registers an embedding-provider adapter with `create()`, `embedQuery()`, `embedBatch()`, optional multimodal support, and runtime batch metadata. | Remnic already owns embedding and index lifecycle inside `@remnic/core` and its QMD/runtime manager. Registering here would make OpenClaw call Remnic as an embedding backend for OpenClaw-owned memory, which is the wrong ownership direction. | Not a fit yet. Keep embeddings behind Remnic's runtime manager. |
| `registerMemoryCorpusSupplement()` | Registers an additive corpus supplement with `search({ query, maxResults, agentSessionKey })` and `get({ lookup, fromLine, lineCount, agentSessionKey })`. Supplements live alongside, not instead of, the active memory capability. | Remnic maps this to a read-only corpus over Remnic memory search/read results, with Remnic provenance and artifact/private-state filtering. | Implemented as a service-scoped corpus ID: `<serviceId>:remnic-memory-corpus`. |
| `registerCompactionProvider()` | Registers a provider with `summarize({ messages, signal, compressionRatio, customInstructions, summarizationInstructions, previousSummary })` that can replace OpenClaw's built-in transcript compaction summarizer. | Remnic observes compaction/reset boundaries, saves checkpoints, and flushes memory around lifecycle events. It does not own the user-facing transcript summary OpenClaw needs for context management. | Not applicable. Keep compaction hooks and checkpointing, not summary replacement. |
| `registerMemoryRuntime()` | Deprecated split runtime registration that patches the active memory capability with runtime search/read/status/sync behavior. | Remnic already builds a runtime object for `registerMemoryCapability({ runtime })`. | Implemented with the same runtime object for split-surface SDK consumers. |
| `registerMemoryFlushPlan()` | Deprecated split flush-plan registration that patches the active memory capability with pre-compaction flush thresholds and prompts. | Remnic can provide a conservative flush plan aligned with its extraction ownership and credential/privacy policy. | Implemented with the same resolver included in `registerMemoryCapability({ flushPlanResolver })`. |

## Why `registerMemoryCapability()` Still Fits

`registerMemoryCapability()` matches Remnic's shape as a complete memory adapter:
prompt building, runtime search/read, backend status, flush planning, and
public artifacts can live under one exclusive memory-slot capability. The split
surface registrations now mirror the same objects for SDK/runtime paths that
still consume them directly. That keeps OpenClaw-specific code thin while
preserving Remnic core ownership of storage, retrieval, extraction,
consolidation, and QMD behavior.
