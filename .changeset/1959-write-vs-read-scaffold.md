---
"@remnic/bench": minor
"@remnic/cli": patch
---

H2 write-vs-read scaffolding (issue #1959). Frozen arm fixtures and `remnic bench ablate write-vs-read` list the arms, the allow-list, and the decision rule, then exit. Warm, pilot, and main phases are refused and run nothing. `WRITE_VS_READ_RUNS_ENABLED` stays false. Production defaults are unchanged.

Stability: stable
