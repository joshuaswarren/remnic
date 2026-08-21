---
"@remnic/core": patch
---

Add `validateRefineRewrite` (new `recall-deep-rewrite.ts`) for deep-recall REFINE policy: reject a rewrite that is empty, identical to the current query after case/whitespace normalization, or submitted once the per-invocation refine budget (`MAX_REFINES_PER_INVOCATION`) is spent; every rejection carries `stop: true` and a machine-readable reason. Part of #2332
