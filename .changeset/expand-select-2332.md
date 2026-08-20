---
"@remnic/core": patch
---

Add `selectExpandNodeIds` (internal, `recall-deep-expand-select.ts`): validate a deep-recall policy's EXPAND node selection. Any requested id outside the current frontier refuses the whole selection with `invalid_policy_output` and the sorted, deduplicated foreign ids; an oversized request truncates to the first `maxExpandPerStep` ids after duplicate collapse. Pure helper only — stepper wiring is a later slice of #2332. Part of #2332.
