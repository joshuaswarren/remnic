# Search Backends

Engram v9 supports six search backends through a pluggable port/adapter architecture. Each backend implements the same `SearchBackend` interface, so switching engines requires only a config change — no code modifications.

## Choosing a Backend

| Backend | Dependencies | Setup | Search Quality | Best For |
|---------|-------------|-------|---------------|----------|
| **QMD** | QMD binary (2.1 GB models) | Medium | Highest (BM25 + vector + LLM reranking) | Production, best recall quality |
| **Orama** | None (pure JS) | Easy | Good (hybrid FTS + vector) | Quick start, no native deps |
| **LanceDB** | Native Arrow bindings | Medium | High (hybrid FTS + vector + RRF) | Large collections, fast vector search |
| **Meilisearch** | Running server | Medium | High (hybrid with server-side embeddings) | Shared search, multi-service |
| **Remote** | HTTP endpoint | Varies | Depends on service | Custom search infrastructure |
| **Noop** | None | None | None | Extraction-only mode |

## QMD (Default)

QMD provides the highest quality retrieval through hybrid BM25 + vector + LLM reranking. It's the default and recommended backend.

### Setup

Install QMD. Remnic currently supports QMD `2.5.1` and detects the installed
version with `qmd --version` at runtime:

```bash
npm install -g @tobilu/qmd@2.5.1
# or: bun install -g @tobilu/qmd@2.5.1
qmd --version
```

Add your memory directory to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Index the collection:

```bash
qmd update && qmd embed
```

### Config

```jsonc
{
  "searchBackend": "qmd",        // Default — can be omitted
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram",
  "qmdMaxResults": 8,
  "qmdSupportedVersion": "2.5.1",
  "qmdAutoUpgradeEnabled": false, // opt-in: npm install -g @tobilu/qmd@2.5.1
  "qmdChunkStrategy": "auto",
  // Leave qmdIndexName unset unless you intentionally use a separate QMD DB.
  // Existing Remnic/OpenClaw installs usually keep data in QMD's default "index".
  "qmdForceCpu": false,
  "qmdDaemonEnabled": true,      // Keep the shared MCP session warm for fast queries
  "qmdIntentHintsEnabled": false,
  "qmdExplainEnabled": false
}
```

When QMD `2.5.1` is installed, Remnic uses the newer capability set when
available: `qmd doctor` diagnostics, version-matched skill metadata, structured
MCP `lex`/`vec`/`hyde` searches, candidate-limit forwarding, rerank toggles,
AST-aware chunking for CLI/embed paths, scoped collection embedding, model/env
overrides (`QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, `QMD_GENERATE_MODEL`,
`QMD_FORCE_CPU`, `QMD_LLAMA_GPU`, `QMD_EMBED_PARALLELISM`), named index selection
via `qmdIndexName`, and absolute snippet line numbers. Older QMD installs
continue to work with unsupported flags omitted.

Do not set `qmdIndexName` during upgrades unless you have confirmed the existing
QMD data lives in that named index. QMD's default index is named `index` and is
stored at `~/.cache/qmd/index.sqlite`; changing `qmdIndexName` to a new value
creates or selects a different SQLite database, which can make existing memories
appear missing even though the old QMD database is still intact. Before changing
it, compare `qmd collection list` or inspect `~/.cache/qmd/*.sqlite` and preserve
the index that contains the current `openclaw-engram*` collections.

Auto-upgrade is intentionally disabled by default. Set
`qmdAutoUpgradeEnabled: true` to let Remnic upgrade PATH/fallback QMD installs to
`qmdSupportedVersion`. Remnic does not auto-upgrade an explicitly configured
`qmdPath`; install the supported package manually for that path.

QMD version coverage:

| QMD version | Remnic behavior |
|-------------|-----------------|
| `2.0.0` | Uses the v2 MCP `query` tool shape and unified search semantics; legacy `search`/`vsearch` daemon tools are avoided. |
| `2.0.1` | Detects the skill-install generation, but leaves user/global agent skill installation explicit. |
| `2.1.0` | Enables AST chunk strategy on CLI/embed paths, rerank toggles, candidate limits, per-collection model config compatibility, and JSON line capture. |
| `2.5.1` | Enables doctor/status diagnostics, version-matched skills, structured MCP `lex`/`vec`/`hyde` searches, absolute snippet lines, scoped embed behavior, and QMD model/GPU env controls. |

### QMD Daemon Mode

For lower latency, Engram prefers a shared stdio `qmd mcp` session when QMD is healthy. It does not currently talk to the HTTP daemon endpoint directly, even though the legacy `qmdDaemonUrl` setting is still retained for compatibility.

Engram automatically prefers the shared MCP session when available and falls back to subprocess calls on empty results, timeouts, or transport failure.

| Setting | Default | Description |
|---------|---------|-------------|
| `qmdDaemonEnabled` | `true` | Prefer the shared MCP/daemon path for search when available |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | Legacy compatibility knob retained in config; current runtime uses shared stdio MCP |
| `qmdDaemonRecheckIntervalMs` | `60000` | Re-probe interval after failure |
| `qmdIntentHintsEnabled` | `false` | Forward inferred recall intent into QMD unified search when supported |
| `qmdExplainEnabled` | `false` | Capture QMD explain traces into `memory_qmd_debug` snapshots |
| `qmdSupportedVersion` | `2.5.1` | Highest QMD version this Remnic build will auto-install |
| `qmdAutoUpgradeEnabled` | `false` | Opt-in auto-upgrade for PATH/fallback QMD installs |
| `qmdAutoUpgradeCheckIntervalMs` | `86400000` | Minimum interval between auto-upgrade attempts |
| `qmdChunkStrategy` | `auto` | Forward QMD's AST-aware chunk strategy when supported |
| `qmdCandidateLimit` | `(none)` | Optional QMD candidate limit forwarded when supported |
| `qmdQueryRerankEnabled` | `true` | Set `false` to pass QMD's rerank-disable flag when supported |

## Orama

Orama is an embedded, pure JavaScript search engine with hybrid FTS + vector support. Zero native dependencies — the easiest backend to get running.

### Config

```jsonc
{
  "searchBackend": "orama"
}
```

That's all you need. Engram handles database creation, document indexing, and persistence automatically.

### How It Works

- Database files stored at `{oramaDbPath}/{collection}.msp` (JSON format)
- `update()` scans your memory directory for `.md` files, diffs against the index, and upserts changes
- `embed()` computes vectors for documents missing them (requires an embedding provider)
- Search modes: fulltext (BM25), vector, or hybrid (combines both)

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `oramaDbPath` | `{memoryDir}/orama` | Database storage directory |
| `oramaEmbeddingDimension` | `1536` | Vector dimension (match your embedding model) |

### Embedding Support

For vector and hybrid search, Orama needs an embedding provider. Without one, it falls back to fulltext (BM25) search only.

Configure embedding via the shared embed helper:

```jsonc
{
  "searchBackend": "orama",
  "embeddingFallbackEnabled": true,
  "embeddingFallbackProvider": "auto",   // "openai", "local", or "auto"
  "openaiApiKey": "${OPENAI_API_KEY}"    // For OpenAI embeddings
}
```

## LanceDB

LanceDB is an embedded vector database with native Apache Arrow bindings. It excels at large collections and fast vector similarity search, with built-in RRF (Reciprocal Rank Fusion) reranking for hybrid queries.

### Config

```jsonc
{
  "searchBackend": "lancedb"
}
```

### How It Works

- Database stored at `{lanceDbPath}` directory (Arrow format)
- One table per collection with columns: `docid`, `path`, `content`, `snippet`, `vector`
- Hybrid search combines FTS and vector results with `RRFReranker`
- FTS index auto-created on the `content` column

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lanceDbPath` | `{memoryDir}/lancedb` | Database directory |
| `lanceEmbeddingDimension` | `1536` | Vector dimension |

### Notes

- Requires native bindings (`@lancedb/lancedb`) — may need compilation on some platforms
- Best choice for collections with 10,000+ memories where vector search speed matters
- Embedding configuration is the same as Orama (shared `EmbedHelper`)

## Meilisearch

Meilisearch is a server-based search engine with built-in hybrid search. Use it when you want a shared search service accessible by multiple processes or services.

### Prerequisites

Run a Meilisearch instance:

```bash
docker run -p 7700:7700 getmeili/meilisearch:latest
```

### Config

```jsonc
{
  "searchBackend": "meilisearch",
  "meilisearchHost": "http://localhost:7700",
  "meilisearchAutoIndex": true
}
```

### How It Works

- Connects to a running Meilisearch server via the official SDK
- When `autoIndex` is enabled, `update()` pushes documents from your memory directory to Meilisearch
- Hybrid search uses Meilisearch's built-in embedder (configure on the server side)
- Falls back to BM25-only search if no embedder is configured on the server

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `meilisearchHost` | `http://localhost:7700` | Meilisearch server URL |
| `meilisearchApiKey` | `(none)` | API key for authentication |
| `meilisearchTimeoutMs` | `30000` | Request timeout |
| `meilisearchAutoIndex` | `false` | Auto-push documents on update |

### Meilisearch Embedder Setup

For hybrid/vector search, configure an embedder on your Meilisearch instance:

```bash
curl -X PATCH 'http://localhost:7700/indexes/openclaw-engram/settings' \
  -H 'Content-Type: application/json' \
  --data '{
    "embedders": {
      "default": {
        "source": "openAi",
        "apiKey": "YOUR_KEY",
        "model": "text-embedding-3-small",
        "dimensions": 1536
      }
    }
  }'
```

## Remote

The Remote backend sends search requests to an HTTP REST endpoint. Use it to integrate with custom search infrastructure.

### Config

```jsonc
{
  "searchBackend": "remote",
  "remoteSearchBaseUrl": "https://your-search-service.example.com",
  "remoteSearchApiKey": "your-api-key"
}
```

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteSearchBaseUrl` | `http://localhost:8181` | Search service URL |
| `remoteSearchApiKey` | `(none)` | API key for authentication |
| `remoteSearchTimeoutMs` | `30000` | Request timeout |

## Noop

The Noop backend disables search entirely. Engram still extracts and stores memories, but recall returns no search results. Useful for extraction-only setups or testing.

```jsonc
{
  "searchBackend": "noop"
}
```

## Switching Backends

Switching backends is a config-only change. Your memory files are always plain markdown on disk — no data migration needed.

1. Update `searchBackend` in your config
2. Add any backend-specific settings
3. Restart the gateway: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`
4. Run `openclaw engram stats` to verify the new backend is active

Embedded backends (Orama, LanceDB) will automatically index your existing memory files on the next update cycle.

## Global Search

All backends support `searchGlobal()`, which searches across all collections (not just the default one). This is used by Engram's cross-collection recall when hot/cold tiering or conversation indexing is enabled.

- **QMD**: Searches all configured QMD collections
- **Orama**: Scans all `.msp` files in the database directory
- **LanceDB**: Queries all tables in the database
- **Meilisearch**: Uses `multiSearch` across all server indexes

## See Also

- [Writing a Search Backend](writing-a-search-backend.md) — Implement your own adapter
- [Config Reference](config-reference.md) — All search-related settings
- [Architecture Overview](architecture/overview.md) — How search fits into the recall pipeline
