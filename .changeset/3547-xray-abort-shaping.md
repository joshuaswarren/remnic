---
"@remnic/core": patch
---

Recall X-ray now honors cancellation during post-capture shaping, not only before it. After each awaited shaping step (the tag pre-read, the raw-excerpt fetch and the memory pre-load), the request's abort signal is checked again, so a caller that disconnects mid-shaping gets an `AbortError` instead of a finished X-ray. Refs #3547.

Stability: stable
