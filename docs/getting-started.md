# Getting started

The complete install and first-run guide. Pick an install path, drop in a minimal
config, and verify that memory is flowing. If you only want the fastest happy path,
read the [Quickstart](guides/quickstart.md) first and come back here for the details.

Remnic runs two ways: **standalone**, where a local daemon serves every MCP-capable
tool, and as a **native OpenClaw plugin**, where OpenClaw hosts Remnic in-process.
Most tools use the standalone path; OpenClaw gets the deepest integration.

## Prerequisites

- **Node.js 22.12 or newer** ([nodejs.org](https://nodejs.org/)).
- **An OpenAI API key** for memory extraction. Retrieval-only mode works without one —
  you just won't get new memories extracted from conversations.
- **QMD (optional, recommended)** for the highest-quality search. Remnic falls back to
  embedding search and recency-ordered reads without it. See [Set up QMD](#set-up-qmd-optional-recommended).

## Install

### Option A: Standalone (npm)

The universal path. Works with Claude Code, Codex CLI, Cursor, and any other MCP
client through the local daemon.

```bash
npm install -g @remnic/cli
```

This installs the `remnic` command and the bundled `@remnic/server` the daemon runs.
A legacy `engram` binary is installed alongside as a forwarder during the v1.x rename
window.

Create the daemon's config, put your secrets in it, then install the background
service:

```bash
mkdir -p ~/.config/remnic
remnic init                                  # scaffold a config to copy from
cp remnic.config.json ~/.config/remnic/config.json
# Edit ~/.config/remnic/config.json and replace the ${OPENAI_API_KEY} and
# ${REMNIC_AUTH_TOKEN} placeholders with real values (e.g. a fresh
# `openssl rand -hex 32` for the token).
remnic daemon install                        # write service file, enable, start
remnic status                                # confirm it is running
```

`remnic init` writes a starter `remnic.config.json` in the current directory with
`${OPENAI_API_KEY}` and `${REMNIC_AUTH_TOKEN}` placeholders. **The managed service
does not inherit your shell environment** — launchd/systemd only pass `PATH` and
`REMNIC_CONFIG_PATH` to the daemon, and placeholders are not expanded — so put the
real values in the config file (or add them to the service environment yourself).
Shell `export`s work only for a foreground `remnic daemon start` in the same
session. The managed daemon looks for config at `~/.config/remnic/config.json`
(it runs outside your shell's working directory), so copy it there — or point the
service at any path with `REMNIC_CONFIG_PATH`. See [Configure](#configure) for the
file shape.

### Option B: OpenClaw plugin

If you run the [OpenClaw](https://github.com/openclaw/openclaw) gateway, install
Remnic as its memory plugin:

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw   # 1. install the plugin package
remnic openclaw install                                    # 2. wire the memory slot
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway    # 3. restart the gateway (macOS)
remnic doctor                                              # 4. verify every check passes
```

`remnic openclaw install` sets both `plugins.entries."openclaw-remnic"` and
`plugins.slots.memory` in `~/.openclaw/openclaw.json` (or `$OPENCLAW_CONFIG_PATH`) —
it does not download the plugin package itself, so run the `openclaw plugins install`
step first. Config changes only take effect after a full gateway restart (on Linux,
restart your gateway service, e.g. `systemctl restart openclaw-gateway`). Use
`--dry-run` to preview the config diff, or `--yes` to skip prompts.

Migrating from the old `@joshuaswarren/openclaw-engram` plugin? Run
`remnic openclaw migrate-engram`, which backs up the legacy extension before switching
you to `@remnic/plugin-openclaw`. To pull a newer published package and re-apply the
config, run `remnic openclaw upgrade`.

### Option C: From source

For contributors and adapter authors. Remnic is a pnpm monorepo.

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic
pnpm install && pnpm run build
cd packages/remnic-cli && npm link          # put `remnic` on your PATH
cd ../..
remnic init
remnic daemon start                          # manual foreground-style start
remnic status
remnic query "hello" --explain               # test recall with a tier breakdown
```

Run `npm link` from `packages/remnic-cli/`, not the repo root — the root package only
exposes the `engram-access` bin. You can also invoke the CLI directly without linking:
`npx tsx packages/remnic-cli/src/index.ts <command>`.

## Configure

Remnic's two run modes use two different config shapes. Both accept the same underlying
plugin settings.

### Standalone: `remnic.config.json`

A top-level file with `remnic` (plugin settings) and `server` (bind + auth) blocks.
This is what `remnic init` scaffolds:

```jsonc
{
  "remnic": {
    "openaiApiKey": "${OPENAI_API_KEY}",
    "memoryDir": "~/.remnic/memory",
    "memoryOsPreset": "balanced",
    "recallBudgetChars": 64000
  },
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "authToken": "${REMNIC_AUTH_TOKEN}"
  }
}
```

Discovery order: `--config <path>` → `REMNIC_CONFIG_PATH` (or `ENGRAM_CONFIG_PATH`) →
`./remnic.config.json` → `./engram.config.json` → `~/.config/remnic/config.json` →
`~/.config/engram/config.json`. The managed daemon defaults to
`~/.config/remnic/config.json`.

### OpenClaw: `openclaw.json`

Plugin settings live inline in the gateway config under
`plugins.entries."openclaw-remnic".config` (installs upgraded from the old plugin id
keep working under the legacy `openclaw-engram` fallback):

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "openaiApiKey": "${OPENAI_API_KEY}",
          "recallBudgetChars": 64000
        }
      }
    },
    "slots": {
      "memory": "openclaw-remnic"
    }
  }
}
```

Both `entries."openclaw-remnic"` and `slots.memory = "openclaw-remnic"` are required —
OpenClaw only loads the plugin bound to the `memory` slot. Config changes need a full
gateway restart (`SIGUSR1` hot reload does not re-fire `gateway_start`):

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

Override the config path with `OPENCLAW_ENGRAM_CONFIG_PATH` (falling back to
`OPENCLAW_CONFIG_PATH`) for service environments.

### Tune `recallBudgetChars`

`recallBudgetChars` caps how much memory context is injected into each prompt. The
default (8,000 chars) is small — your profile and shared context alone can exhaust it,
leaving no room for actual memories. Set it to **64,000** for large-context models
(Claude, GPT-5) or **32,000** for smaller ones. This is the single highest-impact
setting for recall quality. See
[Recall budget tuning](config-reference.md#recall-budget-tuning).

Everything else has sensible defaults. For a curated starting point, set
`memoryOsPreset` to `conservative`, `balanced`, `research-max`, or `local-llm-heavy`.

## Set up QMD (optional, recommended)

[QMD](https://github.com/tobi/qmd) gives Remnic hybrid BM25 + vector + reranking
search — the highest-quality backend. Remnic supports QMD **2.5.3** and detects the
installed version at runtime, enabling newer capabilities only when the binary has them.

```bash
npm install -g @tobilu/qmd@2.5.3
# or: bun install -g @tobilu/qmd@2.5.3
qmd --version                                 # confirm 2.5.3
```

Register your memory directory in `~/.config/qmd/index.yml`. **The `path` must match
your configured `memoryDir`** — for a standalone install using the config shown above:

```yaml
openclaw-engram:
  path: ~/.remnic/memory
  extensions: [.md]
```

For an OpenClaw plugin install, point it at the plugin's memory directory instead:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

The `openclaw-engram` collection name is a stable compatibility identifier — keep it as
is in both modes. Then index and embed:

```bash
qmd update && qmd embed
```

Enable it in your Remnic config:

```jsonc
{
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram"
}
```

For version gates, the upgrade procedure, alternative backends (Orama, LanceDB,
Meilisearch, remote, noop), and CPU-latency tuning, see
[Search backends](search-backends.md).

## Verify it works

**Standalone.** Confirm the daemon is healthy and recall responds:

```bash
remnic status
remnic doctor
remnic query "your query" --explain
```

**OpenClaw.** Start a conversation, then after a few turns check the setup and
extracted memories:

```bash
openclaw engram doctor --json
openclaw engram inventory --json
ls ~/.openclaw/workspace/memory/local/facts/   # extracted facts land here
openclaw engram search "your query"
```

## Troubleshooting: hooks aren't firing (OpenClaw)

**Symptom:** Remnic looks installed, but no memories are created and the gateway log
shows no `[engram]`/`[remnic]` lines after conversations.

**Cause:** OpenClaw gates memory plugins on `plugins.slots.memory`. If that slot does
not name the plugin id, OpenClaw never calls `register(api)` — no hooks fire, nothing is
stored or recalled.

**Fix:** run the installer, which sets the slot for you, then restart the gateway:

```bash
remnic openclaw install
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

**Verify the hooks fired.** After restart, look for the activation line in the gateway
log (`~/.openclaw/logs/gateway.log`), whose prefix stays `[engram]` during the v1.x
window:

```bash
grep "gateway_start fired" ~/.openclaw/logs/gateway.log
```

If it is absent, `remnic doctor` reports which check failed — config file validity,
`plugins.entries`, the plugin entry, `plugins.slots.memory`, and the memory directory —
each with a remediation hint. To wire it by hand, ensure both
`entries."openclaw-remnic"` and `slots.memory = "openclaw-remnic"` exist; the full
design note is in
[Plugin id and memory namespaces](integration/plugin-id-and-memory-namespaces.md).

## Next steps

- [Connect your tools](guides/quickstart.md#step-3-connect-your-tool) — per-platform connectors
- [Search backends](search-backends.md) — choose, tune, and upgrade your search engine
- [Config reference](config-reference.md) — every setting with defaults and presets
- [Procedural memory](procedural-memory.md) — how-to/runbook memories, default-on; set `procedural.enabled` to `false` to opt out
- [Operations](operations.md) — backups, exports, summaries
- [Architecture overview](architecture/overview.md) — how it all fits together
