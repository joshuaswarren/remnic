---
"@remnic/plugin-openclaw": minor
"@remnic/core": minor
---

Close out OpenClaw delegate bridge mode (#2120).

- `bridgeMode: "auto"` finally wires the daemon detector that shipped dead:
  auto delegates only when a healthy same-host daemon reports the SAME
  `memoryDir`, and stays embedded otherwise with the reason logged. Detection
  reads per-user AND system-level units, their `systemctl edit` drop-ins, and
  the endpoint each one pins through `Environment=`, `ExecStart=` flags, or
  `WorkingDirectory`-relative config paths.
- Delegate mode registers a daemon-backed memory-slot capability — prompt
  builder, memory runtime (search/read/status/probes), flush plan, and public
  artifacts — so a delegate gateway no longer hands the host an empty memory
  slot. It deliberately exposes no `sync`: reindexing stays the daemon's job.
- New `POST /engram|remnic/v1/memories/search` exposes the existing
  `memory_search` boundary operation over HTTP for every client, not just MCP.
  `GET /engram/v1/capabilities` advertises it as `memoriesSearch`.

**Additive plugin exports.** `detectDaemonBridgeMode({ memoryDir })` answers
only "is a healthy same-corpus daemon here?", and `resolveBridgeMode()` owns
explicit `embedded`/`delegate`/`auto` precedence. Both are new exports.
`detectBridgeMode()` is retained as a deprecated wrapper over the same
resolution, so existing importers keep working unchanged — prefer the two
named above in new code.
