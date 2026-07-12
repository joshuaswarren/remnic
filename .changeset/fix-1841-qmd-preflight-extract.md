---
"@remnic/core": patch
---

refactor(qmd): extract version-check/probe-preflight helpers to qmd-preflight.ts

Move the QMD version-check and probe-classification pure helpers
(`QMD_PROBE_RETRY_BACKOFF_MS`, `QmdProbeFailureKind`, `classifyProbeFailure`,
the version parse/compare/capability functions, and the probe/version consts)
from qmd.ts into a new qmd-preflight.ts module. qmd.ts re-imports and
re-exports them so existing imports from "./qmd.js" keep resolving. No
behavioral change; reduces qmd.ts from 3109 to 2983 LOC, clearing the
oversizedFileCount structural ratchet raised by the round-1 #1841 probe fix.
