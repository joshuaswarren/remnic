---
"@remnic/core": patch
---

Recall no longer re-reads the whole harmonic graph from disk on every call. The projected nodes and cue anchors are cached in memory and reused until a memory, node or cue anchor write bumps a version sentinel (the memory corpus, memory status and cold-write sentinels, plus a new `.harmonic-graph-version.log` in the abstraction node store). On a live graph of 2107 nodes, 9199 anchors and 4105 source memories, the projection was 4.6 to 5.1 s of every recall's harmonic stage. The cache is opt-in per call (`useGraphCache`), enabled only by the recall path, bypassed when a caller passes `nowMs`, and capped by a 30 s TTL for wall-clock validity expiry.

Stability: stable
