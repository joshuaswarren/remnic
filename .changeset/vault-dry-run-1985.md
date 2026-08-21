---
"@remnic/core": patch
---

Add `planVaultDryRun` to predict per-note vault publish outcomes (updated/unchanged/skipped) from already-read text without touching the filesystem. The helper is exported from the activity entry point; the CLI/HTTP `--dry-run` wiring is a later slice. Part of #1985.
