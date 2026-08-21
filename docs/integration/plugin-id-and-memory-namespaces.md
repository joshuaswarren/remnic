# Plugin ID and Memory Namespaces

This document explains the Remnic plugin ID split, how OpenClaw's `plugins.slots.memory` gating works, the expected operator workflow, memory namespace conventions, and forward-compatibility notes.

## The Plugin ID Split

Remnic ships as two separate plugin IDs:

| ID | Package | Purpose |
|----|---------|---------|
| `openclaw-remnic` | `@remnic/plugin-openclaw` | Current release — use this for new installs |
| `openclaw-engram` | `@joshuaswarren/openclaw-engram` | Legacy compatibility shim — re-exports `@remnic/plugin-openclaw` |

The split exists to support a graceful migration from the old `openclaw-engram` name without breaking existing operator configs. The shim package maps the old ID to the new implementation so operators who have `plugins.entries["openclaw-engram"]` in their `openclaw.json` continue to work until they migrate.

**New installs should always use `openclaw-remnic` and `@remnic/plugin-openclaw`.**

## How `plugins.slots.memory` Gating Works

OpenClaw gates single-kind memory plugins on the `plugins.slots.memory` value in `openclaw.json`. The loader checks:

```
plugins.slots.memory === <plugin id>
```

If this condition is not met for a given plugin, OpenClaw skips calling `register(api)` entirely. As a result:
- `gateway_start` never fires
- `before_prompt_build` never fires
- `agent_end` never fires
- No memory is stored or recalled

This is silent by design — OpenClaw does not log a warning when a plugin is skipped due to slot mismatch. Operators see the plugin "installed" but nothing actually hooks into the gateway.

**A correct config for Remnic looks like this:**

```json
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "memoryDir": "~/.openclaw/workspace/memory/local"
        }
      }
    },
    "slots": {
      "memory": "openclaw-remnic"
    }
  }
}
```

Both fields are required:
- `plugins.entries["openclaw-remnic"]` — declares the plugin and its config
- `plugins.slots.memory = "openclaw-remnic"` — tells OpenClaw which entry to activate for the memory slot

## Expected Operator Workflow

The recommended workflow for a new Remnic install:

```bash
# Step 1: Run the install helper
remnic openclaw install

# Step 2: Restart the OpenClaw gateway to pick up the new config
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Step 3: Start a conversation — check the gateway log
grep "gateway_start" ~/.openclaw/logs/gateway.log

# Expected output (the id matches the configured entry; installs via the legacy shim show id=openclaw-engram):
# gateway_start fired — Remnic memory plugin is active (id=openclaw-remnic, memoryDir=~/.openclaw/workspace/memory/local)

# Step 4: Verify the full health picture
remnic doctor
```

The `remnic openclaw install` command handles steps that are easy to get wrong manually:
- Resolves the correct config path (honours `$OPENCLAW_CONFIG_PATH` and `$OPENCLAW_ENGRAM_CONFIG_PATH`)
- Creates `memoryDir` if it does not exist
- Writes `plugins.entries["openclaw-remnic"]` with sensible defaults
- Sets `plugins.slots.memory = "openclaw-remnic"`
- Detects a legacy `openclaw-engram` entry and interactively offers to migrate

## Memory Namespace Conventions

### Default namespace

The default memory directory is:

```
~/.openclaw/workspace/memory/local
```

This path is the canonical location used by:
- `remnic openclaw install` (as the default `memoryDir`)
- `docs/integration/sample-openclaw-config.json`
- The CLI's `resolveMemoryDir()` auto-detect logic (falls back to this path when no standalone `~/.remnic/memory` exists)

### Per-workspace namespaces

To isolate memory for a specific project, set `memoryDir` to a project-scoped path:

```json
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "memoryDir": "~/.openclaw/workspace/memory/my-project"
        }
      }
    },
    "slots": {
      "memory": "openclaw-remnic"
    }
  }
}
```

Remnic's space management (`remnic space create`) also creates isolated directories — run `remnic space list` to see active namespaces.

### How `memoryDir` maps to the config

The `memoryDir` value in `plugins.entries["openclaw-remnic"].config.memoryDir` is passed directly to Remnic's `parseConfig()` function. All relative paths with a leading `~` are expanded to `$HOME` at runtime. The directory is created automatically on first write if it does not exist.

## Forward-Compatibility Note

OpenClaw's current plugin system uses a single `slots.memory` value, which selects exactly one memory plugin per gateway session. When OpenClaw eventually supports multiple-kind memory plugins or per-kind slot arrays, the slot pattern will extend naturally — each kind will have its own slot key (e.g., `slots.episodic`, `slots.semantic`) and operators will set them independently. The `openclaw-remnic` plugin ID and `memoryDir` convention are designed to remain stable across that transition.

In the meantime, if you need to run Remnic alongside another memory plugin, use Remnic's standalone HTTP/MCP bridge mode (`remnic daemon install`) so both systems can operate from separate processes without competing for the memory slot.
