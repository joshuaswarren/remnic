---
"@remnic/plugin-openclaw": minor
"@remnic/core": minor
---

Delegate bridge mode is now wired (issue #2120): with `bridgeMode: "delegate"` (or `REMNIC_BRIDGE_MODE=delegate`) and a healthy standalone daemon, the OpenClaw plugin skips the embedded orchestrator and backs the memory loop over the daemon's HTTP API — recall injection via /engram/v1/recall, turn capture via /engram/v1/observe, and compaction/reset/session-end flushes via /engram/v1/lcm/compaction/flush. Activation is explicit-only (no auto-detection) so existing co-located deployments keep embedded behavior until the operator opts in; a failed daemon preflight falls back to embedded with a loud error. Tool/CLI registration, heartbeat/dreams surfaces, and public artifacts remain embedded-only in delegate v1 (the daemon exposes those surfaces to HTTP/MCP clients directly). New core config key: `bridgeMode` ("embedded" | "delegate", default "embedded"). The transcript turn helpers moved to @remnic/plugin-openclaw's transcript-turns module, shared by both bridge modes.
