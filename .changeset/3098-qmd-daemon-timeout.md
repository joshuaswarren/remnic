---
"@remnic/core": patch
---

Raise the default `qmdDaemonTimeoutMs` from 8s to 60s so multi-GB QMD indexes can search without looking empty (issue #3098).

Stability: stable
