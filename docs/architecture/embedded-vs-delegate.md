# Embedded vs Delegate Mode

The OpenClaw Remnic bridge plugin supports two operational modes.

## Embedded Mode (Default)

OEO creates the Orchestrator in-process within the OpenClaw gateway. It also starts an HTTP server on `:4318` so external agents can connect.

```
OpenClaw Gateway (single process)
├── OEO plugin
│   ├── Orchestrator (in-process)
│   └── HTTP server (:4318) ← external agents connect here
│
├── ← Claude Code (hooks → :4318)
├── ← Codex CLI (hooks → :4318)
└── ← Hermes (MemoryProvider → :4318)
```

### When to use

- You're an existing OpenClaw user upgrading to the new Remnic
- You want a single process managing everything
- You don't need the EMO daemon running independently

### Behavior

- Memory stored at `~/.openclaw/workspace/memory/local/`
- OpenClaw features (Ops Dashboard, Conductor, cron jobs) work unchanged
- External agents share the same memory via `:4318`
- If OpenClaw stops, `:4318` stops — external agents lose access until restart

## Delegate Mode

OEO does not create an Orchestrator. Instead, it proxies all operations to a running EMO daemon via HTTP.

```
EMO daemon (:4318)          ← standalone process
├── Orchestrator
├── HTTP + MCP server
│
├── ← OpenClaw (OEO → HTTP delegate)
├── ← Claude Code (hooks → :4318)
├── ← Codex CLI (hooks → :4318)
└── ← Hermes (MemoryProvider → :4318)
```

### When to use

- You run multiple AI tools and want memory to survive any single tool restarting
- You want EMO to start on boot and always be available
- You don't always run OpenClaw

### Behavior

- EMO daemon runs independently via launchd/systemd
- Memory store path configured in EMO's config (defaults to `~/.remnic/memory/`)
- OpenClaw features still work (OEO proxies memory reads through EMO's HTTP API)
- If OpenClaw stops, EMO keeps running — other agents unaffected

## Configuration

Bridge mode is not a config-file key. The OpenClaw plugin resolves it at gateway
startup (`detectBridgeMode()` in `packages/plugin-openclaw/src/bridge.ts`):

1. If the `REMNIC_BRIDGE_MODE` environment variable is set (`embedded` or
   `delegate`; legacy `ENGRAM_BRIDGE_MODE` also works), that wins.
2. Otherwise, if a daemon is already listening on the configured port, the
   bridge auto-detects **delegate** mode.
3. Otherwise it runs **embedded**.

In delegate mode the daemon endpoint comes from `REMNIC_HOST` (default
`127.0.0.1`) and the daemon port env (legacy `ENGRAM_*` equivalents accepted).

## Switching modes

```bash
# Switch to delegate mode: start a daemon, then restart the gateway —
# auto-detection picks delegate when the daemon is reachable.
remnic daemon install
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Or pin the mode explicitly in the gateway's environment:
#   REMNIC_BRIDGE_MODE=delegate

# Switch back to embedded: stop the daemon (or pin REMNIC_BRIDGE_MODE=embedded),
# then restart the gateway.
remnic daemon stop
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## Port Conflict Prevention

If OEO is in embedded mode and an EMO daemon is already running on `:4318`:
1. OEO detects the conflict on startup
2. OEO automatically switches to delegate mode for this session
3. A warning is logged: "EMO daemon already running on :4318, switching to delegate mode"

This prevents two instances competing for the same port.
