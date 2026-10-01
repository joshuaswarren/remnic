---
"@remnic/core": minor
"@remnic/bench": minor
---

H1 outcome-prior synthetic task family, CI snapshot, and pre-main gates (issue #1958). `@remnic/core` exports the existing outcome blend from `@remnic/core/rerank-outcome`. `outcomeBoostEnabled` stays default false and `outcomeBoostWeight` stays default 0. `@remnic/bench` commits the drift-gen task family and a 2-user / 4-epoch snapshot. `runOutcomePriorScaffoldCli` stays synchronous. `remnic bench ablate outcome-prior --gates` calls `runOutcomePriorGatesCli`, checks that snapshot, including per-fact warm counters, and still refuses warm, pilot, and main phases. A malformed arm or decision-rule fixture returns that same structured failure instead of throwing. Any other flag or phase is rejected. No experiment JSONL is written.

Stability: alpha
Flag: outcomeBoostEnabled
