---
"@remnic/core": patch
Stability: stable
---

Repeat recalls over a cached harmonic graph no longer re-tokenize every node and anchor field per call (#3450). `searchHarmonicRetrieval` now builds a per-graph scoring index (node token sets, anchor token sets, and the node lookup map) once, memoized on the frozen graph object via `WeakMap`; scorers read precomputed `Set`s identical to what `countRecallTokenOverlap` produced, so scores, matchedFields, ordering, and eligibility are unchanged. Measured on the production corpus (~2.5k nodes, ~10k anchors): warm `searchHarmonicRetrieval` dropped from ~750 ms to ~16 ms; an uncached call pays the same one-pass tokenization as before.
