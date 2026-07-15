# Authentication Model

## Per-Plugin Tokens

Each plugin/connector gets its own auth token. Tokens are stored at `~/.remnic/tokens.json` (a legacy `~/.engram/tokens.json` is read as a fallback):

```json
{
  "openclaw": "remnic_oc_a1b2c3d4e5f6...",
  "claude-code": "remnic_cc_f6e5d4c3b2a1...",
  "codex": "remnic_cx_1a2b3c4d5e6f...",
  "hermes": "remnic_hm_6f5e4d3c2b1a...",
  "replit": "remnic_rl_b1c2d3e4f5a6..."
}
```

### Token Format

```
remnic_<platform>_<48-char-random-hex>
```

| Prefix | Platform |
|--------|----------|
| `oc` | OpenClaw |
| `cc` | Claude Code |
| `cx` | Codex CLI |
| `hm` | Hermes Agent |
| `pi` | Pi Coding Agent |
| `op` | omp |
| `rl` | Replit Agent |
| `cu` | Cursor |
| `cg` | ChatGPT |
| `gm` | Generic MCP client |
| `xx` | Unknown / fallback |

### Token Lifecycle

```bash
remnic token generate claude-code   # creates and stores token
remnic token list                   # shows all tokens (masked)
remnic token revoke claude-code     # removes token
```

Tokens are generated automatically during `remnic connectors install <platform>`.

## How Tokens Are Used

### HTTP Requests

```
Authorization: Bearer remnic_cc_f6e5d4c3b2a1...
```

### MCP Connections

Tokens are configured in each platform's MCP settings (`.mcp.json`, `config.toml`, etc.) and sent as the `Authorization` header on the HTTP transport.

### OpenClaw Embedded Mode

In embedded mode, OEO talks to the Orchestrator in-process — no HTTP, no token needed for the OEO→EMO path. External agents connecting to `:4318` still need tokens.

## Token Validation

EMO validates tokens using `crypto.timingSafeEqual` to prevent timing attacks. Invalid tokens return `401 Unauthorized`.

## Audit Trail

Each memory operation is attributed to the token's platform:

```yaml
---
id: mem_abc123
source: extraction
extractedBy: claude-code    # ← from token prefix
created: 2026-04-05T10:30:00Z
---
```

This enables:
- Per-platform memory statistics
- Debugging which agent stored incorrect information
- Future per-platform permissions (read-only vs read-write)

## Future: Multi-User Support

The token model is designed to extend to multi-user scenarios:

```json
{
  "tokens": {
    "remnic_cc_...": { "user": "alice", "platform": "claude-code", "scopes": ["read", "write"] },
    "remnic_cx_...": { "user": "alice", "platform": "codex", "scopes": ["read", "write"] },
    "remnic_cc_...": { "user": "bob", "platform": "claude-code", "scopes": ["read"] }
  }
}
```

Each user's memories would be stored in separate directories, with optional cross-user sharing for team knowledge.

## Security Considerations

- Tokens are stored in `~/.remnic/tokens.json` with `0600` permissions (owner-only read/write)
- Tokens are never logged in full — only the prefix is shown in logs
- The file is not committed to git (`.gitignore`)
- EMO binds to `127.0.0.1` by default (localhost only) — external access requires explicit configuration
