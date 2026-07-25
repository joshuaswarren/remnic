# Memory Lifecycle

## Write Path

```
Conversation turn arrives
        │
        ▼
 Signal scan (local regex, <10 ms, no API call)
        │
        ▼
 Append to smart buffer
        │
        ▼
 Trigger check:
   HIGH signal?    ──► Extract NOW (immediate, single LLM call)
   Buffer ≥ N?     ──► Extract BATCH
   Time > T mins?  ──► Extract BATCH
   else            ──► Keep buffering
        │
        ▼
 LLM extraction (OpenAI Responses API)
   - Returns typed facts with confidence scores
   - 10 categories: fact/preference/correction/entity/decision/
     relationship/principle/commitment/moment/skill
        │
        ▼
 Content-hash deduplication (v6.0)
   - SHA-256 of normalized content
   - Duplicate? → skip write silently
        │
        ▼
 memoryKind classification (v8.0, if episodeNoteModeEnabled)
   - episode: time-specific event
   - note: stable belief/decision/preference
        │
        ▼
 Write markdown files to disk
   - facts/YYYY-MM-DD/<category>-<timestamp>-<hash>.md
   - Verbatim artifact written if eligible (v8.0)
        │
        ▼
 Memory Box update (v8.0, if memoryBoxesEnabled)
   - Append to open box or seal + start new box
   - Trace Weaver links recurring-topic boxes
        │
        ▼
 Background: qmd update (re-index new files)
```

## Consolidation Pass

Runs every `consolidateEveryN` extractions (default 3):

```
Consolidation
   │
   ├─ Merge / dedup memories (LLM-assisted contradiction detection)
   ├─ Merge fragmented entity files
   ├─ Update entity profiles (per-entity markdown)
   ├─ Update behavioral profile (profile.md, with line-cap enforcement)
   ├─ Clean expired commitments (TTL based on commitmentDecayDays)
   ├─ Expire speculative memories (TTL 30 days if unconfirmed)
   ├─ Archive old, low-importance facts (v6.0, if factArchivalEnabled)
   ├─ Auto-consolidate IDENTITY.md reflections (when > 8 KB)
   ├─ Update topic index (state/topics.json)
   ├─ Learn compression guidelines from action telemetry (v8.3, if compressionGuidelineLearningEnabled)
   └─ Update QMD index (qmd update)
```

### Compression Guideline Learning (v8.3 PR21D)

When `compressionGuidelineLearningEnabled=true`, each consolidation pass runs a fail-open guideline synthesis step:

- Reads recent telemetry from `state/memory-actions.jsonl`
- Produces/update `state/compression-guidelines.md`
- Summarizes action/outcome distributions and emits conservative next-step guidance

This pass never blocks consolidation. On read/write errors, it logs and continues.

### Memory Action Policy Contracts (v8.13 Task 1)

The action-policy layer uses a strict taxonomy and bounded eligibility context:

- Action taxonomy: `store_episode`, `store_note`, `update_note`, `create_artifact`, `summarize_node`, `discard`, `link_graph`
- Eligibility context fields:
  - `confidence` (`0..1`)
  - `lifecycleState` (`active|validated|candidate|stale|archived`)
  - `importance` (`0..1`)
  - `source` (`extraction|consolidation|replay|manual|unknown`)

Parsing is strict for schema validation and fail-open in runtime helpers:

- Invalid action values fall back to `discard`.
- Invalid eligibility payloads fall back to `{ confidence: 0, lifecycleState: "candidate", importance: 0, source: "unknown" }`.

### Hot/Cold Tier Routing Signals (v8.14 Task 2)

Tier routing reuses lifecycle value inputs so demotion/promotion decisions stay consistent with lifecycle scoring:

- `computeLifecycleValueInputs(...)` (in `packages/remnic-core/src/lifecycle.ts`) provides normalized confidence/access/recency/importance/feedback signals plus disputed penalty.
- `computeTierValueScore(...)` (in `packages/remnic-core/src/tier-routing.ts`) derives a bounded value score from those inputs, adding correction/confirmation boosts and disputed penalties.
- `decideTierTransition(...)` applies deterministic threshold rules:
  - hot -> cold when age >= `qmdTierDemotionMinAgeDays` and value <= demotion threshold
  - cold -> hot when value >= promotion threshold
  - no-op when migration is disabled

## Memory States

| Status | Description |
|--------|-------------|
| `active` | Normal, searchable, in hot index |
| `superseded` | Replaced by a newer memory; still on disk |
| `archived` | Moved to a top-level `archive/` store; excluded from generic recall and available through explicit read or search surfaces |

## Lifecycle Policy States (v8.3)

When `lifecyclePolicyEnabled` is on, memories can also carry policy metadata:

- `lifecycleState`: `candidate | validated | active | stale | archived`
- `verificationState`: `unverified | user_confirmed | system_inferred | disputed`
- `policyClass`: `ephemeral | durable | protected`
- scores: `heatScore` and `decayScore` (both in `[0,1]`)

`status` remains the storage lifecycle, while `lifecycleState` controls retrieval weighting/filtering.
If lifecycle fields are absent (legacy memories), retrieval fail-opens to pre-v8.3 behavior.

### Retrieval Integration (PR20D)

With lifecycle policy enabled:

- `active` / `validated` receive a small retrieval score boost
- `candidate` gets a slight penalty
- `stale` gets a stronger penalty
- `verificationState=disputed` gets an additional penalty

Optional hard filtering:

- If `lifecycleFilterStaleEnabled=true`, `stale` and `archived` lifecycle candidates are filtered before final top-K cap.
- Top-level `<memoryDir>/archive/...` and `<memoryDir>/namespaces/<name>/archive/...` paths are excluded from generic recall; nested category paths named `archive` remain recallable.

Memories in `superseded` or `archived` status remain on disk. However, **speculative TTL expiry** and **commitment decay** physically delete files via `unlink` — these entries are not retained.

## Expiry and Archival

### Speculative TTL

Memories with `confidenceTier: speculative` (confidence < 0.40) auto-expire after 30 days if not confirmed by a later extraction.

### Commitment Decay

Commitments marked as resolved (`fulfilled` or `expired`) are removed after `commitmentDecayDays` (default 90). Unresolved/active commitments are not automatically purged.

### Fact Archival (v6.0)

A fact is archived when **all** of these are true:
- Age > `factArchivalAgeDays` (default 90 days)
- Importance < `factArchivalMaxImportance` (default 0.3)
- Access count ≤ `factArchivalMaxAccessCount` (default 2)
- Category not in `factArchivalProtectedCategories` (default: commitment, preference, decision, principle)
- Status is `active` and not a correction

Config: `factArchivalEnabled` (default `false`).

## Memory Box Lifecycle (v8.0)

```
Extraction produces memories on topic T
        │
        ▼
BoxBuilder: open box exists for T?
   YES → append (check seal conditions)
   NO  → create new open box
        │
 Seal conditions:
   - Topic overlap drops below boxTopicShiftThreshold (default 0.35)
   - Inactivity exceeds boxTimeGapMs (default 30 minutes)
   - Memory count exceeds boxMaxMemories (default 50)
        │
        ▼
 Sealed box written to boxes/YYYY-MM-DD/box-<id>.md
        │
        ▼
 TraceWeaver: find existing trace with overlapping topics?
   YES → assign same traceId
   NO  → create new trace
```

## Episode/Note Reconsolidation (v8.0)

When `episodeNoteModeEnabled` is on:

- `episode` memories preserve event fidelity — stored as-is
- `note` memories are candidates for reconsolidation: when a conflict is detected during consolidation, the newer note can update or supersede the older one

Classification priority:
1. True temporal markers (yesterday, today, last Tuesday…) → `episode`
2. Extraction category (preference, decision, commitment… → `note`; event, action, moment… → `episode`)
3. Tag signals (note tags win over episode tags)
4. Past-tense action verbs (deployed, merged, fixed…) → `episode`
5. Note-signal keywords (prefers, always, must…) → `note`
6. Default → `episode`

## Content-Hash Deduplication (v6.0)

Before every write, Remnic normalizes the content (lowercase, strip punctuation, collapse whitespace) and checks a SHA-256 hash against `state/fact-hashes.txt`. Duplicates are skipped silently. The index is seeded from existing memories on first enable.

Config: `factDeduplicationEnabled` (default `true`).

## Graph Edge Lifecycle (issue #681)

Memories are linked through the multi-graph layer (entity, time, causal). Each
edge carries an optional `confidence ∈ [0, 1]` field that participates in the
lifecycle in three places:

1. **Reinforcement (PR 1/3, shipped)** — observing the same edge again bumps
   `confidence` by `DEFAULT_REINFORCE_DELTA` (capped at `1.0`) and stamps
   `lastReinforcedAt = now`.
2. **Decay (PR 2/3, shipped)** — the maintenance job linearly decays
   confidence by `perWindow` per `windowMs` once the grace period has
   elapsed, never below `floor`.
3. **Recall weighting & pruning (PR 3/3)** — the recall path multiplies edge
   `weight` by `confidence` when computing activation, prunes edges below
   `graphTraversalConfidenceFloor` (default `0.2`), and optionally refines
   the ranking with `graphTraversalPageRankIterations` PageRank-style
   iterations (default `8`). Operators see the resulting per-edge
   confidences in the recall X-ray (`graphEdgeConfidences`) and the
   recall-explain document (`conf=0.87`).

Legacy edges that pre-date the schema have no `confidence` field; the recall
layer treats them as `1.0` so existing graphs keep working unchanged until a
reinforcement or decay event materializes the value.

For the full traversal contract see
[`graph-reasoning.md`](graph-reasoning.md).

## See Also

- [Architecture Overview](overview.md)
- [Retrieval Pipeline](retrieval-pipeline.md)
- [Graph Reasoning](graph-reasoning.md)
- [Config Reference](../config-reference.md)
