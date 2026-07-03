# Quickstart: Install Remnic in 5 Minutes

Remnic is a universal memory system for AI agents. Install it once, connect your tools, and all your agents share the same memory.

## Step 1: Install Remnic

```bash
npm install -g @remnic/cli
```

## Step 2: Start the Daemon

```bash
remnic daemon install
```

This starts the Remnic daemon (historically called EMO) and configures it to auto-start on boot.

To check the daemon, run `remnic daemon status`. The command prints whether the daemon is currently running (and its pid if so), the port it is listening on, and whether the system service is installed. None of those fields require the daemon to be reachable — the command only inspects the system service definition and the port binding, so it works even when the daemon process is down.

## Step 3: Connect Your Tools

Install the plugin for your AI tool. Each plugin has its own install path — read its README before running anything:

- Claude Code: <https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-claude-code/README.md> (three manual steps; the Remnic-side connector install does not configure Claude Code)
- Codex CLI: <https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-codex/README.md>
- Hermes Agent: <https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-hermes/README.md>
- Replit Agent: <https://github.com/joshuaswarren/remnic/blob/main/packages/connector-replit/README.md>

See [Plugin docs](../plugins/) for the platform-by-platform overview, and the [Connector setup](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) guide for how `remnic connectors` tracks per-host state.

Each `remnic connectors install <host>` command mints a host-specific auth token and writes Remnic-side connector state. Whether it also configures the host itself varies — read the plugin README for the host you picked before assuming anything is wired up.

Want to see cross-tool memory before installing connectors? Run the no-key
[Coding Agent Memory Demo](../../examples/coding-agent-memory-demo/) from a
source checkout. It uses real Remnic storage and recall paths to carry scoped
project context from one coding-agent session identity to another with
retrieval reasons.

## Step 4: Verify

`remnic connectors doctor <id>` requires a connector id — it doctor-checks one connector at a time (see `Usage: remnic connectors doctor <id>` in the CLI). Run it per connector you installed.

The command prints a row per `DoctorCheck` in the format `<check.name>: <check.detail>` (see `cmdConnectors` at `packages/remnic-cli/src/index.ts:8425-8427`), followed by `Connector healthy` or `Connector has issues`. Three sources contribute rows:

- `Config file` (path under `getConnectorsDir()`) and `Config valid` — from `doctorConnector` at `packages/remnic-core/src/connectors/index.ts:2569`. Optionally `MCP server` (if the install persisted an `mcpServerUrl`) and `Memory directory` (if it persisted a `memoryDir`).
- `Publisher: <host>` — from the publisher block at `cmdConnectors:8384-8417`. The block runs only when `PUBLISHERS[targetHostId]` is defined. `@remnic/cli` registers publishers at module load (`packages/remnic-cli/src/index.ts:356-360`) for `codex`, `claude-code`, `hermes`, `pi`, and `omp`. `hostIdForConnector("codex-cli") = "codex"` (per `CONNECTOR_TO_HOST` at `packages/remnic-core/src/memory-extension/index.ts:67-69`); every other connector id maps to itself, so `codex-cli` produces a publisher row for the `codex` host, and `claude-code`, `hermes`, `pi`, `omp` produce publisher rows for their own host ids. `replit` and every other connector id not in the registration table prints NO publisher row.

None of the checks probe whether the host plugin is loaded, the host MCP server is wired up, or the host-side MemoryProvider is active. The publisher row only checks Remnic-side publisher state (publisher's `isHostAvailable()` and whether the host's memory-extension directory exists on disk for publishers that resolve one).

For `codex-cli`, a representative green run after `remnic connectors install codex-cli` (when Codex is installed at `~/.codex` and the install persisted the extension) looks like:

```bash
remnic connectors doctor codex-cli
  ✓ Config file: /home/<you>/.config/engram/.engram-connectors/connectors/codex-cli.json
  ✓ Config valid: OK
  ✓ Publisher: codex: extension at /home/<you>/.codex/memories_extensions/remnic

Connector healthy
```

For `claude-code` and `hermes`, the publishers are intentional all-no-op stubs (`isHostAvailable()` returns `false`, per `claude-code-publisher.ts:31-33` and `hermes-publisher.ts:31-33`), so the publisher row prints `host not installed (skip)` with `ok = !available || extensionExists = true` (the `!available` branch). The verdict is still `Connector healthy`:

```bash
remnic connectors doctor claude-code
  ✓ Config file: /home/<you>/.config/engram/.engram-connectors/connectors/claude-code.json
  ✓ Config valid: OK
  ✓ Publisher: claude-code: host not installed (skip)

Connector healthy

remnic connectors doctor hermes
  ✓ Config file: /home/<you>/.config/engram/.engram-connectors/connectors/hermes.json
  ✓ Config valid: OK
  ✓ Publisher: hermes: host not installed (skip)

Connector healthy
```

For `replit`, the install only mints a bearer token. There is no `@remnic/cli` `registerPublisher("replit", ...)` call and no `replit` entry in `CONNECTOR_TO_HOST`, so `hostIdForConnector("replit")` returns `"replit"`, `PUBLISHERS["replit"]` is `undefined`, the `if (factory)` block at `cmdConnectors:8384` is skipped, and the doctor prints only the two config rows:

```bash
remnic connectors doctor replit
  ✓ Config file: /home/<you>/.config/engram/.engram-connectors/connectors/replit.json
  ✓ Config valid: OK

Connector healthy
```

For `claude-code`, `remnic connectors doctor claude-code` returns `Connector healthy` after step 1 of the install (the two config rows pass and the publisher row reports `host not installed (skip)` because the stub returns false) — but the host itself is not actually wired up until steps 2 and 3 from the plugin README are also done. See [`docs/plugins/claude-code.md`](../plugins/claude-code.md#troubleshooting) for what to check when auto-recall/auto-observe do not fire despite a green doctor output.

## Step 5: Use It

Just use your AI tools normally. Remnic works automatically:

- **Start a session** → Remnic recalls your preferences and project context
- **Type a prompt** → Remnic injects relevant memories
- **Edit files** → Remnic observes and learns patterns
- **Switch tools** → memories carry over instantly

### Try it

In Claude Code:
```
> /engram:remember I prefer functional programming patterns over OOP
> /engram:recall programming preferences
```

The slash commands still use the legacy `/engram:*` names during the v1.x compatibility window. The product and CLI are now `remnic`.

Then open Codex CLI and start a new session — it already knows your preference.

### Get a daily briefing

Once you have memories flowing in, generate a focused summary of what changed recently:

```bash
remnic briefing                          # yesterday, markdown, no save
remnic briefing --since 3d               # last 72 hours
remnic briefing --focus project:alpha    # scoped to one project
remnic briefing --format json --save     # save a dated JSON file
```

The briefing cross-references active entities, recent facts, and open commitments. If `OPENAI_API_KEY` is set, it also appends a short list of suggested follow-ups via the Responses API. See [Daily Briefing](./daily-briefing.md) for the full guide.

## Already Using OpenClaw?

If you're an existing OpenClaw user:

```bash
remnic connectors install openclaw
```

This upgrades OEO to expose `:4318` so other agents can share the same memory store OpenClaw uses. Your existing memories are untouched.

## Next Steps

- [Daemon management](./daemon-management.md) — configure auto-start, logs, ports
- [Plugin docs](../plugins/) — detailed guides per platform
- [Architecture](../architecture/emo-oeo-split.md) — how it works under the hood
