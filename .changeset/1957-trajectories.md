---
"@remnic/core": minor
---

Add shared-context trajectory publish (issue #1957). `publishTrajectory` gates on `off` / `review` / `auto` (default `review`), rejects unknown modes, and keeps the summary string only. Part of #1957.
