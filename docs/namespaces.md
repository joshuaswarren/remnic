# Namespaces (v3.0)

Namespaces allow multiple agents to share one Engram installation while keeping most memories isolated per agent, with a curated shared namespace.

## Key Config

- `namespacesEnabled` (default: false)
- `namespaceCatalogEnabled` (default: true; inert unless `namespacesEnabled` — see [Namespace Catalog](#namespace-catalog-issue-1499))
- `defaultNamespace` (default: `default`)
- `sharedNamespace` (default: `shared`)
- `namespacePolicies`: list of namespaces and read/write principals
- `principalFromSessionKeyMode` + `principalFromSessionKeyRules`: derive a principal from `sessionKey`
- `defaultRecallNamespaces`: typically `["self", "shared"]`

## Cross-Agent Memory Access

Non-generalist agents (any agent besides the one matching the `defaultNamespace`) recall from both their own **self namespace** and the **shared namespace** (as configured via `defaultRecallNamespaces`). Each agent's extracted memories are stored in its `self` namespace, so agents always have access to their own memories. The shared namespace provides cross-agent context — if it is empty, these agents still receive their own memories but miss context extracted by other agents.

**Shared namespace promotion (v9.0.66+):** When `autoPromoteToSharedEnabled: true`, extracted memories are automatically promoted to the shared namespace. This is the primary mechanism for cross-agent memory sharing. Verify promotion is working:

```bash
ls ~/.openclaw/workspace/memory/local/namespaces/shared/facts/
```

If this directory is empty or missing, non-generalist agents may have limited cross-agent memory context (they still have their own `self` namespace memories). Check that `autoPromoteToSharedEnabled` is `true` and that `autoPromoteMinConfidenceTier` is set to `"implied"` (recommended) to ensure most extracted memories get promoted. The `"explicit"` tier is more conservative and may miss memories that lack strong confidence signals.

**Note:** Shared namespace promotion is not the only source of cross-agent recall. Namespaces configured with `includeInRecallByDefault: true` in `namespacePolicies` are also included in recall for all agents. Check your namespace policies if agents need access to specific namespaces beyond `self` and `shared`.

**Categories eligible for promotion:** The `autoPromoteToSharedCategories` setting controls which memory categories are promoted. The default is `["fact", "correction", "decision", "preference"]`. The `"fact"` category was added in v9.0.67 — prior versions defaulted to `["correction", "decision", "preference"]` only.

**Cross-agent recall:** The primary mechanism for cross-agent memory sharing is shared namespace promotion. When promotion is configured, memories extracted by any agent are copied to the shared namespace and become available to all agents during recall.

## QMD Collections for Namespaces

When namespaces are enabled, QMD needs entries for namespace-specific collections in `~/.config/qmd/index.yml`. The collection names follow the pattern `<qmdCollection>--ns--<namespace>`, where `<qmdCollection>` is the base collection name from your Engram config (default: `openclaw-engram`). This matches the runtime logic in `namespaceCollectionName()` (`src/namespaces/search.ts`). Check the gateway log for the exact names — Engram logs `QMD collection "..." not found` with the expected name when entries are missing.

```yaml
# Base collection (default namespace root)
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]

# Shared namespace (for cross-agent memory)
openclaw-engram--ns--shared:
  path: ~/.openclaw/workspace/memory/local/namespaces/shared
  extensions: [.md]

# Main namespace (if using namespaces/ layout)
openclaw-engram--ns--main:
  path: ~/.openclaw/workspace/memory/local/namespaces/main
  extensions: [.md]
```

**Note:** The exact collection names depend on your `qmdCollection` config value. The examples above use the default `openclaw-engram` base, which produces `openclaw-engram--ns--<namespace>` for namespace variants. If your `qmdCollection` is set to e.g. `my-memory`, the shared namespace collection would be `my-memory--ns--shared`.

After adding entries, rebuild the indexes:

```bash
qmd update && qmd embed
```

## Storage Layout

Compatibility behavior:
- The default namespace continues to use the legacy `memoryDir` root unless `memoryDir/namespaces/<defaultNamespace>` exists.
- Non-default namespaces use `memoryDir/namespaces/<namespace>/`.

This prevents "lost memories" when an install enables namespaces before migrating existing data.

## Tooling

- `memory_store` accepts optional `namespace`.
- `memory_promote` copies a memory into the shared namespace (curated).
- Identity continuity tools accept optional `namespace` to target a specific namespace root.
- Extracted identity reflections are stored per namespace under each namespace root:
  - default namespace: `memoryDir/identity/reflections.md` (or the migrated default namespace root)
  - non-default namespaces: `memoryDir/namespaces/<namespace>/identity/reflections.md`
- Workspace identity synthesis remains namespace-scoped too:
  - default namespace: `workspace/IDENTITY.md`
  - non-default namespaces: `workspace/IDENTITY.<namespace>.md`

## Multi-Tenant Example

Namespaces work well for multi-tenant deployments where different projects or clients share one Engram installation. Here is a generic configuration isolating two tenants with a shared knowledge layer:

```json
{
  "namespacesEnabled": true,
  "sharedNamespace": "shared",
  "defaultRecallNamespaces": ["shared"],
  "namespacePolicies": {
    "default": { "read": ["*"], "write": ["default-principal"] },
    "project-alpha": { "read": ["alpha-agent", "admin"], "write": ["alpha-agent"] },
    "project-beta": { "read": ["beta-agent", "admin"], "write": ["beta-agent"] },
    "shared": { "read": ["*"], "write": ["admin"] }
  },
  "principalFromSessionKeyMode": "prefix",
  "principalFromSessionKeyRules": {
    "project-alpha:": "alpha-agent",
    "project-beta:": "beta-agent"
  }
}
```

Each tenant's agents use a session key prefix (e.g., `project-alpha:session-123`) which maps to a principal (`alpha-agent`) via the prefix rules. The principal determines namespace access: `alpha-agent` can read and write `project-alpha`, read `shared`, but cannot access `project-beta`.

## Shared Knowledge Layer

The shared namespace provides cross-tenant or cross-agent knowledge sharing. Typical configuration:

- **Read access:** `"*"` (all principals can read)
- **Write access:** restricted to `admin` or specific curators
- **Included in recall:** add `"shared"` to `defaultRecallNamespaces` so all agents automatically include shared knowledge in recall

Memories reach the shared namespace in two ways:

1. **Auto-promotion** — When `autoPromoteToSharedEnabled: true`, extracted memories matching `autoPromoteToSharedCategories` (default: `["fact", "correction", "decision", "preference"]`) are automatically copied to the shared namespace. Use `autoPromoteMinConfidenceTier: "implied"` for broader promotion.

2. **Manual promotion** — Use the `memory_promote` tool or `memory_store` with `namespace: "shared"` when the authenticated principal has write access.

## Principal Resolution for HTTP Callers

When connecting via the HTTP API or MCP-over-HTTP, the principal is resolved in this order:

1. **`X-Engram-Principal` header** — If the server was started with `--trust-principal-header`, the header value overrides all other sources. This allows a single server instance to serve multiple tenants.

2. **`--principal` CLI flag** — The default principal for all connections to this server instance.

3. **Session key prefix rules** — If `principalFromSessionKeyMode` is `prefix`, the session key in the request is matched against `principalFromSessionKeyRules` to resolve a principal.

4. **Fallback** — If no principal is resolved, `"default"` is used, which may not have write access to non-default namespaces.

**Example with `X-Engram-Principal` header:**

```bash
# Start the server with header trust enabled
openclaw engram access http-serve \
  --host 127.0.0.1 --port 4318 \
  --token "$ENGRAM_TOKEN" \
  --trust-principal-header

# Request as project-alpha's agent
curl -X POST http://localhost:4318/engram/v1/observe \
  -H "Authorization: Bearer $ENGRAM_TOKEN" \
  -H "X-Engram-Principal: alpha-agent" \
  -H "Content-Type: application/json" \
  -d '{"sessionKey": "s1", "messages": [{"role": "user", "content": "hello"}]}'

# Request as project-beta's agent
curl -X POST http://localhost:4318/engram/v1/observe \
  -H "Authorization: Bearer $ENGRAM_TOKEN" \
  -H "X-Engram-Principal: beta-agent" \
  -H "Content-Type: application/json" \
  -d '{"sessionKey": "s2", "messages": [{"role": "user", "content": "hello"}]}'
```

**Example with session key prefix mode (no header):**

```bash
# Start the server with a default principal
openclaw engram access http-serve \
  --host 127.0.0.1 --port 4318 \
  --token "$ENGRAM_TOKEN"

# The session key prefix determines the principal
curl -X POST http://localhost:4318/engram/v1/observe \
  -H "Authorization: Bearer $ENGRAM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionKey": "project-alpha:session-1", "messages": [{"role": "user", "content": "hello"}]}'
# → principal resolves to "alpha-agent" via prefix rule
```

See the [Standalone Server Guide](guides/standalone-server.md) for full multi-tenant setup instructions.

## Namespace Catalog (issue #1499)

The **namespace catalog** is a rebuildable metadata index that lets Remnic
*enumerate* the configured and dynamically-created namespaces that exist or
should be maintained — for maintenance fanout, QMD indexing diagnostics,
dashboard listings, and `doctor`. The filesystem remains the source of truth;
the catalog is downstream metadata and is fully rebuildable from disk.

- **Storage:** an append-and-compact JSON-lines log at
  `<memoryDir>/state/namespaces.jsonl`. Touches (read/write/maintenance) are
  cheap single appends; reads fold the log into current state (last-record-wins);
  `rebuild` rewrites it atomically (temp file + rename).
- **Metadata only:** the catalog stores namespace names, kinds, timestamps, and
  resolved storage dirs. It NEVER holds raw memory content or secrets.
- **No authorization:** catalog presence grants *no* access. Read/write access
  still flows through namespace policies (`principalFromSessionKey*`,
  `namespacePolicies`). The catalog never makes an access decision.
- **Inert when disabled:** the catalog is a no-op (enumerates nothing, writes
  nothing) unless `namespacesEnabled: true`. Set `namespaceCatalogEnabled: false`
  to opt out even when namespaces are enabled. Single-namespace behavior is
  unchanged.

How namespaces are discovered:

- **config** — `default`, `shared`, and explicit `namespacePolicies` entries.
- **write / read** — recorded on hot-path writes and recall reads (best-effort;
  a catalog write failure never crashes the primary memory op).
- **scan** — `rebuild` walks `<memoryDir>/namespaces/<token>` directories,
  rejects/reports symlinked or escaping roots, decodes the namespace token, and
  infers each record's `kind` (`default`, `shared`, `project`, `branch`,
  `team-project`, `explicit`, `legacy`).

Rebuild from disk (dry-run first):

```bash
openclaw engram namespaces rebuild --dry-run   # show the plan, write nothing
openclaw engram namespaces rebuild --apply     # rewrite state/namespaces.jsonl
openclaw engram namespaces rebuild --apply --json
```

Rebuild preserves known metadata (timestamps, principal hints) where safe,
preserves the legacy/default-root compatibility case, and reports ambiguous
roots instead of silently misclassifying them.

## CLI

First-class namespace commands:

```bash
openclaw engram namespaces ls
openclaw engram namespaces verify
openclaw engram namespaces migrate --to default --dry-run
openclaw engram namespaces rebuild --dry-run
openclaw engram namespaces rebuild --apply
```

When namespaces are enabled, these commands also accept `--namespace <ns>`:

```bash
openclaw engram export --format json --out /tmp/engram-export --namespace shared
openclaw engram import --from /tmp/engram-export --format auto --namespace default
openclaw engram backup --out-dir /tmp/backups --namespace shared
```
