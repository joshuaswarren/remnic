---
"@remnic/core": patch
---

Removes a stale source note in `access-recall-surface.ts` that said `access-service.ts` still carried duplicate QMD path helpers. Those copies were removed earlier, so no behavior changes. Refs #3545.

Stability: stable
