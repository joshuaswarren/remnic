---
"@remnic/core": minor
---

Add a gated unified memory controller with shadow-to-active promotion (#2348). One host-free coordinator compares the `persistent_memory`, `recall`, `active_context`, and `no_op` families through the current action, recall, and context paths, with all adapters, executors, report reader, recorder, telemetry, and clock injected. `off` makes no choice and no calls; `shadow` records choices without dispatching; `active` additionally gates on a current passing #2345 report (hash-, version-, and config-verified), passing paired-seed #2346 evidence, prior shadow history, and receipt health — any failure demotes to shadow. The first active scope applies reversible actions only; `discard` and destructive changes stay review-only.
