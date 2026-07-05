---
"@remnic/plugin-codex": patch
---

Add PreCompact hook that flushes the in-flight observe buffer to `/engram/v1/lcm/compaction/flush` before Codex compacts, closing the Codex parity gap with `@remnic/plugin-pi`'s `session_before_compact` handler (issue #1571). The hook is fail-open: a flush failure never blocks compaction. Also add `REMNIC_DAEMON_URL` (full base URL, plain or TLS) so a Codex host can talk to a shared central Remnic daemon over Tailscale/LAN/VPN — the same remote/central transport `@remnic/plugin-pi` supports. The legacy `REMNIC_HOST`/`REMNIC_PORT` pair remains a backward-compat fallback.
