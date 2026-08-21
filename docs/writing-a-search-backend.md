# Writing a Search Backend

This guide walks you through implementing a custom search backend for Engram. The plugin uses a port/adapter pattern — all backends implement the same `SearchBackend` interface, making it straightforward to add new search engines.

## The SearchBackend Interface

Every backend must implement `SearchBackend` from `src/search/port.ts`:

```typescript
export interface SearchBackend {
  // ── Lifecycle ──
  probe(): Promise<boolean>;
  isAvailable(): boolean;
  debugStatus(): string;

  // ── Search ──
  search(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;
  searchGlobal(query: string, maxResults?: number): Promise<SearchResult[]>;
  bm25Search(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;
  vectorSearch(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;
  hybridSearch(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;

  // ── Maintenance ──
  update(): Promise<void>;
  updateCollection(collection: string): Promise<void>;
  embed(): Promise<void>;
  embedCollection(collection: string): Promise<void>;

  // ── Collection management ──
  ensureCollection(memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped">;
}
```

Results use the `SearchResult` type:

```typescript
interface SearchResult {
  docid: string;    // Document identifier
  path: string;     // File path
  snippet: string;  // Text snippet for display
  score: number;    // Relevance score (0.0–1.0)
}
```

## Method Contract

### Lifecycle

| Method | Purpose | Notes |
|--------|---------|-------|
| `probe()` | Test connectivity and initialize | Called on startup. Return `true` if ready, `false` otherwise. |
| `isAvailable()` | Synchronous availability check | Return cached result from last `probe()`. |
| `debugStatus()` | Human-readable status string | Used in `openclaw engram stats` output. |

### Search

All search methods must:
- Return `[]` (never throw) when the backend is unavailable
- Respect the `collection` parameter when provided (for tier migration support)
- Fall back to the default collection when `collection` is omitted
- Return results sorted by `score` descending

| Method | Behavior |
|--------|----------|
| `search()` | Primary search method. Engram calls this for recall. Use hybrid when available, fall back to BM25. |
| `searchGlobal()` | Search across ALL collections, not just the default. Merge and sort by score. |
| `bm25Search()` | Keyword/fulltext search only. |
| `vectorSearch()` | Vector similarity search only. Falls back to BM25 if no embeddings available. |
| `hybridSearch()` | Combined BM25 + vector search. Falls back to BM25 if no embeddings available. |

### Maintenance

| Method | Purpose |
|--------|---------|
| `update()` | Index documents from the memory directory into the search engine. |
| `updateCollection(collection)` | Same as `update()` but for a specific collection. |
| `embed()` | Compute and store vector embeddings for documents that don't have them. |
| `embedCollection(collection)` | Same as `embed()` but for a specific collection. |

For server-based backends (like Meilisearch) that handle their own embeddings, `embed()` and `embedCollection()` can be no-ops.

### Collection Management

| Method | Purpose |
|--------|---------|
| `ensureCollection(memoryDir)` | Verify or create the collection. Return `"present"`, `"missing"`, `"unknown"`, or `"skipped"`. |

## Step-by-Step Implementation

### 1. Create the Backend File

Create `src/search/my-backend.ts`:

```typescript
import { log } from "../logger.js";
import type { SearchBackend, SearchResult } from "./port.js";
import { scanMemoryDir } from "./document-scanner.js";

export interface MyBackendOptions {
  collection: string;
  memoryDir: string;
  // Add your backend-specific options
}

export class MyBackend implements SearchBackend {
  private available = false;
  private readonly collection: string;
  private readonly memoryDir: string;

  constructor(opts: MyBackendOptions) {
    this.collection = opts.collection;
    this.memoryDir = opts.memoryDir;
  }

  async probe(): Promise<boolean> {
    try {
      // Initialize your search engine here
      this.available = true;
      return true;
    } catch (err) {
      log.debug(`MyBackend probe failed: ${err}`);
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return `backend=my-backend available=${this.available}`;
  }

  // ... implement search and maintenance methods
}
```

### 2. Use the Document Scanner

The shared `scanMemoryDir()` function reads `.md` files from your memory directory and returns indexable documents:

```typescript
import { scanMemoryDir } from "./document-scanner.js";

async update(): Promise<void> {
  const docs = await scanMemoryDir(this.memoryDir);
  // docs is IndexableDocument[]:
  //   { docid, path, content, snippet }
  // Index these into your search engine
}
```

### 3. Use the Embed Helper (Optional)

If your backend supports vector search, use the shared `EmbedHelper`:

```typescript
import { EmbedHelper } from "./embed-helper.js";

// In constructor:
this.embedHelper = new EmbedHelper(config);

// Check availability:
if (this.embedHelper.isAvailable()) {
  const vector = await this.embedHelper.embed("text to embed");
  const vectors = await this.embedHelper.embedBatch(["text1", "text2"]);
}
```

The embed helper resolves providers automatically: OpenAI `text-embedding-3-small` or local LLM, depending on config.

### 4. Register in the Factory

Add your backend to `src/search/factory.ts`:

```typescript
import { MyBackend } from "./my-backend.js";

// In resolveNonQmdBackend():
if (backend === "my-backend") {
  return new MyBackend({
    collection: config.qmdCollection,
    memoryDir: config.memoryDir,
  });
}
```

### 5. Add Config Types

In `src/types.ts`, expand the `searchBackend` union:

```typescript
searchBackend?: "qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama" | "my-backend";
```

Add any backend-specific config keys to `PluginConfig`.

### 6. Update the Plugin Schema

Add your backend to `openclaw.plugin.json` under `configSchema.properties.searchBackend.enum` and add any new config properties. The schema uses `additionalProperties: false`, so missing properties will cause a gateway crash.

### 7. Add to Build Config

In `tsup.config.ts`, add any new npm packages to the `external` array:

```typescript
external: ["openclaw", "@lancedb/lancedb", "meilisearch", "@orama/orama", "my-search-lib"],
```

## Common Patterns

### Lazy Module Loading

Avoid importing heavy dependencies at module load time. Use dynamic imports:

```typescript
private myModule: any = null;

private async ensureModule(): Promise<void> {
  if (this.myModule) return;
  this.myModule = await import("my-search-lib");
}
```

### Graceful Degradation

All search methods should catch errors and return empty arrays, never throw:

```typescript
async search(query: string): Promise<SearchResult[]> {
  if (!this.available) return [];
  try {
    // ... search logic
  } catch (err) {
    log.debug(`MyBackend search failed: ${err}`);
    return [];
  }
}
```

### Vector Fallback to BM25

When embeddings aren't available, fall back gracefully:

```typescript
async hybridSearch(query: string): Promise<SearchResult[]> {
  const vec = await this.embedHelper.embed(query);
  if (!vec) {
    // No embeddings — fall back to fulltext only
    return this.bm25Search(query);
  }
  // ... hybrid search with vec
}
```

### Preserving Vectors During Updates

If your search engine's update operation is destructive (remove + insert, like Orama), make sure to preserve existing vectors:

```typescript
// Capture existing vectors before updating
const existingDoc = /* fetch from index */;
const payload = {
  id: doc.docid,
  content: doc.content,
  vector: existingDoc?.vector,  // Preserve!
};
await engine.update(payload);
```

## Testing

Add tests to `tests/search-backends.test.ts`. At minimum, test:

1. Factory creates your backend with the right config
2. `probe()` returns `true` when the engine is available
3. `search()` returns `[]` when unavailable
4. `update()` indexes documents from `scanMemoryDir()`

Example:

```typescript
test("factory creates MyBackend for 'my-backend' config", () => {
  const backend = createSearchBackend({
    ...defaultConfig,
    searchBackend: "my-backend",
  });
  assert.ok(backend instanceof MyBackend);
});
```

## Existing Backends as Reference

Study these implementations for patterns:

| File | Complexity | Good Reference For |
|------|-----------|-------------------|
| `src/search/noop-backend.ts` | Minimal | Interface contract, method signatures |
| `src/search/orama-backend.ts` | Medium | Embedded DB, document scanning, vector preservation |
| `src/search/meilisearch-backend.ts` | Medium | Server-based SDK, hybrid fallback, pagination |
| `src/search/lancedb-backend.ts` | High | Native bindings, RRF reranking, Arrow types |

## See Also

- [Search Backends](search-backends.md) — Overview of all built-in backends
- [Config Reference](config-reference.md) — All configuration settings
