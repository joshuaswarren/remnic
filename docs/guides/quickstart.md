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

Verify:

```bash
remnic daemon status
# ✓ Remnic server running on :4318
# ✓ Memory store: ~/.remnic/memory/
# ✓ Auto-start: enabled
```

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

The exact `remnic connectors doctor` output depends on which hosts you have actually configured. Each connector install is a separate step (see the plugin README for the host you picked). A representative green run might look like:

```bash
remnic connectors doctor
# ✓ codex-cli: connected, plugin loaded
# ✓ hermes: connected, MemoryProvider active
# ✓ replit: token generated (configure in Integrations pane)
```

Claude Code does **not** appear here as automated output — its connector install only writes Remnic-side state; you have to load the plugin and paste the `.mcp.json` block yourself per the plugin README.

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
