# Quickstart

Get memory working for your AI agent in about five minutes. Install Remnic once,
connect your tool, and every agent — Claude Code, Codex, Cursor, OpenClaw, and more —
shares the same local, plain-markdown memory store.

## Step 1: Install

Remnic ships as a single npm package and needs Node.js 22.12 or newer.

```bash
npm install -g @remnic/cli
```

This installs the `remnic` command (plus a legacy `engram` alias for the v1.x compatibility window) and pulls in the local server the daemon runs.

## Step 2: Start the daemon

The daemon is the local memory server every tool connects to. Install it once and it
auto-starts on boot:

```bash
remnic daemon install
```

Check it:

```bash
remnic daemon status
```

`status` reports whether the daemon is running (with its pid), the port it listens on
(`4318` by default), whether the system service is installed, and the memory-extension
state. It reads the service definition and port directly, so it works even when the
daemon process is down. For auto-start, logs, and port changes, see
[Daemon management](./daemon-management.md).

To let Remnic *extract* new memories (not just recall), give it a model provider:
put your OpenAI API key — or local-LLM settings — in `~/.config/remnic/config.json`.
The managed service reads secrets from that file, not from your shell environment.
See [Getting started](../getting-started.md#configure) for the config shape.

## Step 3: Connect your tool

Register a connector for each AI tool you use:

```bash
remnic connectors install <id>
```

Built-in connector ids: `claude-code`, `codex-cli`, `cursor`, `cline`,
`github-copilot`, `roo-code`, `windsurf`, `amp`, `pi`, `omp`, `replit`, `weclone`,
`hermes`, and `generic-mcp` for any other MCP client. Run `remnic connectors list` to
see them all.

`remnic connectors install <id>` mints a host-specific auth token and writes the
Remnic-side connector state. Some hosts also need a manual step or two on their own
side, so read the plugin guide before assuming a tool is fully wired up:

- [Claude Code](../plugins/claude-code.md)
- [Codex CLI](../plugins/codex.md)
- [OpenClaw](../plugins/openclaw.md)
- [Hermes](../plugins/hermes.md)
- [Replit](../plugins/replit.md)
- Every platform: [Plugin guides index](../plugins/README.md)

Want to see cross-tool memory before wiring up a real tool? Run the no-key
[coding-agent memory demo](../../examples/coding-agent-memory-demo/) from a source
checkout — it carries scoped project context from one agent-session identity to another
using the real storage and recall paths.

## Step 4: Verify

Run `remnic doctor` for an overall health check, then `remnic connectors doctor <id>`
for each connector you installed (it checks one connector at a time). A green result
means the Remnic side is configured correctly; if a tool still is not recalling
memories, its plugin guide has the host-side checklist.

## Step 5: Use it

Now just use your tools normally. Remnic works in the background:

- **Start a session** → it recalls your preferences and project context
- **Type a prompt** → it injects the relevant memories
- **Edit files** → it observes and learns your patterns
- **Switch tools** → your memory carries over instantly

Try it in Claude Code:

```
> /engram:remember I prefer functional programming over OOP
> /engram:recall programming preferences
```

Slash commands keep the `/engram:*` names during the v1.x compatibility window; the
product and CLI are `remnic`. Now open another tool — say Codex CLI — and it already
knows your preference.

Once memories are flowing, get a focused summary of what changed recently:

```bash
remnic briefing --since 3d
```

See [Daily briefing](./daily-briefing.md) for scopes, JSON output, and saved reports.

## Already using OpenClaw?

OpenClaw has the deepest native integration. One command configures it end to end —
the plugin entry plus the `plugins.slots.memory` slot — without touching your existing
memories:

```bash
remnic openclaw install
```

Restart the gateway afterward. Full walkthrough and config live in
[Getting started](../getting-started.md).

## Next steps

- [Getting started](../getting-started.md) — every install option, config, and first-run detail
- [Daemon management](./daemon-management.md) — auto-start, logs, ports
- [Plugin guides](../plugins/README.md) — per-platform setup
- [Architecture overview](../architecture/overview.md) — how it works under the hood
