---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Avoid a fragile startup-time named import from `@remnic/core` for the OpenClaw
live-connector cron gate.

Older installed core builds may not export `hasEnabledLiveConnector`, causing
OpenClaw plugin startup to fail before Remnic can degrade gracefully. The
OpenClaw adapter now performs the simple parsed-config check locally, so plugin
startup remains compatible across core patch-version skew.
