---
"@remnic/cli": patch
---

Bench dataset discovery now falls back to a legacy `evals/datasets/<benchmark>` copy when the canonical store is missing it: the legacy dataset is used read-only with a once-per-process migration hint (`remnic bench datasets download <benchmark>`), nothing is moved or linked, and the canonical location always wins when both exist. `remnic bench datasets status` reports where each dataset is actually read from.
