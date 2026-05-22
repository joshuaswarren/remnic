import { log } from "../logger.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions, SearchResult } from "./port.js";
import { scanMemoryDir } from "./document-scanner.js";
import { isSearchAborted, throwIfSearchAborted } from "./abort.js";

export interface MeilisearchBackendOptions {
  host: string;
  apiKey?: string;
  collection: string;
  timeoutMs?: number;
  autoIndex?: boolean;
  memoryDir?: string;
}

/**
 * Meilisearch search backend — server-based SDK client.
 *
 * Requires a running Meilisearch instance. Uses the official `meilisearch` SDK.
 * When `autoIndex` is true, update() pushes docs from the local memory directory.
 */
export class MeilisearchBackend implements SearchBackend {
  private readonly host: string;
  private readonly apiKey?: string;
  private readonly collection: string;
  private readonly timeoutMs: number;
  private readonly autoIndex: boolean;
  private readonly memoryDir?: string;
  private available = false;
  private client: any = null;
  private meiliModule: any = null;

  constructor(opts: MeilisearchBackendOptions) {
    this.host = opts.host;
    this.apiKey = opts.apiKey;
    this.collection = opts.collection;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.autoIndex = opts.autoIndex ?? false;
    this.memoryDir = opts.memoryDir;
  }

  async probe(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      await client.health();
      this.available = true;
      return true;
    } catch (err) {
      log.debug(`MeilisearchBackend probe failed: ${err}`);
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return `backend=meilisearch available=${this.available} host=${this.host}`;
  }

  async search(
    query: string,
    collection?: string,
    maxResults?: number,
    _options?: SearchQueryOptions,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    // Try hybrid first; fall back to plain FTS only if hybrid throws (e.g. no embedder configured)
    try {
      return await this.doSearch(query, maxResults ?? 10, { hybrid: { semanticRatio: 0.5, embedder: "default" } }, collection, true, execution);
    } catch {
      if (isSearchAborted(execution)) return [];
      return this.bm25Search(query, collection, maxResults, execution);
    }
  }

  async searchGlobal(query: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    const limit = maxResults ?? 10;
    if (!this.available) return [];

    try {
      throwIfSearchAborted(execution, "MeilisearchBackend global search aborted");
      const client = await this.ensureClient();
      const indexes = await client.getIndexes();
      throwIfSearchAborted(execution, "MeilisearchBackend global search aborted");
      const queries = (indexes.results ?? []).map((idx: any) => ({
        indexUid: idx.uid,
        q: query,
        limit,
        showRankingScore: true,
      }));
      if (queries.length === 0) return [];

      const multiResult = await client.multiSearch({ queries });
      throwIfSearchAborted(execution, "MeilisearchBackend global search aborted");
      const allResults: SearchResult[] = [];
      for (const result of multiResult.results ?? []) {
        allResults.push(...this.mapHits(result.hits ?? []));
      }
      allResults.sort((a, b) => b.score - a.score);
      return allResults.slice(0, limit);
    } catch (err) {
      log.debug(`MeilisearchBackend searchGlobal failed: ${err}`);
      return [];
    }
  }

  async bm25Search(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.doSearch(query, maxResults ?? 10, undefined, collection, false, execution);
  }

  async vectorSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.doSearch(query, maxResults ?? 10, { hybrid: { semanticRatio: 1.0, embedder: "default" } }, collection, false, execution);
  }

  async hybridSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.doSearch(query, maxResults ?? 10, { hybrid: { semanticRatio: 0.5, embedder: "default" } }, collection, false, execution);
  }

  async update(execution?: SearchExecutionOptions): Promise<void> {
    await this.updateCollection(this.collection, execution);
  }

  async updateCollection(collection: string, execution?: SearchExecutionOptions): Promise<void> {
    if (!this.autoIndex || !this.memoryDir) return;
    if (!this.available) return;
    if (isSearchAborted(execution)) return;

    try {
      const client = await this.ensureClient();
      if (isSearchAborted(execution)) return;
      const docs = await scanMemoryDir(this.memoryDir);
      if (isSearchAborted(execution)) return;
      const index = client.index(collection);

      const meilDocs = docs.map((d) => ({
        id: d.docid,
        path: d.path,
        content: d.content,
        snippet: d.snippet,
      }));

      // Upsert current docs and wait for the task to complete
      if (isSearchAborted(execution)) return;
      const addTask = await index.addDocuments(meilDocs, { primaryKey: "id" });
      await client.waitForTask(addTask.taskUid, { timeOutMs: this.timeoutMs });
      if (isSearchAborted(execution)) return;

      // Remove docs that no longer exist on disk (paginated to handle large indexes)
      const currentIds = new Set(docs.map((d) => d.docid));
      try {
        const PAGE_SIZE = 1000;
        let offset = 0;
        let staleIds: string[] = [];
        let hasMore = true;
        while (hasMore) {
          if (isSearchAborted(execution)) return;
          const page = await index.getDocuments({ limit: PAGE_SIZE, offset, fields: ["id"] });
          const results = page.results ?? [];
          for (const doc of results) {
            const id = doc.id as string;
            if (!currentIds.has(id)) staleIds.push(id);
          }
          offset += results.length;
          hasMore = results.length === PAGE_SIZE;
        }
        if (staleIds.length > 0) {
          if (isSearchAborted(execution)) return;
          const delTask = await index.deleteDocuments(staleIds);
          await client.waitForTask(delTask.taskUid, { timeOutMs: this.timeoutMs });
        }
      } catch {
        // Deletion cleanup is best-effort
      }
    } catch (err) {
      log.debug(`MeilisearchBackend update failed: ${err}`);
    }
  }

  async embed(): Promise<void> {
    // Meilisearch handles its own embedding when configured with an embedder
  }

  async embedCollection(collection: string): Promise<void> {
    // Meilisearch handles its own embedding when configured with an embedder
    // The collection parameter is accepted for interface compliance but Meilisearch
    // manages embeddings server-side per index (collection).
  }

  async ensureCollection(_memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped"> {
    if (!this.available) return "skipped";
    try {
      const client = await this.ensureClient();
      try {
        await client.getIndex(this.collection);
        return "present";
      } catch {
        // Index doesn't exist — create it
        await client.createIndex(this.collection, { primaryKey: "id" });
        return "present";
      }
    } catch {
      return "skipped";
    }
  }

  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.meiliModule) {
      this.meiliModule = await import("meilisearch");
    }
    const MeiliSearch = this.meiliModule.MeiliSearch ?? this.meiliModule.default?.MeiliSearch;
    this.client = new MeiliSearch({
      host: this.host,
      apiKey: this.apiKey,
      timeout: this.timeoutMs,
    });
    return this.client;
  }

  private async doSearch(
    query: string,
    limit: number,
    extra?: Record<string, unknown>,
    collection?: string,
    rethrow = false,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    if (!this.available) return [];
    if (isSearchAborted(execution)) return [];
    try {
      const client = await this.ensureClient();
      throwIfSearchAborted(execution, "MeilisearchBackend search aborted");
      const index = client.index(collection ?? this.collection);
      const result = await index.search(query, { limit, showRankingScore: true, ...extra });
      throwIfSearchAborted(execution, "MeilisearchBackend search aborted");
      return this.mapHits(result.hits ?? []);
    } catch (err) {
      log.debug(`MeilisearchBackend search failed: ${err}`);
      if (rethrow) throw err;
      return [];
    }
  }

  private mapHits(hits: any[]): SearchResult[] {
    return hits.map((hit) => ({
      docid: hit.id ?? "",
      path: hit.path ?? "",
      snippet: hit._formatted?.content ?? hit.snippet ?? hit.content?.slice(0, 200) ?? "",
      score: hit._rankingScore ?? 0.5,
    }));
  }
}
