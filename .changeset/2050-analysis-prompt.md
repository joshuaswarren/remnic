---
"@remnic/core": patch
---

Add a deterministic timeline analysis prompt builder. `buildAnalysisPrompt` sorts observations by id, renders an empty list as `(empty)`, and includes only `id` and `capturedAtUtc`. Part of #2050.
