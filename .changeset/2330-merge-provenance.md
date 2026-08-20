---
"@remnic/core": patch
---

Add `buildMergeFrontmatterUpdate`, a pure function computing merge frontmatter for issue #2330 step 3: appends incoming provenance sources after the target's (dedup on the exact `sessionKey`/`turnId`/`quote` triple, first occurrence wins), rejects blank source fields with `RangeError`, sets a fresh `updated` timestamp echoed verbatim from `nowIso`, `derived_via: "semantic-merge"`, and `merge_count` incremented from the target's count. Inputs are never mutated. Part of #2330.
