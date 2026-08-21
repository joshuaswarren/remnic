---
"@remnic/core": patch
---

Add `buildAnalysisRunMetadata` in the activity timeline layer: a pure builder for the provider/model/prompt-version/observation-count record that analysis results and telemetry can carry. Each string field must match identifier syntax (letters, digits, and `._:-/` only, no spaces) and stay under 120 characters, all four Unicode line separators are rejected, a non-negative integer count is required, and errors report the received type rather than echoing the value, so the record cannot carry prompt or response content and a mis-passed value cannot reach logs through the failure path. Internal helper only — wiring it into the analysis pipeline is a later slice. Part of #2050.
