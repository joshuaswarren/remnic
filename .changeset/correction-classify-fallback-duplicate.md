---
"@joshuaswarren/openclaw-engram": patch
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
---

Stability: stable

Correction classification no longer waits on the shared local-LLM budget when that endpoint is down. `correction.classifyTimeoutMs` (flat `correctionClassifyTimeoutMs`, default 45000) bounds each attempt, a caller abort or disconnect cancels the in-flight attempt, and a local miss falls through to the same gateway/fallback model extraction uses. `memory_correct_plan` also accepts `duplicateOf` plus one target id and drafts a recoverable supersede of that duplicate without calling a model. The supersede action's `winnerId` records the existing replacement on the loser via `supersededBy` without writing a new memory, rewriting derivation lineage, or hard-deleting the duplicate. A model-selected `winnerId` must be one of the located candidates; `duplicateOf` is the path that names a winner outside that set.
