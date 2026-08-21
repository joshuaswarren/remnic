---
"@remnic/core": patch
---

Add `decideMergeOnWrite`, a pure create/update/skip decision over merge candidates. Best candidate by similarity desc, then `updatedAt` desc, then id asc (total order). At or above `duplicateThreshold` skips as duplicate; at or above `updateThreshold` updates the best id; otherwise creates. Invalid thresholds throw `RangeError`; malformed candidates are ignored. Part of #2330.
