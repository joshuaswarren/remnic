---
"@remnic/core": patch
---

`EngramAccessHttpServer.stop()` no longer waits indefinitely for in-flight requests. It lets them finish for `stopGraceMs` (default 10000 ms), then cuts the remaining connections, which also aborts those requests' signals. Before, one running recall or observe held `server.close()` open, and a remnic restart on jarvis-ml sat in the listener-closure phase for the full 700 s systemd stop timeout (11.7 min) before SIGKILL.

Stability: stable
