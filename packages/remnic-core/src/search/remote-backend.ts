import { log } from "../logger.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions, SearchResult } from "./port.js";

export interface RemoteSearchBackendOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * HTTP REST search backend adapter.
 *
 * Delegates search to a remote service. Maintenance methods are no-ops
 * (remote backends manage their own indexing).
 */
export class RemoteSearchBackend implements SearchBackend {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private available = false;

  constructor(opts: RemoteSearchBackendOptions) {
    let url = opts.baseUrl;
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.available = res.ok;
      return this.available;
    } catch (err) {
      log.debug(`RemoteSearchBackend probe failed: ${err}`);
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return `backend=remote available=${this.available} baseUrl=${this.baseUrl}`;
  }

  async search(
    query: string,
    collection?: string,
    maxResults?: number,
    _options?: SearchQueryOptions,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    return this.post("/search/deep", { query, collection, maxResults }, execution);
  }

  async searchGlobal(query: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.post("/search/deep", { query, maxResults }, execution);
  }

  async bm25Search(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.post("/search/bm25", { query, collection, maxResults }, execution);
  }

  async vectorSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.post("/search/vector", { query, collection, maxResults }, execution);
  }

  async hybridSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return this.post("/search/hybrid", { query, collection, maxResults }, execution);
  }

  async update(_execution?: SearchExecutionOptions): Promise<void> {}
  async updateCollection(_collection: string, _execution?: SearchExecutionOptions): Promise<void> {}
  async embed(): Promise<void> {}
  async embedCollection(_collection: string): Promise<void> {}

  async ensureCollection(
    _memoryDir: string,
    _collectionOrExecution?: string | SearchExecutionOptions,
    _execution?: SearchExecutionOptions,
  ): Promise<"skipped"> {
    return "skipped";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async post(
    endpoint: string,
    body: Record<string, unknown>,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    if (!this.available) return [];
    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: execution?.signal
          ? AbortSignal.any([execution.signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        log.debug(`RemoteSearchBackend ${endpoint} returned ${res.status}`);
        return [];
      }
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data as SearchResult[];
    } catch (err) {
      log.debug(`RemoteSearchBackend ${endpoint} failed: ${err}`);
      return [];
    }
  }
}
