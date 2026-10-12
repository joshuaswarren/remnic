---
"@remnic/core": patch
---

Stability: stable

Stop harmonic recall from scanning the whole hot memory corpus before phase-2 can format already-finished QMD hits. When the memory projection is openable, was rebuilt within the last 7 days, and is recorded as complete, source validation resolves only the source ids the abstraction nodes reference: it reads their projected paths (and the matching `cold/` path), and probes the dated directories created since the last rebuild for ids the projection has no row for. Unprojected ids that are not safe path segments never resolve, and `questions/` is never probed. A missing, unreadable, older, scoped, or pre-existing projection keeps the previous full scan.

`remnic` projection rebuilds now record `complete` in the projection meta (true only for unscoped rebuilds). A projection written by an earlier version has no such key, so recall keeps the full scan until the next unscoped rebuild; the scheduled rebuild or a manual projection rebuild after upgrading enables the fast path.
