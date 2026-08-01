---
"@remnic/plugin-openclaw": major
"@remnic/core": minor
---

Close out OpenClaw delegate bridge mode (#2120).

- `bridgeMode: "auto"` finally wires the daemon detector that shipped dead:
  auto delegates only when a healthy same-host daemon reports the SAME
  `memoryDir`, and stays embedded otherwise with the reason logged. Detection
  now also sees system-level systemd units, not just per-user ones.
- Delegate mode registers a daemon-backed memory-slot capability — prompt
  builder, memory runtime (search/read/status/probes), flush plan, and public
  artifacts — so a delegate gateway no longer hands the host an empty memory
  slot. It deliberately exposes no `sync`: reindexing stays the daemon's job.
- New `POST /engram|remnic/v1/memories/search` exposes the existing
  `memory_search` boundary operation over HTTP for every client, not just MCP.
  `GET /engram/v1/capabilities` advertises it as `memoriesSearch`.

**Breaking (plugin package export):** `detectBridgeMode()` is now
`detectDaemonBridgeMode({ memoryDir })`. It answers only "is a healthy
same-corpus daemon here?" — explicit `embedded`/`delegate`/`auto` precedence
belongs to `resolveBridgeMode()`, which is now exported too. The old name had
no callers.
