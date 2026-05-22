import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { log } from "../logger.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions, SearchResult } from "./port.js";
import type { EmbedHelper } from "./embed-helper.js";
import { scanMemoryDir } from "./document-scanner.js";
import { isSearchAborted, throwIfSearchAborted } from "./abort.js";

export interface OramaBackendOptions {
  dbPath: string;
  collection: string;
  embedHelper: EmbedHelper;
  memoryDir: string;
  embeddingDimension: number;
}

const ORAMA_COLLECTION_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveOramaCollectionDbFilePath(dbPath: string, collection: string): string {
  if (!ORAMA_COLLECTION_FILENAME_PATTERN.test(collection)) {
    throw new Error(
      `Invalid Orama collection name ${JSON.stringify(collection)}. ` +
        "Collection names must match [A-Za-z0-9][A-Za-z0-9._-]*.",
    );
  }
  const resolvedDbPath = path.resolve(dbPath);
  const filePath = path.resolve(resolvedDbPath, `${collection}.msp`);
  if (!pathIsInside(resolvedDbPath, filePath)) {
    throw new Error(
      `Invalid Orama collection path for ${JSON.stringify(collection)}: resolved outside dbPath.`,
    );
  }
  return filePath;
}

/**
 * Orama search backend — embedded hybrid FTS+vector, pure JS.
 *
 * Uses @orama/orama for full-text search with optional vector support.
 * Persists data to JSON files via @orama/plugin-data-persistence.
 */
export class OramaBackend implements SearchBackend {
  private readonly dbPath: string;
  private readonly collection: string;
  private readonly embedHelper: EmbedHelper;
  private readonly memoryDir: string;
  private readonly embeddingDimension: number;
  private available = false;
  private db: any = null;
  private oramaModule: any = null;
  private persistModule: any = null;

  constructor(opts: OramaBackendOptions) {
    this.dbPath = opts.dbPath;
    this.collection = opts.collection;
    this.embedHelper = opts.embedHelper;
    this.memoryDir = opts.memoryDir;
    this.embeddingDimension = opts.embeddingDimension;
  }

  async probe(): Promise<boolean> {
    try {
      await this.ensureModules();
      await this.ensureDb();
      this.available = true;
      return true;
    } catch (err) {
      log.debug(`OramaBackend probe failed: ${err}`);
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return `backend=orama available=${this.available} dbPath=${this.dbPath}`;
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
      throwIfSearchAborted(execution, "OramaBackend global search aborted");
      const files = await this.listDbFiles();
      const allResults: SearchResult[] = [];
      for (const file of files) {
        throwIfSearchAborted(execution, "OramaBackend global search aborted");
        const db = await this.loadDbFromFile(file);
        if (!db) continue;
        const results = await this.searchDb(db, query, "hybrid", limit, execution);
        allResults.push(...results);
      }
      allResults.sort((a, b) => b.score - a.score);
      return allResults.slice(0, limit);
    } catch (err) {
      log.debug(`OramaBackend searchGlobal failed: ${err}`);
      return [];
    }
  }

  async bm25Search(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    const db = await this.ensureDbForCollection(collection ?? this.collection);
    if (isSearchAborted(execution)) return [];
    if (!db) return [];
    return this.searchDb(db, query, "fulltext", maxResults ?? 10, execution);
  }

  async vectorSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    const db = await this.ensureDbForCollection(collection ?? this.collection);
    if (isSearchAborted(execution)) return [];
    if (!db) return [];
    return this.searchDb(db, query, "vector", maxResults ?? 10, execution);
  }

  async hybridSearch(query: string, collection?: string, maxResults?: number, execution?: SearchExecutionOptions): Promise<SearchResult[]> {
    if (isSearchAborted(execution)) return [];
    const db = await this.ensureDbForCollection(collection ?? this.collection);
    if (isSearchAborted(execution)) return [];
    if (!db) return [];
    return this.searchDb(db, query, "hybrid", maxResults ?? 10, execution);
  }

  async update(execution?: SearchExecutionOptions): Promise<void> {
    await this.updateCollection(this.collection, execution);
  }

  async updateCollection(collection: string, execution?: SearchExecutionOptions): Promise<void> {
    if (isSearchAborted(execution)) return;
    const db = await this.ensureDbForCollection(collection);
    if (isSearchAborted(execution)) return;
    if (!db) return;
    const { search: oramaSearch, insert, remove, count } = this.oramaModule;

    const docs = await scanMemoryDir(this.memoryDir);
    if (isSearchAborted(execution)) return;
    const docMap = new Map(docs.map((d) => [d.docid, d]));
    const { update: oramaUpdate } = this.oramaModule;

    // Get existing docs to diff — map user doc ID → { internalId, vector }
    const existingDocs = new Map<string, { internalId: string; vector?: number[] }>();
    const existingCount = await count(db);
    if (existingCount > 0) {
      const allHits = await oramaSearch(db, { term: "", limit: existingCount + 100 });
      for (const hit of allHits.hits) {
        if (isSearchAborted(execution)) return;
        if (!docMap.has(hit.document.id)) {
          await remove(db, hit.id);
        } else {
          existingDocs.set(hit.document.id, {
            internalId: hit.id,
            vector: hit.document.vector,
          });
        }
      }
    }

    // Insert new docs, update existing ones (preserving vectors since update is remove+insert)
    for (const doc of docs) {
      if (isSearchAborted(execution)) return;
      const existing = existingDocs.get(doc.docid);
      if (existing) {
        const payload: Record<string, unknown> = {
          id: doc.docid,
          path: doc.path,
          content: doc.content,
          snippet: doc.snippet,
        };
        if (existing.vector && existing.vector.length > 0) {
          payload.vector = existing.vector;
        }
        try {
          await oramaUpdate(db, existing.internalId, payload);
        } catch {
          // Update failed — skip and continue with remaining docs
        }
      } else {
        try {
          await insert(db, {
            id: doc.docid,
            path: doc.path,
            content: doc.content,
            snippet: doc.snippet,
          });
        } catch {
          // Duplicate id edge case — skip
        }
      }
    }

    if (isSearchAborted(execution)) return;
    await this.persistDbForCollection(db, collection);
  }

  async embed(): Promise<void> {
    await this.embedCollection(this.collection);
  }

  async embedCollection(collection: string): Promise<void> {
    if (!this.embedHelper.isAvailable()) return;

    const db = await this.ensureDbForCollection(collection);
    if (!db) return;
    const { search: oramaSearch, update: oramaUpdate, count } = this.oramaModule;

    const existingCount = await count(db);
    if (existingCount === 0) return;

    // Find docs without vectors
    const allHits = await oramaSearch(db, { term: "", limit: existingCount + 100 });
    const needsEmbed = allHits.hits.filter((h: any) => !h.document.vector || h.document.vector.length === 0);

    if (needsEmbed.length === 0) return;

    const texts = needsEmbed.map((h: any) => h.document.content as string);
    const vectors = await this.embedHelper.embedBatch(texts);

    for (let i = 0; i < needsEmbed.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      // Orama update is remove+insert — must include all fields to avoid data loss
      const doc = needsEmbed[i].document;
      await oramaUpdate(db, needsEmbed[i].id, {
        id: doc.id,
        path: doc.path,
        content: doc.content,
        snippet: doc.snippet,
        vector: vec,
      });
    }

    await this.persistDbForCollection(db, collection);
  }

  async ensureCollection(_memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped"> {
    try {
      await this.ensureModules();
      await this.ensureDb();
      return "present";
    } catch {
      return "missing";
    }
  }

  private async ensureModules(): Promise<void> {
    if (this.oramaModule && this.persistModule) return;
    this.oramaModule = await import("@orama/orama");
    this.persistModule = await import("@orama/plugin-data-persistence");
  }

  private async ensureDb(): Promise<any> {
    if (this.db) return this.db;
    await this.ensureModules();

    await mkdir(this.dbPath, { recursive: true });
    const filePath = this.dbFilePath(this.collection);

    try {
      const raw = await readFile(filePath, "utf-8");
      this.db = await this.persistModule.restore("json", raw);
      return this.db;
    } catch {
      // No existing DB — create fresh
    }

    const { create } = this.oramaModule;
    const schema: Record<string, string> = {
      id: "string",
      path: "string",
      content: "string",
      snippet: "string",
    };
    if (this.embedHelper.isAvailable()) {
      schema.vector = `vector[${this.embeddingDimension}]`;
    }
    this.db = await create({ schema });
    return this.db;
  }

  private async ensureDbForCollection(collection: string): Promise<any> {
    // For the default collection, use the cached instance
    if (collection === this.collection) return this.ensureDb();

    await this.ensureModules();
    await mkdir(this.dbPath, { recursive: true });
    const filePath = this.dbFilePath(collection);

    try {
      const raw = await readFile(filePath, "utf-8");
      return await this.persistModule.restore("json", raw);
    } catch {
      // No existing DB — create fresh
    }

    const { create } = this.oramaModule;
    const schema: Record<string, string> = {
      id: "string",
      path: "string",
      content: "string",
      snippet: "string",
    };
    if (this.embedHelper.isAvailable()) {
      schema.vector = `vector[${this.embeddingDimension}]`;
    }
    return await create({ schema });
  }

  private async persistDbForCollection(db: any, collection: string): Promise<void> {
    const data = await this.persistModule.persist(db, "json");
    const filePath = this.dbFilePath(collection);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data, "utf-8");
  }

  private dbFilePath(collection: string): string {
    return resolveOramaCollectionDbFilePath(this.dbPath, collection);
  }

  private async listDbFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.dbPath);
      return entries
        .filter((e) => e.endsWith(".msp"))
        .map((e) => path.join(this.dbPath, e));
    } catch {
      return [];
    }
  }

  private async loadDbFromFile(filePath: string): Promise<any> {
    try {
      await this.ensureModules();
      const raw = await readFile(filePath, "utf-8");
      return await this.persistModule.restore("json", raw);
    } catch {
      return null;
    }
  }

  private async searchDb(
    db: any,
    query: string,
    mode: "fulltext" | "vector" | "hybrid",
    limit: number,
    execution?: SearchExecutionOptions,
  ): Promise<SearchResult[]> {
    const { search: oramaSearch } = this.oramaModule;

    try {
      throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
      let searchParams: any;

      if (mode === "fulltext") {
        searchParams = { term: query, limit };
      } else if (mode === "vector") {
        const vec = await this.embedHelper.embed(query, { signal: execution?.signal });
        throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
        if (!vec) {
          // Fall back to fulltext if no embeddings available
          searchParams = { term: query, limit };
        } else {
          searchParams = { mode: "vector", vector: { value: vec, property: "vector" }, limit };
        }
      } else {
        // hybrid
        const vec = await this.embedHelper.embed(query, { signal: execution?.signal });
        throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
        if (!vec) {
          searchParams = { term: query, limit };
        } else {
          searchParams = { mode: "hybrid", term: query, vector: { value: vec, property: "vector" }, limit };
        }
      }

      throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
      const result = await oramaSearch(db, searchParams);
      throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
      return (result.hits ?? []).map((hit: any) => ({
        docid: hit.document?.id ?? "",
        path: hit.document?.path ?? "",
        snippet: hit.document?.snippet ?? hit.document?.content?.slice(0, 200) ?? "",
        score: hit.score ?? 0,
      }));
    } catch (err) {
      log.debug(`OramaBackend search (${mode}) failed: ${err}`);
      return [];
    }
  }
}
