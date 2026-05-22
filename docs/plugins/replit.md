# Replit Agent Connector

MCP-based connector for Replit Agent. Replit does not have a plugin system, so this is MCP-only.

## Installation

```bash
remnic connectors install replit
```

This:
1. Starts the Remnic daemon if not running
2. Generates a dedicated auth token
3. Prints step-by-step instructions for the Replit Integrations pane
4. Provides a copy-pasteable MCP config snippet

## Setup in Replit

Replit Agent supports MCP servers via the **Integrations pane** (HTTP transport only — the Remnic daemon must be reachable from Replit).

### For Local Development (localhost)

1. In your Replit workspace, open **Integrations** > **Add MCP server**
2. Enter: `http://localhost:4318/mcp`
3. Add headers:
   - `Authorization`: `Bearer <your-token>`
   - `X-Engram-Client-Id`: `replit`
4. Click **Test & Save**

### For Remote/Cloud Replit

The Remnic daemon must be publicly reachable. Options:
- Expose Remnic via a tunnel (ngrok, tailscale, etc.)
- Deploy Remnic to a server with a public IP
- Use a reverse proxy

## Limitations

Unlike Claude Code, Codex, and Hermes, Replit has no hook system. This means:

| Feature | Available? | Workaround |
|---------|-----------|------------|
| Auto-recall per prompt | No | Agent must call `remnic.recall` tool |
| Auto-observe | No | Agent must call `remnic.observe` tool |
| Session start recall | No | Agent can call recall at conversation start |
| Per-prompt memory | No | Agent decides when to check memory |

The agent has full access to all 44 MCP tools but must choose to use them.

## Available MCP Tools

All Remnic MCP tools are available — recall, observe, store, search, entities, governance, work tracking, etc. See [MCP tools reference](../api/mcp-tools.md).

## Troubleshooting

### Connection refused

The Remnic daemon isn't reachable from Replit. If running locally, check `remnic daemon status`. If remote, check network/firewall.

### 401 Unauthorized

Token mismatch. Regenerate:

```bash
remnic token revoke replit
remnic token generate replit
```

Then update the token in Replit's Integrations pane.

## Uninstall

```bash
remnic connectors remove replit
```

Then remove the MCP server from Replit's Integrations pane manually.
