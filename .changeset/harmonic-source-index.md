---
"@remnic/core": patch
---

Stability: stable

Stop harmonic recall from scanning the whole hot memory corpus before phase-2 can format already-finished QMD hits. When the memory projection is openable, was rebuilt within the last 7 days, and is recorded as complete, source validation resolves only the source ids the abstraction nodes reference: it reads their projected paths (and the matching `cold/` path), and probes the dated recall-category directories created since the last rebuild for ids the projection has no row for. Direct probes must resolve inside the memory root (symlinks that leave it are ignored), `questions/` and `artifacts/` are never probed, and an unprojected id is joined into a path only when it is a single safe path segment. An id the probes cannot place (for example an import filed under an old date) is looked up by one contained path-only walk, and ids confirmed absent are remembered for 10 minutes so a dangling source id does not force a walk on every recall. A missing, unreadable, older, scoped, or pre-existing projection keeps the previous full scan.

`remnic` projection rebuilds now record `complete` in the projection meta (true only for unscoped rebuilds). A projection written by an earlier version has no such key, so recall keeps the full scan until the next unscoped rebuild; the scheduled rebuild or a manual projection rebuild after upgrading enables the fast path.
