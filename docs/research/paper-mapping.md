# Research Paper Mapping

This document maps shipped Engram feature families to the papers and concepts that inspired them. It is not a promise that every idea in the historical plans is fully productized.

## Mapping Table

| Engram surface | Research / concept influence | Live status |
|----------------|------------------------------|-------------|
| Recall planner, intent routing, artifact anchors | Memory-OS style policy gating and quote-first recall | Shipped, opt-in by config where noted |
| HiMem episode/note split | HiMem-style separation of episodic vs stable memory | Shipped |
| Memory boxes + trace weaving | Structured continuity windows and trace linkage | Shipped |
| Temporal + tag indexes | SwiftMem-style query-aware prefilter signals | Shipped |
| Temporal memory tree | TiMem-style time-bucket summaries | Shipped |
| Multi-graph memory + graph recall | MAGMA / SYNAPSE-inspired graph storage and bounded traversal | Shipped behind opt-in graph flags |
| Lifecycle policy engine | MemoryOS-style promotion / stale / archive policy | Shipped behind opt-in flags |
| Proactive self-questioning + action telemetry | Policy-learning and self-questioning extraction loops | Shipped behind opt-in flags |
| Compression guideline learning | ACON / policy-optimizer style bounded learning loop | Shipped behind opt-in flags |
| Harmonic retrieval, verified episodes, verified rules | Multi-signal retrieval with provenance checks | Shipped behind opt-in flags |
| Local LLM primary + fast tier | Cost-aware local inference routing | Shipped |

## Reading Historical Plans Correctly

Historical v8 plan files are useful for:

- rationale
- naming context
- design tradeoffs
- ideas that were intentionally deferred

They are not the roadmap source of truth. Use the GitHub Project for current sequencing and treat any historical plan claim as provisional until the live code, config surface, tests, and docs all agree.
