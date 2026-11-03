---
"@remnic/core": patch
"@remnic/cli": patch
---

Stability: stable

Invalidate warm embedding caches after offline-sync chunk publications and converge shard deletions, even when directory timestamps alias. Share the index store's two-phase generation marker under its mutation lock; partial chunks and unchanged files retain their stamp, while failed publications force revalidation. Fixes #3182.
