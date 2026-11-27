---
"@remnic/core": patch
Stability: stable
---

Remove `computeCausalImpactScore` from `@remnic/core/causal-behavior`. Nothing in Remnic called it. It also looked up a memory ID in the causal chain index, which is keyed by trajectory ID, so for a real memory it could only return 0. Lifecycle scoring is unchanged: `LifecycleSignals.causalImpactScore` was never filled from this function. Closes #3610.
