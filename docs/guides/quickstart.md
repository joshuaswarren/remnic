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

Create `~/.config/remnic/config.json` before installing the service.
See [Daemon configuration](./daemon-management.md#configuration) for the file shape.
Both managed service templates select this path explicitly; `remnic init` writes
`./remnic.config.json` instead.

The daemon is the local memory server every tool connects to. Install its user
service to start it automatically with your service manager:

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
put your OpenAI API key — or local-LLM settings — in `~/.config/remnic/config.json`,
then run `remnic daemon restart` (the server reads config only at startup). The
managed service reads secrets from that file, not from your shell environment. See
[Getting started](../getting-started.md#configure) for the config shape.

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

Try it in Claude Code (with the [Claude Code plugin](../plugins/claude-code.md) loaded):

```
> /remnic-remember I prefer functional programming over OOP
> /remnic-recall programming preferences
```

Now open another tool — say Codex CLI — and it already knows your preference.

Once memories are flowing, get a focused summary of what changed recently:

```bash
remnic briefing --since 3d
```

See [Daily briefing](./daily-briefing.md) for scopes, JSON output, and saved reports.

## Already using OpenClaw?

OpenClaw has the deepest native integration. Install the plugin package, then wire
the memory slot — your existing memories are untouched:

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw
remnic openclaw install
```

`remnic openclaw install` writes the plugin entry plus `plugins.slots.memory` in
`openclaw.json`; it does not download the package, so run the `openclaw plugins
install` step first. Restart the gateway afterward. Full walkthrough and config live
in [Getting started](../getting-started.md).

## x86 Linux, no Mac

Measured 2026-11-03 on an x86_64 Linux host with no Apple silicon and no GPU in the
inference path. Everything below ran as written; anything not exercised says **Not
measured**.

Host: `jarvis` — ASRock Rack ROMED8-2T, AMD EPYC 7443P (48 hardware threads), 251 GiB
RAM, Proxmox VE (kernel `7.0.14-25-pve`), CPU-only inference. Model: `qwen2.5:0.5b-instruct`
(380 MB on disk) served by Ollama 0.40.14, user-local, no root install:

```bash
mkdir -p ~/ollama-bin ~/ollama-models
curl -fsSL -o /tmp/ollama.tar.zst \
  https://github.com/ollama/ollama/releases/download/v0.40.14/ollama-linux-amd64.tar.zst
tar --zstd -xf /tmp/ollama.tar.zst -C ~/ollama-bin
OLLAMA_MODELS=$HOME/ollama-models ~/ollama-bin/bin/ollama serve &   # listens on 127.0.0.1:11434
until curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1; do sleep 1; done
OLLAMA_MODELS=$HOME/ollama-models ~/ollama-bin/bin/ollama pull qwen2.5:0.5b-instruct
```

Remnic needs Node.js 22.12+. Where the system Node is mise-managed, install the CLI
into a project directory instead of globally (same package as `npm install -g`):

```bash
mkdir -p ~/remnic-cli && cd ~/remnic-cli && npm install @remnic/cli
alias remnic="$PWD/node_modules/.bin/remnic"
```

Point Remnic's local-LLM route at Ollama's OpenAI-compatible endpoint —
`~/.config/remnic/config.json`:

```json
{
  "remnic": {
    "openaiApiKey": false,
    "modelSource": "plugin",
    "localLlmEnabled": true,
    "localLlmUrl": "http://127.0.0.1:11434/v1",
    "localLlmModel": "qwen2.5:0.5b-instruct",
    "memoryDir": "~/remnic-x86-memory",
    "memoryOsPreset": "balanced",
    "recallBudgetChars": 64000
  }
}
```

`remnic daemon install` (installs a systemd **user** service, no root) then starts the
daemon; it logged `Local LLM model detected: qwen2.5:0.5b-instruct` at startup, which is
the check that the local route is wired. `remnic doctor` shows
`OPENAI_API_KEY: disabled by config (local LLM enabled)`.

Measured on this host (CPU-only, small model — expect modest quality):

- Storing a memory through the daemon's MCP endpoint (`remnic_memory_store`): **40 ms**.
- One chat completion, 48 prompt + 40 completion tokens: **2.5 s wall** (~17 completion
  tokens/s on CPU).
- Recalling it: `remnic query "Which fleet host runs the local model?"` returned the
  stored memory; 4.1 s wall for the CLI, of which retrieval internals were **83 ms**
  (the rest is Node startup and daemon round-trips).
- `remnic curate` and `remnic sync run` index files in ~1 s without a model call.

**Not measured** on this host: model-backed extraction (no activity source — wearables,
transcripts, or a connected agent session — was connected, so the extraction queue never
had work), GPU inference (the host's RTX 3090 is not exposed to this path), embeddings,
and the connector quick-start for any specific tool.

## Next steps

- [Getting started](../getting-started.md) — every install option, config, and first-run detail
- [Daemon management](./daemon-management.md) — auto-start, logs, ports
- [Plugin guides](../plugins/README.md) — per-platform setup
- [Architecture overview](../architecture/overview.md) — how it works under the hood
