---
"@remnic/core": patch
Stability: stable
---

Run the post-ready QMD corpus update for every runtime, not only remnic-server (#3525).

#3518 moved the update out of the awaited `deferredReady` path and left the server retry loop as its sole driver, so runtimes that drive `Orchestrator` without `@remnic/server` — the OpenClaw service, `remnic` CLI invocations, and the bench adapter — served the startup index as last written until an unrelated sync reconciled it. `deferredInitialize` now schedules `startupSearchSync` once the ready mark settles (not awaited, so readiness semantics stay unchanged) and records the result in the same `deferredSyncSucceeded` flag the retry loop reads. `startupSearchSync` itself joins a concurrent in-flight call from the same startup epoch, so the post-ready fire and the server retry cannot spawn a second `qmd update` over the same index.
