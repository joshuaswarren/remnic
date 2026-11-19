---
"@remnic/core": patch
Stability: stable
---

Harmonic retrieval graph builds now read abstraction nodes, cue anchors, projected source memories, and the unresolved-source corpus walk in 50-wide `Promise.all` batches instead of awaiting each file in turn (#3450). A cold build resolved ~7k reads serially and could take ~13-17 s on a large corpus; every recall that missed the shared graph cache paid that whole wait or deadline-exited. Result order, abort checks, fail-open artifact handling, path containment, and durable source-path cache semantics are unchanged — the batch idiom matches `readParsedMemoriesFromPaths` (#2307).
