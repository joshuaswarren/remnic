---
"@remnic/core": patch
"@remnic/bench": patch
---

Stability: stable

Fix the correction planner's LLM response parser: models that wrap their JSON classification in a markdown fence (with or without a language tag, or with surrounding prose) no longer degrade every correction plan to the deterministic fallback (`actions: []`, confidence 0). Parse verbatim JSON candidates without rewriting embedded code fences, retain valid actions beside malformed siblings, and reject ambiguous competing plans rather than guessing. The `correction-classify` operation also joins the thinking-suppressed local-LLM operations. Genuinely non-JSON responses retain the deterministic fallback. References #3134.

Preserve frozen benchmark evidence when regenerating the H6 fixture tree; compare generator-owned artifacts separately from retained evidence.
