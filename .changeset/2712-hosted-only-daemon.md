---
"@remnic/cli": patch
---

Hosted-only mode for the daemon lifecycle (issue #2712): when `REMNIC_DAEMON_URL` (legacy `ENGRAM_DAEMON_URL`) or config `server.url` resolves to a non-loopback origin, `remnic daemon start|install|restart` refuse loudly — naming the remote origin, pointing health checks at `remnic status`, and explaining how to return to local mode — instead of spawning a local remnic-server next to the hosted one. `remnic daemon status` reports the hosted-only mode and probes the remote origin rather than advertising a leftover local PID; `daemon stop|uninstall` stay available as the cleanup path. Loopback origins (`localhost`, `127.0.0.1`, `::1`) and unset URLs keep the previous local behavior. Reuses the issue #2448 remote-URL resolver; no second resolver exists.
