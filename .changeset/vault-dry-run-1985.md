---
"@remnic/core": patch
---

Add internal `planVaultDryRun` to predict per-note vault publish outcomes (updated/unchanged/skipped) from already-read text without touching the filesystem. CLI wiring is a later slice.
Part of #1985.
