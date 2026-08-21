# Engram Agentic Memory Roadmap

**Status:** active roadmap  
**Scope:** benchmark-first roadmap for the next 10+ Engram improvements  
**Rollout model:** small PR slices, defaults-off feature flags, measurable regressions blocked before merge

This roadmap supersedes the near-term direction in the earlier memory-OS roadmap by moving evaluation and measurement to the front of the queue.

## Best-In-World Thesis

If Engram is going to become the best agentic memory system in the world, it has to optimize for three things:

- **Memory that improves action outcomes**
- **Memory that survives long horizons and failures**
- **Memory that can defend itself**

That implies this priority order:

1. Evaluation harness and shadow-mode measurement.
2. Objective-state + causal trajectory memory.
3. Trust-zoned memory promotion and poisoning defense.
4. Harmonic retrieval over abstractions plus anchors.
5. Creation-memory, commitments, and recoverability.

## Source Stack Driving This Roadmap

Primary research:

- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769
- AgentSys: https://arxiv.org/abs/2602.07398
- AgentLAB: https://arxiv.org/abs/2602.16901
- Memora: https://arxiv.org/abs/2602.03315
- Human-Inspired Memory Modeling: https://arxiv.org/abs/2602.15513
- Synapse: https://arxiv.org/abs/2601.02744
- SimpleMem: https://arxiv.org/abs/2601.02553
- PlugMem: https://arxiv.org/abs/2603.03296
- REMem: https://arxiv.org/abs/2602.13530
- E-Mem: https://arxiv.org/abs/2601.21714

Operator pain and social signal:

- Creation memory problem: https://www.reddit.com/r/AIMemory/comments/1rdffhk/ai_agents_have_a_creation_memory_problem_not_just/
- Recoverability under load: https://www.reddit.com/r/AIMemory/comments/1rdsjui/ai_memory_isnt_about_recall_its_about/
- Wrong mental model: https://www.reddit.com/r/AISystemsEngineering/comments/1rdf4ej/ai_memory_isnt_just_chat_history_but_were_using/

## Non-Negotiables

1. Every new capability ships behind explicit config flags.
2. Every PR slice is small enough to verify with focused tests.
3. Benchmark and shadow-measurement paths arrive before behavior-changing ranking logic.
4. Fail-open compatibility stays intact when flags are off.
5. README and docs stay aligned with the real shipped surface.

## The 12 Improvement Tracks

### 1. AMA-Bench-style evaluation harness

Why:
- Agent memory must be evaluated on real agent trajectories, not chat QA.
- Current systems fail because they miss objective state and causality.

Source:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769

Flags:
- `evalHarnessEnabled`
- `evalShadowModeEnabled`
- future: `evalAutoRecordEnabled`

PR slices:
- PR1: eval storage contract, typed manifests/run summaries, `benchmark-status`
- PR2: benchmark pack validator/import tools and docs
- PR3: shadow recording for live recall decisions
- PR4: CI gate that compares benchmark deltas across PRs

### 2. Objective-state memory as a first-class store

Why:
- Engram remembers facts and artifacts today, but not enough normalized world/tool state.
- The biggest gap between retrieval memory and agent memory is remembering what actually changed in the world.

Source:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769

Flags:
- `objectiveStateMemoryEnabled`
- `objectiveStateSnapshotWritesEnabled`

PR slices:
- PR5: state snapshot schema and store
- PR6: normalized file/tool/process snapshot writers
- PR7: objective-state retrieval formatter and ranking hooks

### 3. Action-conditioned causal trajectory memory

Why:
- Plain semantic overlap is too lossy.
- Engram needs `goal -> action -> observation -> outcome -> follow-up` chains.

Source:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769

Flags:
- `causalTrajectoryMemoryEnabled`
- `actionGraphRecallEnabled`

PR slices:
- PR8: causal trajectory schema and storage
- PR9: action-conditioned graph construction
- PR10: trajectory-aware retrieval and explainability

### 4. Hierarchical trust zones

Why:
- Raw tool output, web content, and subagent traces should not flow directly into durable core memory.
- Engram needs quarantine, working, and trusted tiers with promotion rules.

Source:
- AgentSys: https://arxiv.org/abs/2602.07398

Flags:
- `trustZonesEnabled`
- `quarantinePromotionEnabled`

PR slices:
- PR11: trust-zone schemas and storage paths
- PR12: promotion rules and provenance enforcement
- PR13: trust-zone-aware retrieval filters

### 5. Memory-poisoning defenses and a red-team suite

Why:
- Long-horizon attacks target memory as a persistence layer.
- The defense has to be benchmarked, not just described.

Source:
- AgentLAB: https://arxiv.org/abs/2602.16901

Flags:
- `memoryPoisoningDefenseEnabled`
- `memoryRedTeamBenchEnabled`

PR slices:
- PR14: provenance trust scoring
- PR15: corroboration rules for risky promotions
- PR16: attack benchmark packs and regression suite

### 6. Harmonic retrieval over abstractions plus anchors

Why:
- Abstraction nodes alone lose detail.
- Fine-grained anchors alone lose compression.
- Engram should retrieve through both.

Source:
- Memora: https://arxiv.org/abs/2602.03315

Flags:
- `harmonicRetrievalEnabled`
- `abstractionAnchorsEnabled`

PR slices:
- PR17: abstraction-node schema
- PR18: cue-anchor index for entities/files/tools/outcomes/constraints/dates
- PR19: harmonic retrieval blender and diagnostics

### 7. Episodic and semantic memory split with verification on recall

Why:
- The strongest recent embodied-memory signal is: retrieve episodic traces, verify them, and separately extract reusable semantic rules.

Source:
- Human-Inspired Memory Modeling: https://arxiv.org/abs/2602.15513

Flags:
- `verifiedRecallEnabled`
- `semanticRulePromotionEnabled`

PR slices:
- PR20: verified episodic recall flow
- PR21: semantic rule extraction/promotion
- PR22: recall-time verifier and confidence downgrade paths

### 8. Creation-memory ledger

Why:
- Operators care whether agents remember what they created.
- This is a core missing capability in long-running agent systems.

Sources:
- https://www.reddit.com/r/AIMemory/comments/1rdffhk/ai_agents_have_a_creation_memory_problem_not_just/
- https://www.reddit.com/r/AIMemory/comments/1rdsjui/ai_memory_isnt_about_recall_its_about/
- https://www.reddit.com/r/AISystemsEngineering/comments/1rdf4ej/ai_memory_isnt_just_chat_history_but_were_using/

Flags:
- `creationMemoryEnabled`

PR slices:
- PR23: work-product ledger schema and writes
- PR24: artifact recovery/reuse retrieval path

### 9. Commitment ledger

Why:
- Agents need to remember promises, pending follow-ups, and unfinished obligations as first-class memory, not just inferred facts.

Sources:
- same operator pain links as creation-memory

Flags:
- `commitmentLedgerEnabled`

PR slices:
- PR25: explicit commitment ledger
- PR26: fulfillment and stale-commitment lifecycle integration

### 10. Crash-recovery resume bundles

Why:
- Recoverability is part of memory quality.
- Agents need compact, restart-safe bundles that reconstruct work state quickly.

Sources:
- same operator pain links as creation-memory

Flags:
- `resumeBundlesEnabled`

PR slices:
- PR27: resume bundle format
- PR28: resume-bundle builder from transcripts + objective state + commitments

### 11. Utility learning for promotion and ranking

Why:
- Memory promotion should be tied to downstream usefulness, not only extraction confidence.

Sources:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769
- PlugMem: https://arxiv.org/abs/2603.03296

Flags:
- `memoryUtilityLearningEnabled`
- `promotionByOutcomeEnabled`

PR slices:
- PR29: utility telemetry schema
- PR30: offline learner for promotion weights
- PR31: bounded runtime application of learned weights

### 12. Benchmark-gated release discipline

Why:
- The eval harness is not complete until PRs can fail for making memory worse.

Sources:
- All of the above; this is the operationalization layer.

Flags:

PR slices:
- PR32: benchmark baseline snapshots
- PR33: PR delta reporter
- PR34: required-check rollout and docs

## Recommended Delivery Waves

### Wave 1: measure first

- PR1 to PR4
- Goal: benchmark packs, run summaries, shadow mode, CI comparison

### Wave 2: objective and causal memory

- PR5 to PR10
- Goal: state snapshots and action-conditioned trajectories

### Wave 3: defense and trust

- PR11 to PR16
- Goal: trust zones, provenance, poisoning defenses, red-team packs

### Wave 4: richer retrieval

- PR17 to PR22
- Goal: harmonic retrieval, episodic/semantic verification, better abstractions

### Wave 5: recoverability and adaptive promotion

- PR23 to PR34
- Goal: creation memory, commitments, resume bundles, utility learning, CI gates

## README Work Required Alongside the Roadmap

README updates should happen continuously, not as a single cleanup at the end.

Required README direction:

1. Put the product thesis near the top.
2. Describe Engram as a memory OS, not just a recall plugin.
3. Surface benchmark-first development as part of the public story.
4. Keep shipped surface and roadmap direction clearly separated.
5. Link to the evaluation harness doc and roadmap directly.

## Definition of Done for This Roadmap Program

Engram should be able to prove, not merely claim, that:

- memory changes improve action outcomes
- long-horizon continuity survives failures and restarts
- unsafe or poisoned memories are contained and downgraded
- PRs cannot silently degrade benchmarked memory behavior
