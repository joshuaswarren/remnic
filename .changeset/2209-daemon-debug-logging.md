---
"@remnic/server": patch
---

The standalone daemon now honors `debug: true` from its config file. `initLogger()`
ran before the config was read, so the flag was accepted and silently ignored —
leaving no way to raise log verbosity on the one surface where you need it when
the daemon is misbehaving.
