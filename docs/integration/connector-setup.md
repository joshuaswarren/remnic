# Connector Setup Guide

Connect Remnic memory to your coding tools. All connectors use the same Remnic HTTP/MCP server — you just need to point your tool at it.

Architecture rule: this server is the shared, host-agnostic Remnic runtime. OpenClaw, Hermes, Claude Code, Codex, and the other integrations are adapters over that shared core, not the place where core memory behavior should be implemented.

## Prerequisites

Start the Remnic server (one of these):

```bash
# Option A: OpenClaw plugin mode (if already using OpenClaw)
openclaw engram access http-serve --port 4318 --token "$REMNIC_AUTH_TOKEN"

# Option B: Standalone daemon
remnic daemon start
```

Verify it's running:

```bash
curl -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" http://localhost:4318/engram/v1/health
```

---

## Claude Code

Add to `~/.claude.json` (or project `.mcp.json`):

```jsonc
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}",
        // Optional: scope memory to a project/team namespace
        "X-Engram-Namespace": "my-project",
        "X-Engram-Principal": "my-team"
      }
    }
  }
}
```

Restart Claude Code. Verify with: `What MCP tools do you have?`

**Auto-detection:** Claude Code sends `clientInfo.name = "claude-code"` and `User-Agent: claude-code/<version>` — Remnic identifies it automatically.

**Capabilities:** observe, recall, store, search, entities, real-time sync

---

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.remnic]
url = "http://127.0.0.1:4318/mcp"
bearer_token_env_var = "REMNIC_AUTH_TOKEN"
# Optional: scope memory to a project/team namespace
http_headers = { "X-Engram-Namespace" = "my-project", "X-Engram-Principal" = "codex-agent" }
```

See the [full Codex CLI guide](../guides/codex-cli.md) for session-start hooks and automatic recall.

**Auto-detection:** Codex sends `clientInfo.name = "codex-mcp-client"` — Remnic identifies it automatically.

**Capabilities:** observe, recall, store, batch

---

## Pi Coding Agent

Install the native Pi extension:

```bash
remnic connectors install pi
```

This writes `~/.pi/agent/extensions/remnic/index.ts` for Pi auto-discovery plus a private `remnic.config.json` containing the Remnic daemon URL, namespace, and connector token.

Optional configuration:

```bash
remnic connectors install pi \
  --config remnicDaemonUrl=http://127.0.0.1:4318 \
  --config namespace=my-project
```

See the [full Pi integration guide](pi.md) for hooks, slash commands, and compaction behavior.

**Capabilities:** observe, recall, store, search, MCP tools, compaction coordination

---

## Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

```jsonc
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

Restart Cursor. Open the MCP panel to verify the connection.

**Capabilities:** recall, search

---

## GitHub Copilot

GitHub Copilot supports MCP servers in VS Code. Add to your VS Code `settings.json`:

```jsonc
{
  "github.copilot.chat.experimental.mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** recall, search

---

## Cline

Add to your Cline MCP settings (VS Code Settings > Cline > MCP Servers):

```jsonc
{
  "remnic": {
    "url": "http://localhost:4318/mcp",
    "headers": {
      "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
    }
  }
}
```

**Capabilities:** observe, recall, store, batch

---

## Roo Code

Add to your Roo Code MCP settings:

```jsonc
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** observe, recall, store, batch

---

## Windsurf

Add to your Windsurf MCP settings (Settings > MCP):

```jsonc
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** observe, recall, store, search

---

## Amp

Add to your Amp configuration:

```jsonc
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** observe, recall, store, search

---

## Replit Agent

Replit Agent supports MCP natively via the **Integrations pane** (HTTP transport only — the Remnic server must be publicly reachable).

### Option A: MCP (recommended)

1. In your Replit workspace, open **Integrations** > **Add MCP server**
2. Enter the Remnic server URL: `https://your-remnic-server.com/mcp`
3. Add custom headers:
   - `Authorization`: `Bearer <your-remnic-token>`
   - `X-Engram-Client-Id`: `replit` (enables auto-detection)
   - `X-Engram-Namespace`: `<your-project-name>` (optional)
4. Click **Test & Save**

Replit Agent will auto-discover all Remnic MCP tools and use them contextually.

### Option B: HTTP API (for custom agent code)

```bash
REMNIC_API_URL=https://your-remnic-server.com/engram/v1
REMNIC_AUTH_TOKEN=your-token-here
```

```typescript
const response = await fetch(`${REMNIC_API_URL}/recall`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${REMNIC_AUTH_TOKEN}`,
    "Content-Type": "application/json",
    "X-Engram-Client-Id": "replit",
  },
  body: JSON.stringify({ query: "what do I know about this project?" }),
});
```

**Note:** Replit does not send identifying headers automatically. The `X-Engram-Client-Id: replit` header enables Remnic's adapter auto-detection. The header name remains `X-Engram-*` during the v1.x compatibility window.

**Capabilities:** observe, recall, store, search (via MCP or HTTP)

---

## Hermes Agent

Hermes supports MCP servers via `config.yaml`. For deeper integration, Hermes v0.7.0+ also supports a dedicated **MemoryProvider plugin protocol** — see [Hermes setup guide](../guides/hermes-setup.md).

### Option A: MCP (quick start)

Add to your Hermes `config.yaml`:

```yaml
mcp_servers:
  remnic:
    url: "http://localhost:4318/mcp"
    headers:
      Authorization: "Bearer ${REMNIC_AUTH_TOKEN}"
      X-Engram-Client-Id: "hermes"
      # Optional: scope memory to a Hermes profile
      X-Engram-Namespace: "my-profile"
```

**Auto-detection:** Hermes sends `X-Hermes-Session-Id` on API requests — Remnic identifies it automatically. The `X-Engram-Client-Id: hermes` header provides a fallback for MCP-only connections. The `X-Engram-*` header names remain accepted during the v1.x compatibility window.

### Option B: MemoryProvider Plugin (recommended for production)

Hermes v0.7.0+ has a Python `MemoryProvider` protocol (`initialize`, `pre_llm_call`, `sync_turn`, `extract_memories`, `shutdown`) that provides tighter integration than MCP alone — including automatic turn-level memory sync and context enrichment.

See the [Hermes plugin reference](../plugins/hermes.md) for the `remnic-hermes` plugin setup.

**Capabilities:** observe, recall, store, search, entity sync, turn-level memory

---

## WeClone Avatar

[WeClone](https://github.com/xming521/weclone) fine-tunes a model on your chat
history, then serves it via an OpenAI-compatible API. Remnic's `weclone`
connector adds persistent memory on top, so the deployed avatar remembers
prior conversations instead of being stateless at inference time.

### Install

```bash
remnic connectors install weclone \
  --config wecloneApiUrl=http://localhost:8000/v1 \
  --config proxyPort=8100
```

This writes two files:

- `~/.config/engram/.engram-connectors/connectors/weclone.json` — legacy registry path
  used by `remnic connectors list / remove / doctor` during the v1.x compatibility window.
- `~/.remnic/connectors/weclone.json` — proxy config read by
  `remnic-weclone-proxy` at startup. A Remnic daemon auth token is minted and
  stored here so the proxy can authenticate without additional setup.

### Run

```bash
remnic-weclone-proxy
```

Point your bot/client at `http://localhost:8100/v1` (or whichever `proxyPort`
you chose). All OpenAI-compatible requests are transparently proxied, with
memory injection applied only to `POST /v1/chat/completions`.

### Per-caller session isolation

For multi-user avatars, install with `sessionStrategy=caller-id`:

```bash
remnic connectors install weclone --force \
  --config sessionStrategy=caller-id
```

Callers should pass their identity via the `X-Caller-Id` header (or the
OpenAI-compatible `user` field in the request body). The proxy maps this to
a Remnic session key so each user's memory is isolated.

**Capabilities:** observe, recall (store/search happen inside Remnic itself,
not via the WeClone proxy).

See the [connector package README](https://github.com/joshuaswarren/remnic/tree/main/packages/connector-weclone)
for the full config reference and architecture diagram.

---

## Generic MCP Client

Any tool that supports the [Model Context Protocol](https://modelcontextprotocol.io/) can connect to Remnic. Point your client at:

- **MCP endpoint:** `http://localhost:4318/mcp`
- **Auth:** `Authorization: Bearer <token>` header
- **Transport:** HTTP (SSE for streaming)

### Available MCP Tools

Most tools are currently exposed with `engram.*` names for v1.x compatibility;
canonical `remnic.*` aliases are being added on the same MCP surface.

| Tool | Description |
|------|-------------|
| `engram.recall` | Query memories with semantic search |
| `engram.recall_explain` | Return the last recall snapshot for a session |
| `engram.observe` | Store conversation context |
| `engram.memory_store` | Store a memory directly |
| `engram.memory_get` | Get a specific memory by ID |
| `engram.memory_timeline` | Browse memory timeline |
| `engram.entity_get` | Get details for a specific entity |
| `engram.lcm_search` | Search using Lossless Context Management |
| `engram.suggestion_submit` | Submit a memory suggestion for review |
| `engram.review_queue_list` | List items in the review queue |
| `engram.day_summary` | Generate end-of-day summary |
| `engram.memory_governance_run` | Run memory governance pass |
| `engram.continuity_audit_generate` | Generate identity continuity audit report |
| `engram.continuity_incident_open` | Open a continuity incident record |
| `engram.continuity_incident_close` | Close an open continuity incident |
| `engram.continuity_incident_list` | List continuity incidents by state |
| `engram.continuity_loop_add_or_update` | Add/update a continuity improvement loop |
| `engram.continuity_loop_review` | Review a continuity improvement loop |
| `engram.identity_anchor_get` | Read identity continuity anchor document |
| `engram.identity_anchor_update` | Update identity anchor sections |
| `engram.memory_identity` | Read agent identity reflections |
| `engram.work_task` | Manage work-layer tasks (CRUD + transition) |
| `engram.work_project` | Manage work-layer projects (CRUD + link_task) |
| `engram.work_board` | Export/import work-layer board snapshots |
| `engram.shared_context_write_output` | Write agent output to shared context |
| `engram.shared_feedback_record` | Record approval/rejection feedback |
| `engram.shared_priorities_append` | Append priorities to inbox |
| `engram.shared_context_cross_signals_run` | Generate cross-signal synthesis |
| `engram.shared_context_curate_daily` | Generate daily roundtable summary |
| `engram.compounding_weekly_synthesize` | Weekly compounding reports + rubrics |
| `engram.compounding_promote_candidate` | Promote compounding candidate to memory |
| `engram.compression_guidelines_optimize` | Run compression guideline optimizer |
| `engram.compression_guidelines_activate` | Activate staged compression guideline |
| `engram.memory_search` | Direct semantic search over memory files |
| `engram.memory_profile` | Read user behavioral profile |
| `engram.memory_entities_list` | List all tracked entities |
| `engram.memory_questions` | List open questions from conversations |
| `engram.memory_last_recall` | Debug: last recall snapshot |
| `engram.memory_intent_debug` | Debug: intent classification |
| `engram.memory_qmd_debug` | Debug: QMD search index |
| `engram.memory_graph_explain` | Debug: entity graph recall explanation |
| `engram.memory_feedback` | Record relevance feedback for a memory |
| `engram.memory_promote` | Promote a memory's lifecycle state |
| `engram.context_checkpoint` | Save session context checkpoint to disk |

---

## Managing Connectors

Use the `remnic connectors` CLI to manage connector installations:

```bash
# List all available connectors
remnic connectors list

# Install a connector (creates config file)
remnic connectors install claude-code

# Check connector health
remnic connectors doctor claude-code

# Remove a connector
remnic connectors remove claude-code
```

---

## Troubleshooting

### Connection refused

The Remnic server isn't running. Start it:

```bash
remnic daemon start    # standalone
# or
openclaw engram access http-serve --port 4318 --token "$REMNIC_AUTH_TOKEN"  # OpenClaw-hosted compatibility path
```

### 401 Unauthorized

Token mismatch. Verify `REMNIC_AUTH_TOKEN` matches between server and client config.

### MCP tools not showing up

1. Restart your tool after config changes
2. Check the MCP endpoint responds: `curl -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" -X POST http://localhost:4318/mcp -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'`
3. Some tools require explicit MCP enable in settings

### Slow recall

If queries are slow, enable QMD for hybrid search:

```bash
remnic doctor    # checks search backend status
```

See [Getting Started](../getting-started.md) for QMD setup.
