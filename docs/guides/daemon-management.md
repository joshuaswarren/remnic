# Daemon Management

The Remnic daemon runs as a background service that starts automatically on boot. Older docs and compatibility surfaces may still refer to it as EMO (Engram Memory Orchestrator).

## Installation

```bash
remnic daemon install
```

This:
1. Detects your platform (macOS or Linux)
2. Writes the appropriate service file
3. Enables auto-start on boot
4. Starts the daemon immediately

### macOS (launchd)

Service file: `~/Library/LaunchAgents/ai.remnic.daemon.plist`

```bash
# Manual control
launchctl kickstart -k gui/$(id -u)/ai.remnic.daemon    # restart
launchctl kill SIGTERM gui/$(id -u)/ai.remnic.daemon    # stop
```

### Linux (systemd)

Service file: `~/.config/systemd/user/remnic.service`

```bash
# Manual control
systemctl --user restart remnic
systemctl --user stop remnic
systemctl --user status remnic
```

## CLI Commands

```bash
remnic daemon install     # write service file + enable + start
remnic daemon uninstall   # disable + remove service file
remnic daemon start       # start now (without installing service)
remnic daemon stop        # stop now
remnic daemon restart     # restart
remnic daemon status      # running state + pid, port, service, memory extensions
```

## Configuration

### Config File

`~/.config/remnic/config.json` (or `REMNIC_CONFIG_PATH`; `ENGRAM_CONFIG_PATH` still works during v1.x):

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "maxBodyBytes": 10485760
  },
  "remnic": {
    "memoryDir": "~/.remnic/memory/",
    "openaiApiKey": "${OPENAI_API_KEY}",
    "searchBackend": "qmd",
    "recallBudgetChars": 64000
  }
}
```

Optional `server` keys: `writeRateLimitMaxRequests` (default `30`) and
`writeRateLimitWindowMs` (default `60000`) tune the write rate limit that
returns `429 write_rate_limited` on write routes (issue #1937). Both must be
positive integers — invalid values abort startup with a precise message,
matching the other `server.*` fields.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REMNIC_CONFIG_PATH` | `~/.config/remnic/config.json` | Config file path (`ENGRAM_CONFIG_PATH` also supported in v1.x) |
| `REMNIC_MEMORY_DIR` | `~/.remnic/memory/` | Memory store directory (`ENGRAM_MEMORY_DIR` also supported in v1.x) |
| `REMNIC_HOST` | `127.0.0.1` | Bind address (`ENGRAM_HOST` also supported) |
| `REMNIC_PORT` | `4318` | Bind port (`ENGRAM_PORT` also supported) |
| `OPENAI_API_KEY` | — | Required for LLM extraction |

## Logs

```bash
# View daemon logs
tail -f ~/.remnic/logs/daemon.log

# View hook-specific logs
tail -f ~/.remnic/logs/engram-session-recall.log
tail -f ~/.remnic/logs/engram-post-tool-observe.log
```

## Health Check

```bash
# CLI check
remnic daemon status

# HTTP check
curl http://localhost:4318/engram/v1/health

# Full diagnostics
remnic doctor
```

## Port Conflicts

If another process is using `:4318`:

```bash
# Find what's using the port
lsof -i :4318

# Use a different port
remnic daemon stop
# Edit ~/.config/remnic/config.json → "port": 4320
remnic daemon start
```

Then update your plugin configs to use the new port.

## Security

- Remnic binds to `127.0.0.1` by default (localhost only)
- To expose it on the network, set `"host": "0.0.0.0"` — but ensure token auth is configured
- Tokens are stored in `~/.remnic/tokens.json`; `~/.engram/tokens.json` is still read as a migration fallback during v1.x
- See [auth-model.md](../architecture/auth-model.md) for token management

## Uninstall

```bash
remnic daemon uninstall
```

This stops the daemon and removes the service file. Memory files at `~/.remnic/memory/` are preserved.
