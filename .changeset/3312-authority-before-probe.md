---
"@remnic/core": patch
---

Stability: stable

Snapshot fact-hash index authority before the content-hash probe in `confirmActiveFactDuplicate`, so a rebuild that finishes between a stale MISS and the authority read cannot turn that MISS into a clean not-duplicate and admit a raced active write. The authoritative-MISS fast path is unchanged. Fixes #3312 (finding 2).
