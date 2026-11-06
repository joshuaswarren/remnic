---
"@remnic/server": patch
---

Attribute native daemon stop stalls: the shutdown path now logs monotonic, non-content per-phase markers — `shutdown-phase-start` before each await, `shutdown-phase-end` with `durationMs` after, `shutdown-phase-failure` on rejection (error detail never printed) — for listener closure, scheduler abort+settle, and orchestrator drain/flush/dispose. Normal request activity emits nothing. Teardown finally semantics are unchanged, so a phase that throws still runs the remaining cleanup; production 700s stop hangs now resolve to the exact await that is stuck.

Stability: stable
