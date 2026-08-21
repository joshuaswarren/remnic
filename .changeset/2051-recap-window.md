---
"@remnic/core": patch
---

Add `clipCardsToRecapWindow` to the timeline layer: a pure, deterministic clip helper with half-open `[windowStartMs, windowEndMs)` semantics shared by recap renderers (issue #2051).
