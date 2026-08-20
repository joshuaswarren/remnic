---
"@remnic/core": patch
---

Add `findRecurringPatterns`: weekly recurring category/application patterns
reported only when a key appears on at least a configurable number of distinct
days (default 3), so one-off blips are never labeled patterns. Pure gate with
strict input validation and deterministic total ordering. Part of #2052.
