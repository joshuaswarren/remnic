---
"@remnic/core": patch
---

Stability: stable

Stop harmonic recall from scanning the whole hot memory corpus before phase-2 can format already-finished QMD hits. When the memory projection is openable and was rebuilt within the last 7 days, source validation resolves only the source ids the abstraction nodes reference: it reads their projected paths (and the matching `cold/` path), and probes the dated directories created since the last rebuild for ids the projection has no row for. Source ids that are not safe path segments never resolve, and `questions/` is never probed. A missing, unreadable, or older projection keeps the previous full scan.
