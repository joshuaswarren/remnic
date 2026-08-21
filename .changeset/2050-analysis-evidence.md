---
"@remnic/core": patch
---

Drop timeline analysis claims whose `observationId` is not in the supplied observations. `boundEvidence` keeps claim order and returns no claims when the observation list is empty (issue #2050).
