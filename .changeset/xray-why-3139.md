---
"@remnic/cli": patch
---

The `xray` and `why` commands still installed the plain logger in local mode, so orchestrator init lines landed on stdout and broke JSON output under `--format json`. They now use the same stderr logger as `query` when the format is json. Part of #3139.

Stability: stable
