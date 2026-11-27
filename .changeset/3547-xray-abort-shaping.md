---
"@remnic/core": patch
Stability: stable
---

`recallXray` post-capture shaping is now abort-wired: a cancel that lands between capture and each shaping step (tag filter, raw-excerpt fetch, result reads, decoration, recall response build) stops the pipeline with an AbortError instead of running to completion for a canceled caller. Refs #3547.
