---
"@remnic/core": minor
---

Add the bootstrap reconciliation planner for diverged peer daemons (#2150).
`planReconciliation()` takes two corpus censuses (plus an optional cursor from a
prior converged run) and returns what must move in each direction, how each
both-modified path is settled under the chosen conflict policy, and a
per-namespace convergence report. Converged peers plan no work, which is the
idempotency contract reconciliation transport can short-circuit on.
