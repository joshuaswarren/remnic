# Trace → Observation → Primitive

> Issue: [#685 — Name and document the observation pipeline](https://github.com/joshuaswarren/remnic/issues/685).
>
> This page is the canonical walkthrough of how Remnic compresses
> noisy session traces into durable memory primitives. If you only
> read one piece of Remnic architecture, read this one.

## The one-liner

**The trace is noise. The primitive is the product.**

Remnic's job is the pipeline that converts the former into the latter.

## The three stages

```
┌────────────┐    extract     ┌──────────────┐  consolidate  ┌────────────┐
│   Trace    │  ─────────────▶│ Observation  │ ─────────────▶│  Primitive │
└────────────┘   importance   └──────────────┘    dedup       └────────────┘
   raw turns       judge          candidate       compound       durable
                                                                  memory
```

| Stage | What it is | Where it lives | Lifetime |
|-------|------------|----------------|----------|
| **Trace** | Raw conversation turns — every user message, every assistant reply, every tool call. Verbose, noisy, redundant. | `packages/remnic-core/src/buffer.ts` | Until session flush, then discarded. |
| **Observation** | Post-extraction, importance-scored fact candidate. The trace has been distilled but not yet committed to the corpus. | Emitted by `extraction.ts` / `extraction-judge.ts`; modeled by the public `MemoryObservation` type in `@remnic/core`. | In-flight only; not persisted unless promoted. |
| **Primitive** | Durable `MemoryFile` on disk: YAML frontmatter + markdown body. Searchable, citable, reinforceable. | `packages/remnic-core/src/storage.ts` writes them under `<memoryDir>/{facts,procedures,reasoning-traces,corrections}/`. | Persistent; subject to lifecycle (consolidation, supersession, retention). |

## Walkthrough: a 4-hour coding session

Concrete example. Anonymized but representative.

### Trace stage — buffer captures raw turns

The user opens a coding session. Over four hours they:
- Discuss the design of a new caching layer (~40 turns).
- Debug a flaky integration test (~25 turns, lots of stack traces).
- Decide on a deployment cadence ("we'll cut releases every Tuesday").
- Mention in passing that the Postgres replica lag alarm fires when GC pauses cross 200ms.

The buffer (`buffer.ts`) holds all of this — every turn, every tool call, every error. **Roughly 80,000 tokens of raw trace.**

The trace is the noise. We are not going to keep it.

### Extraction — distill the trace into observation candidates

When the buffer flushes (smart-flush signals: topic shift, time elapsed, explicit `before_reset`), `extraction.ts` calls the extractor (the configured extraction model via the OpenAI Responses API). The extractor reads the trace and emits zero or more `ExtractedFact` records, each with a category (decision, preference, fact, principle, …), content, confidence, and tags. A separate pass (`importance.ts` / `calibration.ts`) then assigns an importance score in `[0, 1]` — importance is computed *after* extraction, not part of the `ExtractedFact` payload itself.

For our session, the pipeline might emit (extractor output → after importance scoring):

1. `{ category: "decision", content: "Cut releases every Tuesday", confidence: 0.95 }` → `importance: 0.85`
2. `{ category: "fact", content: "Postgres replica lag alarm fires when GC pauses cross 200ms", confidence: 0.9 }` → `importance: 0.78`
3. `{ category: "principle", content: "Caching layer should be per-tenant, not global", confidence: 0.85 }` → `importance: 0.7`

The extraction judge (`extraction-judge.ts`) — opt-in via `extractionJudgeEnabled` (default `false`) — then post-filters when enabled: it asks an LLM whether each candidate is genuinely durable or just transient task chatter. In this walkthrough the flaky-test debugging turns produce no observations — they were noise.

Each surviving candidate becomes a `MemoryObservation` (the public type in `@remnic/core`):

```ts
import type { MemoryObservation } from "@remnic/core";

const observation: MemoryObservation = {
  id: "obs_018f9a...",
  sessionId: "sess_2026-04-25_coding",
  observedAt: "2026-04-25T18:32:11Z",
  fact: {
    category: "decision",
    content: "Cut releases every Tuesday",
    confidence: 0.95,
    tags: ["release-cadence", "ops"],
  },
  importance: 0.85,
  judgeAccepted: true,
};
```

**At this point: ~80,000 tokens of trace have become 3 observations totaling ~80 tokens.** The compression ratio is the product.

### Persist + consolidate — observations become primitives

The write path runs in two stages, not the "consolidate before persist" order an earlier draft implied:

1. **Persist immediately.** `runExtraction()` calls `persistExtraction(...)` so each accepted observation lands on disk as soon as the extraction judge approves it. Hash-dedup and supersession (`temporal-supersession.ts`) gate the write at this stage; superseded predecessors get `invalid_at` stamped without losing the file.
2. **Consolidate asynchronously.** `maybeScheduleConsolidation(...)` then schedules a separate consolidation pass (`semantic-consolidation.ts`, `dedup/`) that merges near-duplicates of recently persisted primitives, updates or invalidates older primitives that turn out to be redundant, and leaves genuinely new primitives unchanged. `resultingPrimitiveId` on the original `MemoryObservation` ends up pointing at the merged record after that pass.

A primitive *exists* before consolidation runs — consolidation refines an already-durable corpus rather than gating the write itself.

Each accepted observation is written by `storage.ts` as a `MemoryFile`. Illustrative subset of the keys `serializeFrontmatter` actually emits (the live serializer is the source of truth):

```yaml
---
id: mem_018f9a...
category: decision
created: 2026-04-25T18:32:11Z
updated: 2026-04-25T18:32:11Z
source: extraction
confidence: 0.95
confidenceTier: high
tags: ["release-cadence", "ops"]
importanceScore: 0.85
importanceLevel: high
status: active
---

Cut releases every Tuesday.
```

Importance is split into `importanceScore` (numeric in `[0, 1]`) and `importanceLevel` (categorical: `trivial` / `low` / `normal` / `high` / `critical`) on disk, and `updated` / `source` are always present alongside `id`, `category`, and `created`. See `serializeFrontmatter` in `packages/remnic-core/src/storage.ts` for the full key set.

That `MemoryFile` is the **primitive**. Three primitives now exist where four hours of conversation used to be.

### Reinforcement — primitives compound over time

`compounding/engine.ts` runs weekly, surfacing primitives that recurred or were referenced and bumping their access counters / heat scores. Stale, never-recalled primitives drift toward the cold tier under the lifecycle policy (issue #686). The retention substrate decides when a primitive is durable enough to keep, when it's cold enough to demote, and — via `openclaw engram forget` — when an operator wants it gone entirely.

## Why this framing matters

Most "AI memory" tools store the trace and call that memory. That's a recording, not memory. Memory is what survives the trace.

Remnic's pipeline produces primitives that are:
- **Compressed** — observations distill traces by ~1000x.
- **Searchable** — primitives are first-class records, not buried inside transcripts.
- **Citable** — every recall response includes `<oai-mem-citation>` blocks pointing back to the source primitive.
- **Reinforceable** — compounding raises the value of primitives that keep mattering.
- **Forgettable** — `openclaw engram forget <id>` is the explicit escape hatch.

The trace is noise. The primitive is the product.

## Where this shows up in the API

| Surface | What you'll see |
|---------|-----------------|
| `@remnic/core` types | The `MemoryObservation` interface ships in the public types so callers can read post-extraction state without reaching into `extraction.ts`. |
| `remnic doctor` | Reports observation throughput, judge accept/reject/defer breakdown, and the most recent `observedAt` via the `observations` check (issue #685). Reads from `state/observation-ledger/extraction-judge-verdicts.jsonl`. |
| `recall` responses | `<oai-mem-citation>` blocks point at the primitive ids that came out the other end of the pipeline. |
| `openclaw engram tier list` / `tier explain` | Inspect what happened to primitives after they were written (issue #686). |
| `observation-ledger` | A separate concept: a JSONL telemetry directory (`state/observation-ledger/`) capturing turn-count aggregates (`maintenance/rebuild-observations.ts`) and judge verdict events (`extraction-judge-telemetry.ts`). Operator-observability data, distinct from the lifecycle-event ledger and from the `MemoryObservation` type — see the naming note below. |

## Naming note: observation vs observation-ledger

`@remnic/core` has two things that share a root word:

| Term | Meaning |
|------|---------|
| `MemoryObservation` (this doc, public type) | The post-extraction, pre-storage candidate. The "observation" stage of Trace → Observation → Primitive. |
| `observation-ledger` (`state/observation-ledger/` directory) | Telemetry storage for the extraction pipeline itself: turn-count aggregates rebuilt by `maintenance/rebuild-observations.ts` (`rebuilt-observations.jsonl`) and judge verdict events appended by `extraction-judge-telemetry.ts`. Operator-observability data, not lifecycle transitions. Lifecycle events on primitives (supersession, archive, forget) live in `state/memory-lifecycle-ledger.jsonl`. |

`MemoryObservation` is the in-flight candidate type; `observation-ledger` is the on-disk telemetry directory describing how that pipeline performed. They share a word but describe different layers — the type is what the pipeline produces, the ledger directory is how it reports on itself. We considered renaming the directory to disambiguate but kept it for backward compatibility (operator tooling and crons reference the existing path). New code should reach for `MemoryObservation` when describing the extraction pipeline and `observation-ledger` only when referring to that telemetry storage.

## References

- agentmemory's `mem::observe` / `mem::compress` framing — the clearest public articulation of "trace is garbage; primitive is the product": <https://github.com/rohitg00/agentmemory>
- Karpathy's LLM Wiki concept (cited as design lineage by agentmemory).
- Pipeline modules: `buffer.ts`, `extraction.ts`, `extraction-judge.ts`, `importance.ts`, `calibration.ts`, `semantic-consolidation.ts`, `storage.ts`, `compounding/engine.ts`.
- Observation-ledger lifecycle events: `packages/remnic-core/src/maintenance/observation-ledger-utils.ts`.
- Retention substrate ([#686](https://github.com/joshuaswarren/remnic/issues/686)) — what happens to primitives over their year-2 lifetime.
