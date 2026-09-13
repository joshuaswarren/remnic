---
"@remnic/core": patch
---

Honor the HTTP abort signal on LCM compaction flush so a cancelled batch does not keep compacting after the client retries (issue #3077).

Stability: stable
