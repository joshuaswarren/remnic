---
"@remnic/core": patch
---

Add an extraction seam for span mode. Disabled or `0` returns the whole text. Enabled slices via `parseSpanOffsets`. `extraction.ts` is not wired yet. Part of #2333.
