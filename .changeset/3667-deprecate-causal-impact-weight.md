---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
Stability: stable
---

`cmcLifecycleCausalImpactWeight` is deprecated. It never had an effect: since it was added, nothing produced a causal impact signal for lifecycle scoring and nothing read the weight. Configs that set it still load, and Remnic now logs a one-line deprecation warning when it is set. The always-zero causal term and `LifecycleSignals.causalImpactScore` are removed from lifecycle heat scoring, so scores do not change. Closes #3667.
