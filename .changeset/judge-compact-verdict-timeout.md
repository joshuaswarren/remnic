---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Stability: beta

The extraction judge asks for a compact `{"verdicts":[{"index","kind"}]}` reply with a small completion budget instead of a verbose 2048-token one, and its per-call timeout is now the new `extractionJudgeTimeoutMs` setting (default 20000 ms) instead of a fixed 1500 ms that no local model could meet. The parser still accepts a bare array, the older verbose shape, and a single verdict object (treated as one verdict at its index). The judge stays off unless `extractionJudgeEnabled` is set.
