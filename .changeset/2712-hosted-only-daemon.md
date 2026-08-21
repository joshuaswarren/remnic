---
"@remnic/cli": patch
---

Hosted-only mode for the daemon lifecycle (issue #2712): when `REMNIC_DAEMON_URL` (legacy `ENGRAM_DAEMON_URL`) or config `server.url` resolves to a non-loopback origin, `remnic daemon start|install|restart` refuse loudly — naming the remote origin, pointing health checks at `remnic status`, and explaining how to return to local mode — instead of spawning a local remnic-server next to the hosted one. `remnic daemon status` reports the hosted-only mode and probes the remote origin rather than advertising a leftover local PID; `daemon stop|uninstall` stay available as the cleanup path. Loopback origins keep the previous local behavior — the whole `127.0.0.0/8` range, `localhost`, `::1`, and the IPv4-mapped loopback range `::ffff:127.0.0.0/104` — as do unset URLs; a host that does not parse confidently as loopback is treated as remote, the safe direction. Reuses the issue #2448 remote-URL resolver; no second resolver exists.
