---
"@remnic/core": patch
---

Add `buildAnalysisRunMetadata` in the activity timeline layer: a pure builder for the provider/model/prompt-version/observation-count record that analysis results and telemetry can carry. The builder validates the exact strings (no trimming into validity), rejects newlines and values over 200 characters, requires a non-negative integer count, and returns exactly the four documented keys, so a metadata record is structurally incapable of carrying prompt or response content. Internal helper only — wiring it into the analysis pipeline is a later slice. Part of #2050.
