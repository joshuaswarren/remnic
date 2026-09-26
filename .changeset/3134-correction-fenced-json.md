---
"@remnic/core": patch
---

Stability: stable

Fix the correction planner's LLM response parser: models that wrap their JSON classification in a markdown fence (with or without a language tag, or with surrounding prose) no longer degrade every correction plan to the deterministic fallback (`actions: []`, confidence 0). `parseClassifyResponse` now walks the shared JSON-candidate chain before falling back, and the `correction-classify` operation joins the thinking-suppressed local-LLM operations. Genuinely non-JSON responses still return the byte-identical deterministic fallback. References #3134.
