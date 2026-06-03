import { log } from "../logger.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions, SearchResult } from "./port.js";
import type { EmbedHelper, EmbedProviderIdentity } from "./embed-helper.js";
import { scanMemoryDir } from "./document-scanner.js";
import { isSearchAborted, throwIfSearchAborted } from "./abort.js";

export interface LanceDbBackendOptions {
  dbPath: string;
  collection: string;
  embedHelper: EmbedHelper;
  memoryDir: string;
  embeddingDimension: number;
}

/**
 * LanceDB search backend — embedded hybrid FTS+vector with RRF reranking.
 *
 * Uses @lancedb/lancedb for native Arrow-backed storage.
 * One table per collection. Supports full-text, vector, and hybrid search.
 */
export class LanceDbBackend implements SearchBackend {
  private readonly dbPath: string;
  private readonly collection: string;
  private readonly embedHelper: EmbedHelper;
  private readonly memoryDir: string;
  private readonly embeddingDimension: number;
  private available = false;
  private db: any = null;
  private lanceModule: any = null;
  private readonly vectorProviderCompatibility = new WeakMap<
    object,
    { providerIdentity: EmbedProviderIdentity; compatible: boolean }
  >();

  constructor(opts: LanceDbBackendOptions) {
    this.dbPath = opts.dbPath;
    this.collection = opts.collection;
    this.embedHelper = opts.embedHelper;
    this.memoryDir = opts.memoryDir;
    this.embeddingDimension = opts.embeddingDimension;
  }

  async probe(): Promise<boolean> {
    try {
      await this.ensureDb();
      this.available = true;
      return true;
    } catch (err) {
      log.debug(`LanceDbBackend probe failed: ${err}`);
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return `backend=lancedb available=${this.available} dbPath=${this.dbPath}`;
  }

  async search(
    query: string,
    _collection?: string,
    maxResults?: number,
    _options?: SearchQueryOptions,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    return this.hybridSearch(query, _collection, maxResults, execution);
  }

  async searchGlobal(query: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    const limit = maxResults ?? 10;
    if (!this.available) return [];

    try {
      throwIfSearchAborted(execution, "LanceDbBackend global search aborted");
      const db = await this.ensureDb();
      const tableNames = await db.tableNames();
      const allResults: SearchResult[] = [];

      for (const name of tableNames) {
        throwIfSearchAborted(execution, "LanceDbBackend global search aborted");
        try {
          const table = await db.openTable(name);
          const results = await this.searchTable(table, query, "hybrid", limit, execution);
          allResults.push(...results);
        } catch {
          // Skip tables that fail
        }
      }

      allResults.sort((a, b) => b.score - a.score);
      return allResults.slice(0, limit);
    } catch (err) {
      log.debug(`LanceDbBackend searchGlobal failed: ${err}`);
      return [];
    }
  }

  async bm25Search(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    const table = await this.ensureTableForCollection(collection ?? this.collection);
    if (isSearchAborted(execution)) return [];
    if (!table) return [];
    return this.searchTable(table, query, "fts", maxResults ?? 10, execution);
  }

  async vectorSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    const table = await this.ensureTableForCollection(collection ?? this.collection);
    if (isSearchAborted(execution)) return [];
    if (!table) return [];
    return this.searchTable(table, query, "vector", maxResults ?? 10, execution);
  }

  async hybridSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    const table = await this.ensureTableForCollection(collection ?? this.collection);
    if (isSearchAborted(execution)) return [];
    if (!table) return [];
    return this.searchTable(table, query, "hybrid", maxResults ?? 10, execution);
  }

  async update(execution?: SearchExecutionOptions): Promise<void> {
    await this.updateCollection(this.collection, execution);
  }

  async updateCollection(collection: string, execution?: SearchExecutionOptions): Promise<void> {
    if (isSearchAborted(execution)) return;
    let table = await this.ensureTableForCollection(collection);
    if (isSearchAborted(execution)) return;
    if (!table) return;

    const docs = await scanMemoryDir(this.memoryDir);
    if (isSearchAborted(execution)) return;
    if (docs.length === 0) {
      // Clear stale data when no docs remain
      try {
        const db = await this.ensureDb();
        await db.dropTable(collection).catch(() => {});
        if (collection === this.collection) this.table = null;
      } catch {
        // Best-effort cleanup
      }
      return;
    }

    const embeddingProviderIdentity = this.embedHelper.getProviderIdentity();
    const existingVectors = new Map<string, {
      vector: number[];
      providerIdentity?: string;
    }>();
    const hasVectorProviderColumn = await this.tableHasVectorProviderColumn(table);
    if (!hasVectorProviderColumn) {
      table = await this.recreateTableForCollection(collection);
      if (isSearchAborted(execution)) return;
      if (!table) return;
    } else {
      try {
        const existingRows = await table.query().select(["docid", "vector", "vectorProvider"]).toArray();
        for (const row of existingRows ?? []) {
          if (isSearchAborted(execution)) return;
          const docid = row.docid;
          if (typeof docid !== "string") continue;
          const vector = row.vector;
          if (!vector || typeof vector !== "object") continue;
          existingVectors.set(docid, {
            vector: Array.from(vector as ArrayLike<number>),
            providerIdentity: typeof row.vectorProvider === "string" ? row.vectorProvider : undefined,
          });
        }
      } catch {
        // Vector preservation is best-effort; refresh can proceed without it.
      }
    }

    const rows = docs.map((d) => {
      const existing = existingVectors.get(d.docid);
      const canPreserveVector =
        existing &&
        existing.vector.length === this.embeddingDimension &&
        (!embeddingProviderIdentity ||
          existing.providerIdentity === embeddingProviderIdentity);
      return {
        docid: d.docid,
        path: d.path,
        content: d.content,
        snippet: d.snippet,
        vector: canPreserveVector
          ? existing.vector
          : new Array(this.embeddingDimension).fill(0),
        vectorProvider: canPreserveVector
          ? existing.providerIdentity ?? ""
          : "",
      };
    });

    try {
      if (isSearchAborted(execution)) return;
      await table.add(rows, { mode: "overwrite" });
      this.rememberVectorProviderCompatibility(
        table,
        embeddingProviderIdentity,
        rows.length > 0 && rows.every((row) => row.vectorProvider === embeddingProviderIdentity),
      );
      if (isSearchAborted(execution)) return;
      // Create FTS index on content column
      try {
        await table.createIndex("content", { config: this.lanceIndex.fts() });
      } catch {
        // FTS index creation may fail on some platforms — degrade gracefully
      }
      if (collection === this.collection) this.table = table;
    } catch (err) {
      log.debug(`LanceDbBackend update failed: ${err}`);
    }
  }

  async embed(): Promise<void> {
    await this.embedCollection(this.collection);
  }

  async embedCollection(collection: string): Promise<void> {
    if (!this.embedHelper.isAvailable()) return;

    const table = await this.ensureTableForCollection(collection);
    if (!table) return;

    try {
      const embeddingProviderIdentity = this.embedHelper.getProviderIdentity();
      const allRows = await table.query().select(["docid", "content", "vector", "vectorProvider"]).toArray();
      const needsEmbed = allRows.filter((row: any) => {
        if (embeddingProviderIdentity && row.vectorProvider !== embeddingProviderIdentity) {
          return true;
        }
        const vec = row.vector;
        if (!vec || (typeof vec !== "object")) return true;
        // Support both Array and typed arrays (e.g. Float32Array from Arrow)
        const arr = Array.from(vec as ArrayLike<number>);
        return (
          arr.length === 0 ||
          arr.length !== this.embeddingDimension ||
          arr.every((v: number) => v === 0)
        );
      });

      if (needsEmbed.length === 0) {
        this.rememberVectorProviderCompatibility(table, embeddingProviderIdentity, true);
        return;
      }

      const texts = needsEmbed.map((row: any) => row.content as string);
      const embedResult = await this.embedHelper.embedBatchWithProvider(texts);
      if (!embedResult) return;
      const { vectors, providerIdentity } = embedResult;

      let allEmbedded = true;
      for (let i = 0; i < needsEmbed.length; i++) {
        const vec = vectors[i];
        if (!this.isExpectedDimensionVector(vec)) {
          allEmbedded = false;
          continue;
        }
        const docid = needsEmbed[i].docid;
        await table.update({
          where: `docid = '${docid.replace(/'/g, "''")}'`,
          values: { vector: vec, vectorProvider: providerIdentity },
        });
      }
      this.rememberVectorProviderCompatibility(table, providerIdentity, allEmbedded);
    } catch (err) {
      log.debug(`LanceDbBackend embed failed: ${err}`);
    }
  }

  async ensureCollection(
    _memoryDir: string,
    _execution?: SearchExecutionOptions,
  ): Promise<"present" | "missing" | "unknown" | "skipped"> {
    try {
      await this.ensureTable();
      return "present";
    } catch {
      return "missing";
    }
  }

  private table: any = null;

  private get lanceIndex(): any {
    return this.lanceModule.Index ?? this.lanceModule.default?.Index;
  }

  private async ensureDb(): Promise<any> {
    if (this.db) return this.db;
    if (!this.lanceModule) {
      this.lanceModule = await import("@lancedb/lancedb");
    }
    const connect = this.lanceModule.connect ?? this.lanceModule.default?.connect;
    this.db = await connect(this.dbPath);
    return this.db;
  }

  private async ensureTableForCollection(collection: string): Promise<any> {
    // For the default collection, use the cached instance
    if (collection === this.collection) return this.ensureTable();

    const db = await this.ensureDb();
    const tables = await db.tableNames();

    if (tables.includes(collection)) {
      return await db.openTable(collection);
    }

    // Create empty table with schema
    const emptyRow = {
      docid: "__placeholder__",
      path: "",
      content: "",
      snippet: "",
      vector: new Array(this.embeddingDimension).fill(0),
      vectorProvider: "",
    };
    const newTable = await db.createTable(collection, [emptyRow]);
    try {
      await newTable.createIndex("content", { config: this.lanceIndex.fts() });
    } catch {
      // FTS index creation may fail — degrade gracefully
    }
    try {
      await newTable.delete("docid = '__placeholder__'");
    } catch {
      // May fail if delete isn't supported on empty-ish tables
    }
    return newTable;
  }

  private async recreateTableForCollection(collection: string): Promise<any> {
    const db = await this.ensureDb();
    try {
      await db.dropTable(collection).catch(() => {});
    } catch {
      // Best-effort legacy schema migration; table creation below may still recover.
    }
    if (collection === this.collection) this.table = null;
    return this.ensureTableForCollection(collection);
  }

  private async tableHasVectorProviderColumn(table: any): Promise<boolean> {
    try {
      await table.query().select(["vectorProvider"]).toArray();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureTable(): Promise<any> {
    if (this.table) return this.table;

    const db = await this.ensureDb();
    const tables = await db.tableNames();

    if (tables.includes(this.collection)) {
      this.table = await db.openTable(this.collection);
      return this.table;
    }

    // Create empty table with schema
    const emptyRow = {
      docid: "__placeholder__",
      path: "",
      content: "",
      snippet: "",
      vector: new Array(this.embeddingDimension).fill(0),
      vectorProvider: "",
    };
    this.table = await db.createTable(this.collection, [emptyRow]);
    // Create FTS index on content column
    try {
      await this.table.createIndex("content", { config: this.lanceIndex.fts() });
    } catch {
      // FTS index creation may fail — degrade gracefully
    }
    // Remove placeholder row
    try {
      await this.table.delete("docid = '__placeholder__'");
    } catch {
      // May fail if delete isn't supported on empty-ish tables
    }
    return this.table;
  }

  private async searchTable(
    table: any,
    query: string,
    mode: "fts" | "vector" | "hybrid",
    limit: number,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    try {
      throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
      if (mode === "fts") {
        const results = await table.search(query, "fts").limit(limit).toArray();
        throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
        return this.mapRows(results);
      }

      if (mode === "vector") {
        const embedResult = await this.embedHelper.embedWithProvider(query, { signal: execution?.signal });
        throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
        if (
          !embedResult ||
          !this.isExpectedDimensionVector(embedResult.vector) ||
          !(await this.tableHasCompatibleVectors(table, embedResult.providerIdentity, execution))
        ) {
          // Fall back to FTS
          const results = await table.search(query, "fts").limit(limit).toArray();
          throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
          return this.mapRows(results);
        }
        const results = await table.search(embedResult.vector).limit(limit).toArray();
        throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
        return this.mapRows(results);
      }

      // hybrid — try FTS+vector with RRF reranking
      const embedResult = await this.embedHelper.embedWithProvider(query, { signal: execution?.signal });
      throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
      if (
        !embedResult ||
        !this.isExpectedDimensionVector(embedResult.vector) ||
        !(await this.tableHasCompatibleVectors(table, embedResult.providerIdentity, execution))
      ) {
        const results = await table.search(query, "fts").limit(limit).toArray();
        throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
        return this.mapRows(results);
      }

      try {
        const results = await table
          .search(query, "hybrid")
          .vector(embedResult.vector)
          .limit(limit)
          .toArray();
        throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
        return this.mapRows(results);
      } catch {
        // Hybrid may not be supported in all LanceDB versions — fall back to vector
        const results = await table.search(embedResult.vector).limit(limit).toArray();
        throwIfSearchAborted(execution, `LanceDbBackend ${mode} search aborted`);
        return this.mapRows(results);
      }
    } catch (err) {
      log.debug(`LanceDbBackend search (${mode}) failed: ${err}`);
      return [];
    }
  }

  private mapRows(rows: any[]): SearchResult[] {
    return (rows ?? [])
      .filter((row) => row.docid && row.docid !== "__placeholder__")
      .map((row) => ({
        docid: row.docid ?? "",
        path: row.path ?? "",
        snippet: row.snippet ?? row.content?.slice(0, 200) ?? "",
        score: row._relevance_score ?? (row._distance != null ? 1 / (1 + (row._distance ?? 0)) : 0.5),
      }));
  }

  private async tableHasCompatibleVectors(
    table: any,
    providerIdentity: EmbedProviderIdentity,
    execution?: SearchExecutionOptions,
  ): Promise<boolean> {
    try {
      const cached = this.vectorProviderCompatibility.get(table);
      if (cached?.providerIdentity === providerIdentity) return cached.compatible;
      const rows = await table.query().select(["vectorProvider"]).toArray();
      let compatible = rows.length > 0;
      for (const row of rows ?? []) {
        throwIfSearchAborted(execution, "LanceDbBackend vector provider check aborted");
        if (row.vectorProvider !== providerIdentity) {
          compatible = false;
          break;
        }
      }
      this.vectorProviderCompatibility.set(table, { providerIdentity, compatible });
      return compatible;
    } catch (err) {
      if (isSearchAborted(execution)) throw err;
      log.debug(`LanceDbBackend vector provider check failed: ${err}`);
      return false;
    }
  }

  private rememberVectorProviderCompatibility(
    table: unknown,
    providerIdentity: EmbedProviderIdentity | null,
    compatible: boolean,
  ): void {
    if (!providerIdentity || !table || typeof table !== "object") return;
    this.vectorProviderCompatibility.set(table, { providerIdentity, compatible });
  }

  private isExpectedDimensionVector(vector: number[] | null | undefined): vector is number[] {
    return Array.isArray(vector) && vector.length === this.embeddingDimension;
  }
}
