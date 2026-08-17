# Factory Droid Integration

> **Built by Droid.** This connector was implemented by Factory Droid itself —
> Droid wrote the code, tests, and this document. See the PR description for
> the full walkthrough of Droid commands, commit SHAs, and before/after output.

[Factory Droid](https://factory.ai) is an AI software engineering agent that
works in your environment. With the Remnic Droid connector, Droid gets
persistent memory across sessions: every conversation can recall relevant
context and store new knowledge into your shared Remnic memory store.

## Quickstart

```bash
# 1. Start the Remnic daemon
remnic daemon start

# 2. Install the Droid connector
remnic connectors install droid

# 3. Verify the install
remnic connectors doctor droid

# 4. Confirm Droid can see the remnic MCP server
#    (restart Droid or open a new session)
```

That's it. Droid reads MCP server config from `~/.factory/mcp.json` at startup.
The install writes a `remnic` entry with HTTP transport and a bearer token so
Droid authenticates to your local Remnic daemon automatically.

## What `install` does

`remnic connectors install droid` performs three actions:

1. **Mints a host token.** A per-connector bearer token is generated and stored
   in `~/.remnic/tokens.json` (the authoritative token store, permissions
   `0600`). The token is never written into the connector registry file.

2. **Records connector state.** A `droid.json` file is written to the Remnic
   connectors directory (`~/.config/remnic/.remnic-connectors/connectors/droid.json`).
   This tracks the install time, the resolved MCP server URL, and the path to
   `~/.factory/mcp.json` so `remove` can find it later.

3. **Writes `~/.factory/mcp.json`.** The install upserts a `remnic` entry under
   `mcpServers` with HTTP transport and the `Authorization: Bearer <token>`
   header. Existing MCP server entries are preserved — only the `remnic` key
   is added or updated.

### User-level vs project-level

The install writes to the **user-level** `~/.factory/mcp.json` only. It never
touches the project-level `.factory/mcp.json`, which may be committed to git
and would expose the bearer token to anyone with repository access.

## Configuration

Optional overrides via `--config`:

```bash
remnic connectors install droid \
  --config mcpServerUrl=http://127.0.0.1:4318/mcp \
  --config namespace=my-project
```

| Key | Default | Description |
|-----|---------|-------------|
| `mcpServerUrl` | `http://127.0.0.1:4318/mcp` | URL of the Remnic MCP server |
| `namespace` | _(none)_ | Optional memory namespace for project/team isolation |

## Doctor

```bash
remnic connectors doctor droid
```

Checks:

- **Config file** — the `droid.json` registry file exists and is valid JSON
- **Config valid** — parses without errors
- **Droid MCP config** — `~/.factory/mcp.json` contains a `remnic` entry under
  `mcpServers`

## Remove

```bash
remnic connectors remove droid
```

This removes the `remnic` entry from `~/.factory/mcp.json` (preserving all
other MCP server entries), deletes the `droid.json` registry file, and revokes
the bearer token from `~/.remnic/tokens.json`.

## Manual setup (without `remnic connectors install`)

If you prefer to configure Droid manually, add this to `~/.factory/mcp.json`:

```jsonc
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp",
      "headers": {
        "Authorization": "Bearer <your-remnic-token>"
      }
    }
  }
}
```

Generate a token with `remnic token generate droid` and use the returned value
in place of `<your-remnic-token>`.

## Capabilities

| Capability | Supported |
|------------|-----------|
| Observe | Yes |
| Recall | Yes |
| Store | Yes |
| Search | Yes |
| Entities | Yes |
| Real-time sync | Yes |
| Batch | Yes |

## Troubleshooting

### Droid doesn't see the remnic MCP tools

Restart Droid or open a new session — it reads `~/.factory/mcp.json` at
startup. Verify the entry exists:

```bash
remnic connectors doctor droid
```

### 401 Unauthorized

The token in `~/.factory/mcp.json` doesn't match what the daemon expects.
Reinstall to mint a fresh token:

```bash
remnic connectors install droid --force
```

### Connection refused

The Remnic daemon isn't running:

```bash
remnic daemon start
```

Verify with:

```bash
curl -H "Authorization: Bearer $(remnic token list --json | jq -r '.tokens[] | select(.connector=="droid") | .token')" \
  http://localhost:4318/engram/v1/health
```
