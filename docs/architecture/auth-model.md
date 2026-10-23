# Authentication Model

## Per-Plugin Tokens

Each plugin/connector can have its own auth token. The current store contains a
`tokens` array of entries at `~/.remnic/tokens.json`; a legacy
`~/.engram/tokens.json` is read as a fallback. Entries record the token,
connector id, creation time, and, for newly minted tokens, capabilities:

```json
{
  "tokens": [
    {
      "token": "${CONNECTOR_TOKEN}",
      "connector": "claude-code",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "capabilities": { "version": 1 }
    }
  ]
}
```

The old flat `{ "connector": "token" }` map remains readable and is migrated
best-effort to the entry format. A token prefix is a naming convention, not proof
of a connector identity or permission; validation matches the complete stored token.

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

The HTTP access layer compares bearer credentials using `crypto.timingSafeEqual`.
Missing, invalid, or path-disallowed credentials return `401 Unauthorized`.
The standalone server accepts its configured operator token and dynamically
loaded connector entries. Without either, protected requests are rejected.

The standalone entry loader caches one coherent token/connector/capability
snapshot for up to five seconds. Token writes through `saveTokenStore()`
invalidate that process's cache immediately; another process's changes become
visible when the cached snapshot is refreshed. No server restart is required.

ChatGPT connector tokens are restricted by the standalone server to `/mcp`;
they do not authorize REST or operator-console routes.

## Audit Trail

On supported write paths, the matched token-store entry supplies
`sourceConnector` provenance. It is not inferred from the token's prefix:

```yaml
---
id: mem_abc123
source: extraction
sourceConnector: claude-code
created: 2026-04-05T10:30:00Z
---
```

Connector provenance supports attribution and debugging. It is distinct from the
principal that drives namespace ACLs: HTTP resolves a trusted principal header
(when explicitly enabled), then the configured server principal, then an adapter
default. A connector name is not automatically a namespace principal.

## Token Capabilities and Namespace ACLs

Per-token restrictions are implemented, not future work. `remnic token generate`
accepts `--ops <comma-list>` and `--namespaces <comma-list>`. In the version-1
capability record:

- An absent `ops` or `namespaces` axis is unrestricted on that axis.
- An empty array denies everything on that axis.
- A non-empty `namespaces` array allows only its listed namespaces. A non-empty
  `ops` array allows only its listed operations, except where an operation
  declares alternate grants (`allowedByOps`): the `namespace_writable` preflight
  is also granted by `observe` or `memory_store`.

New tokens always record capabilities; `{ "version": 1 }` explicitly means no
token-level restrictions. Pre-feature entries without `capabilities` retain
legacy unrestricted access. Static operator tokens are also unrestricted at the
token-capability layer. Namespace ACLs and feature-specific checks still apply.

HTTP and MCP enforce operation and effective-namespace restrictions. Denied
authorization returns a forbidden error rather than granting access based on a
client-supplied namespace. MCP `tools/list` filters tools by the token's operation
allow-list. Use the authenticated
[`GET /engram/v1/authorization`](../api.md#http) probe to check operations without
executing them; resource-specific checks can still reject the actual call.

The implementation contracts live in
[`tokens.ts`](../../packages/remnic-core/src/tokens.ts),
[`access-token-capabilities.ts`](../../packages/remnic-core/src/access-token-capabilities.ts),
and [`access-http.ts`](../../packages/remnic-core/src/access-http.ts).

## Security Considerations

- Tokens are stored in `~/.remnic/tokens.json` with `0600` permissions (owner-only read/write)
- Tokens are never logged in full — only the prefix is shown in logs
- The file is not committed to git (`.gitignore`)
- EMO binds to `127.0.0.1` by default (localhost only) — external access requires explicit configuration
