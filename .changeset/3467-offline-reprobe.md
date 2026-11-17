---
"@remnic/plugin-pi": patch
---

Stability: stable

An idle session that went offline at startup re-probes until the daemon answers. A failure in that background loop, including the recovery callback, is logged instead of becoming an unhandled rejection.
