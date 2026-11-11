---
"@remnic/cli": patch
---

When a CLI command prints machine-readable JSON under `--json` (or equivalent format=json), route logger output to stderr so progress lines no longer corrupt the JSON body on stdout. Part of #3139.

Stability: stable
