# Codex Marketplace Integration

Remnic supports the Codex CLI marketplace system, allowing users to discover
and install the Remnic memory plugin through the standard `codex marketplace`
workflow.

## What is the Codex Marketplace?

The Codex marketplace is a plugin distribution system built into the Codex CLI.
It allows installing plugins from:

- **GitHub repos** (`codex marketplace add owner/repo`)
- **Git URLs** (`codex marketplace add https://github.com/owner/repo.git`)
- **Local directories** (for development)
- **Direct URLs** (for custom registries)

Each marketplace source provides a `marketplace.json` manifest that describes
available plugins, their versions, and how to install them.

## Installing Remnic via Codex Marketplace

```bash
codex marketplace add joshuaswarren/remnic
```

This fetches the `marketplace.json` from the Remnic repository and installs
the Codex plugin package located at `packages/plugin-codex`.

## Marketplace Manifest Format

The `marketplace.json` at the repository root describes Remnic as an
installable plugin:

```json
{
  "version": 1,
  "name": "remnic",
  "description": "Remnic: Local-first AI memory with semantic search and consolidation",
  "plugins": [
    {
      "name": "remnic",
      "version": "9.3.11",
      "description": "Persistent memory plugin for Codex CLI",
      "repository": "joshuaswarren/remnic",
      "installType": "github",
      "entry": "packages/plugin-codex",
      "configSchema": "openclaw.plugin.json"
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `1` | Yes | Schema version (always 1) |
| `name` | string | Yes | Marketplace name |
| `description` | string | Yes | Human-readable description |
| `plugins` | array | Yes | Available plugins (at least one) |
| `plugins[].name` | string | Yes | Plugin identifier |
| `plugins[].version` | string | Yes | Semver version |
| `plugins[].description` | string | Yes | Plugin description |
| `plugins[].repository` | string | Yes | Repository reference |
| `plugins[].installType` | enum | Yes | One of: `github`, `git`, `local`, `url` |
| `plugins[].entry` | string | No | Entry point path within the repo |
| `plugins[].configSchema` | string | No | Path to config schema file |
| `plugins[].manifestUrl` | string | No | Direct URL to plugin manifest |

## CLI Commands

### Generate marketplace.json

```bash
remnic connectors marketplace generate [--output <dir>]
```

Generates a `marketplace.json` manifest file from the current configuration.
Defaults to writing in the current directory.

### Validate marketplace.json

```bash
remnic connectors marketplace validate [path]
```

Validates a `marketplace.json` file against the schema. Exits with code 0 if
valid, non-zero if invalid. Defaults to `./marketplace.json`.

### Install from marketplace

```bash
remnic connectors marketplace install <source> [--type github|git|local|url]
```

Install plugins from a marketplace source. The `--type` flag defaults to
`github` when omitted.

Examples:

```bash
# Install from GitHub
remnic connectors marketplace install joshuaswarren/remnic

# Install from a local directory (development)
remnic connectors marketplace install ./my-plugin --type local

# Install from a URL
remnic connectors marketplace install https://example.com/marketplace.json --type url
```

## Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `codexMarketplaceEnabled` | boolean | `true` | Enable marketplace features |

Set `codexMarketplaceEnabled: false` in your Remnic config to disable
marketplace install operations.

## How Remnic Participates in the Ecosystem

Remnic exposes itself to the Codex marketplace through:

1. **Root `marketplace.json`** --- discovered by `codex marketplace add`.
2. **`packages/plugin-codex/`** --- the actual Codex plugin with hooks, skills,
   and MCP configuration.
3. **`openclaw.plugin.json`** --- the full config schema referenced by the
   marketplace entry.

When a user runs `codex marketplace add joshuaswarren/remnic`, the Codex CLI:

1. Fetches `marketplace.json` from the repository.
2. Reads the plugin entry to find `packages/plugin-codex`.
3. Installs the plugin and its dependencies.
4. Registers the plugin in the Codex configuration.
