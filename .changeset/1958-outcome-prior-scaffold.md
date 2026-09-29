---
"@remnic/core": minor
"@remnic/bench": minor
---

H1 outcome-prior scaffolding (issue #1958). `outcomeBoostEnabled` defaults to false and `outcomeBoostWeight` defaults to 0, so recall ranking stays unchanged. A weight above 0 blends a clamped text score with the observed success rate. Unobserved facts stay on the text score and are not pulled toward the Memory Worth Beta prior. `@remnic/bench` ships frozen arm fixtures and `remnic bench ablate outcome-prior`, which lists those arms and refuses warm, pilot, and main phases.

Stability: alpha
Flag: outcomeBoostEnabled
