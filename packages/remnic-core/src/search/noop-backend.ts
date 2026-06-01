import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions, SearchResult } from "./port.js";

/**
 * No-op search backend for graceful degradation.
 * All searches return empty results; all maintenance is a no-op.
 */
export class NoopSearchBackend implements SearchBackend {
  async probe(): Promise<boolean> {
    return false;
  }

  isAvailable(): boolean {
    return false;
  }

  debugStatus(): string {
    return "backend=noop";
  }

  async search(
    _query: string,
    _collection?: string,
    _maxResults?: number,
    _options?: SearchQueryOptions,
    _execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    return [];
  }

  async searchGlobal(_query: string, _maxResults?: number, _execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return [];
  }

  async bm25Search(_query: string, _collection?: string, _maxResults?: number, _execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return [];
  }

  async vectorSearch(_query: string, _collection?: string, _maxResults?: number, _execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return [];
  }

  async hybridSearch(_query: string, _collection?: string, _maxResults?: number, _execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    return [];
  }

  async update(_execution?: SearchExecutionOptions): Promise<void> {}
  async updateCollection(_collection: string, _execution?: SearchExecutionOptions): Promise<void> {}
  updatesAllCollections(): boolean {
    return false;
  }
  async embed(): Promise<void> {}
  async embedCollection(_collection: string): Promise<void> {}

  async ensureCollection(_memoryDir: string, _execution?: SearchExecutionOptions): Promise<"skipped"> {
    return "skipped";
  }
}
