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

Bridge mode is the plugin config key `bridgeMode`, and the
`REMNIC_BRIDGE_MODE` environment variable (legacy `ENGRAM_BRIDGE_MODE` also
works) overrides it. `resolveBridgeMode()` in
`packages/plugin-openclaw/src/bridge.ts` owns the precedence:

| Value | Behavior |
|---|---|
| `embedded` (default) | Boot the in-process orchestrator. |
| `delegate` | Skip the orchestrator. Back the memory loop, memory-slot capability, and support passport gateway model route with the daemon. A failed daemon preflight logs an error and falls back to `embedded`. |
| `auto` | Delegate **only** when a healthy same-host daemon reports the same `memoryDir` this plugin is configured for; stay embedded otherwise, with the reason logged. |

`auto` exists so one shared fleet config can delegate on the hosts that run a
daemon and stay embedded everywhere else. It is not the default: silently
flipping a co-located deployment to delegate on a restart would change memory
behavior without anyone asking for it.

All three gates must pass before `auto` delegates:

1. **Same host.** The daemon endpoint must be loopback. A matching absolute
   `memoryDir` string proves nothing across machines, and delegate mode's
   local-corpus reads only hold on one host. A wildcard bind (`0.0.0.0`, `::`)
   names every interface on *this* host, so it counts as same-host and is
   dialed through the matching loopback. Explicit `delegate` may still target a
   remote daemon; `auto` may not, and a remote daemon never enables the
   file-backed surfaces (reads, public artifacts) even in explicit mode.
2. **Liveness.** A daemon PID file, an installed launchd/systemd unit (user or
   system), or a loopback endpoint is only a hint — PIDs go stale and get
   reused — so the configured endpoint must actually answer.
3. **Corpus identity.** The daemon must report either the configured
   `memoryDir` itself or one namespace directory beneath it
   (`<root>/namespaces/<ns>`) — health returns the namespace-resolved storage
   directory. Both sides are tilde-expanded and canonicalized before the shape
   is judged, so an aliased ancestor (`/var` vs `/private/var`) matches while a
   component symlinking out of the corpus does not. A root that is itself a
   symlink is rejected: it is a mutable trust anchor. An unknown `memoryDir`
   (older daemon, or a token without health access) counts as a mismatch and
   stays embedded.

In delegate mode the daemon endpoint comes from the Remnic config's
`server.host`/`server.port` or the corresponding env vars (default
`127.0.0.1:4318`).

## Switching modes

```bash
# Delegate on this host only:
#   openclaw.json → plugins.entries["openclaw-remnic"].config.bridgeMode = "delegate"
# Or, for a shared fleet config that adapts per host:
#   ... .config.bridgeMode = "auto"

remnic daemon install
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Pin a single gateway without touching config:
#   REMNIC_BRIDGE_MODE=delegate

# Back to embedded: set bridgeMode to "embedded" (or pin the env var), then
# restart the gateway. Under "auto", stopping the daemon is enough.
remnic daemon stop
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## Running both on one host

An embedded gateway beside a daemon on the same `memoryDir` means two
orchestrators over one corpus: duplicate maintenance crons, two QMD writers,
doubled extraction load, and SQLite contention. That is the deployment
`delegate` and `auto` exist to fix — prefer one of them over running both.
