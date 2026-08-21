---
"@remnic/core": patch
---

Add pure span-mode token-cost estimators: `estimateGeneratedTokens`, `estimateOffsetTokens`, and `spanModeSavesTokens`. Phase A helper for the bench that compares offset prediction against generating the memory value. Extraction wiring is unchanged. Part of #2333.
