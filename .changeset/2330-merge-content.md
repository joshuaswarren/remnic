---
"@remnic/core": patch
---

Add a merged-content acceptance check for merge-on-write. Blank or runaway judge-merged bodies (`length > 4 * (incoming + target)`) are refused with the computed limit so the write path can fall back to create; accepted content is returned unchanged. Internal helper; write-path wiring is a later slice. Part of #2330.
