import path from "node:path";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { log } from "../logger.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions, SearchResult } from "./port.js";
import type { EmbedHelper, EmbedProviderIdentity, EmbedWithProviderResult } from "./embed-helper.js";
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
  private readonly vectorProviderCompatibility = new WeakMap<
    object,
    { providerIdentity: EmbedProviderIdentity; compatible: boolean }
  >();

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
    await this.updateCollectionFromDir(collection, this.memoryDir, execution);
  }

  async updateCollectionFromDir(collection: string, memoryDir: string, execution?: SearchExecutionOptions): Promise<void> {
    if (isSearchAborted(execution)) return;
    const db = await this.ensureDbForCollection(collection);
    if (isSearchAborted(execution)) return;
    if (!db) return;
    const { search: oramaSearch, insert, remove, count, getByID } = this.oramaModule;

    const docs = await scanMemoryDir(memoryDir);
    if (isSearchAborted(execution)) return;
    const docMap = new Map(docs.map((d) => [d.docid, d]));
    const { update: oramaUpdate } = this.oramaModule;

    const embeddingProviderIdentity = this.embedHelper.getProviderIdentity();
    let allRowsCompatible = !!embeddingProviderIdentity && docs.length > 0;
    // Get existing docs to diff — map user doc ID → { internalId, vector }
    const existingDocs = new Map<string, {
      internalId: string;
      vector?: number[];
      vectorProvider?: string;
    }>();
    const existingCount = await count(db);
    if (existingCount > 0) {
      const allHits = await oramaSearch(db, {
        term: "",
        limit: existingCount + 100,
      });
      for (const hit of allHits.hits) {
        if (isSearchAborted(execution)) return;
        const storedDocument =
          typeof getByID === "function"
            ? await getByID(db, hit.id)
            : hit.document;
        const document = storedDocument ?? hit.document ?? {};
        if (!docMap.has(document.id)) {
          await remove(db, hit.id);
        } else {
          existingDocs.set(document.id, {
            internalId: hit.id,
            vector: this.normalizeStoredVector(document.vector) ?? undefined,
            vectorProvider:
              typeof document.vectorProvider === "string"
                ? document.vectorProvider
                : undefined,
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
        const preservesCompatibleProvider =
          !!embeddingProviderIdentity &&
          existing.vectorProvider === embeddingProviderIdentity;
        if (preservesCompatibleProvider) {
          if (this.isCompatibleStoredVector(existing.vector)) {
            payload.vector = existing.vector;
            payload.vectorProvider = existing.vectorProvider ?? "";
          } else {
            payload.vector = this.zeroVector();
            payload.vectorProvider = "";
            allRowsCompatible = false;
          }
        } else if (!embeddingProviderIdentity && this.isCompatibleStoredVector(existing.vector)) {
          payload.vector = existing.vector;
          payload.vectorProvider = existing.vectorProvider ?? "";
          allRowsCompatible = false;
        } else {
          payload.vector = this.zeroVector();
          payload.vectorProvider = "";
          allRowsCompatible = false;
        }
        try {
          await oramaUpdate(db, existing.internalId, payload);
        } catch {
          allRowsCompatible = false;
          // Update failed — skip and continue with remaining docs
        }
      } else {
        allRowsCompatible = false;
        try {
          await insert(db, {
            id: doc.docid,
            path: doc.path,
            content: doc.content,
            snippet: doc.snippet,
            vector: this.zeroVector(),
            vectorProvider: "",
          });
        } catch {
          allRowsCompatible = false;
          // Duplicate id edge case — skip
        }
      }
    }

    if (isSearchAborted(execution)) return;
    await this.persistDbForCollection(db, collection);
    this.rememberVectorProviderCompatibility(
      db,
      embeddingProviderIdentity,
      allRowsCompatible,
    );
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

    const embeddingProviderIdentity = this.embedHelper.getProviderIdentity();
    // Find docs without vectors or with vectors from a different provider.
    const allHits = await oramaSearch(db, { term: "", limit: existingCount + 100 });
    const needsEmbed = allHits.hits.filter((h: any) => {
      const vector = this.normalizeStoredVector(h.document?.vector);
      return (
        (embeddingProviderIdentity &&
          h.document?.vectorProvider !== embeddingProviderIdentity) ||
        !this.isCompatibleStoredVector(vector)
      );
    });

    if (needsEmbed.length === 0) {
      this.rememberVectorProviderCompatibility(db, embeddingProviderIdentity, true);
      return;
    }

    let rowsToEmbed = needsEmbed;
    let embedResult = await this.embedHelper.embedBatchWithProvider(
      rowsToEmbed.map((h: any) => h.document.content as string),
    );
    if (!embedResult) return;
    if (
      embeddingProviderIdentity &&
      embedResult.providerIdentity !== embeddingProviderIdentity
    ) {
      const effectiveProviderIdentity = embedResult.providerIdentity;
      const originalIds = new Set(rowsToEmbed.map((h: any) => h.id));
      const effectiveNeedsEmbed = allHits.hits.filter((h: any) => {
        const vector = this.normalizeStoredVector(h.document?.vector);
        return (
          h.document?.vectorProvider !== effectiveProviderIdentity ||
          !this.isCompatibleStoredVector(vector)
        );
      });
      const sameRows =
        effectiveNeedsEmbed.length === rowsToEmbed.length &&
        effectiveNeedsEmbed.every((h: any) => originalIds.has(h.id));
      if (!sameRows) {
        const effectiveTexts = effectiveNeedsEmbed.map((h: any) => h.document.content as string);
        const effectiveEmbedResult = await this.embedHelper.embedBatchWithProvider(effectiveTexts);
        if (effectiveEmbedResult) {
          rowsToEmbed = effectiveNeedsEmbed;
          embedResult = effectiveEmbedResult;
        }
      }
    }
    const { vectors, providerIdentity } = embedResult;

    let allEmbedded = true;
    for (let i = 0; i < rowsToEmbed.length; i++) {
      const vec = vectors[i];
      if (!this.isExpectedDimensionVector(vec)) {
        allEmbedded = false;
        continue;
      }
      // Orama update is remove+insert — must include all fields to avoid data loss
      const doc = rowsToEmbed[i].document;
      await oramaUpdate(db, rowsToEmbed[i].id, {
        id: doc.id,
        path: doc.path,
        content: doc.content,
        snippet: doc.snippet,
        vector: vec,
        vectorProvider: providerIdentity,
      });
    }

    await this.persistDbForCollection(db, collection);
    if (allEmbedded) {
      this.rememberVectorProviderCompatibility(db, providerIdentity, true);
    } else {
      this.rememberVectorProviderCompatibility(db, providerIdentity, false);
    }
  }

  async ensureCollection(
    _memoryDir: string,
    _execution?: SearchExecutionOptions,
  ): Promise<"present" | "missing" | "unknown" | "skipped"> {
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

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      // No existing DB — create fresh
      this.db = await this.createDb();
      return this.db;
    }

    this.db = await this.migrateLegacyVectorProviderSchema(
      await this.persistModule.restore("json", raw),
      this.collection,
    );
    return this.db;
  }

  private async ensureDbForCollection(collection: string): Promise<any> {
    // For the default collection, use the cached instance
    if (collection === this.collection) return this.ensureDb();

    await this.ensureModules();
    await mkdir(this.dbPath, { recursive: true });
    const filePath = this.dbFilePath(collection);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      // No existing DB — create fresh
      return await this.createDb();
    }

    return await this.migrateLegacyVectorProviderSchema(
      await this.persistModule.restore("json", raw),
      collection,
    );
  }

  private async createDb(): Promise<any> {
    const { create } = this.oramaModule;
    const schema: Record<string, string> = {
      id: "string",
      path: "string",
      content: "string",
      snippet: "string",
      vectorProvider: "string",
      vector: `vector[${this.embeddingDimension}]`,
    };
    return await create({ schema });
  }

  private async migrateLegacyVectorProviderSchema(db: any, collection: string): Promise<any> {
    const { search: oramaSearch, count, insert } = this.oramaModule;
    const existingCount = await count(db);
    if (existingCount === 0) {
      const migrated = await this.createDb();
      await this.persistDbForCollection(migrated, collection);
      return migrated;
    }

    const allHits = await oramaSearch(db, { term: "", limit: existingCount + 100 });
    const hits = allHits.hits ?? [];
    const needsMigration = hits.some((hit: any) =>
      typeof hit.document?.vectorProvider !== "string"
    );
    if (!needsMigration) return db;

    const migrated = await this.createDb();
    for (const hit of hits) {
      const doc = this.getStoredDocument(db, hit);
      const vector = this.getStoredVector(db, hit, doc);
      const payload: Record<string, unknown> = {
        id: typeof doc.id === "string" && doc.id.length > 0 ? doc.id : String(hit.id),
        path: typeof doc.path === "string" ? doc.path : "",
        content: typeof doc.content === "string" ? doc.content : "",
        snippet:
          typeof doc.snippet === "string"
            ? doc.snippet
            : typeof doc.content === "string"
              ? doc.content.slice(0, 200)
              : "",
        vectorProvider:
          typeof doc.vectorProvider === "string" ? doc.vectorProvider : "",
      };
      if (vector) {
        payload.vector = vector;
      } else {
        payload.vector = this.zeroVector();
      }
      await insert(migrated, payload);
    }
    await this.persistDbForCollection(migrated, collection);
    return migrated;
  }

  private async persistDbForCollection(db: any, collection: string): Promise<void> {
    const data = await this.persistModule.persist(db, "json");
    const filePath = this.dbFilePath(collection);
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(tempPath, data, "utf-8");
      await rename(tempPath, filePath);
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw err;
    }
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
      const collection = path.basename(filePath, ".msp");
      return await this.migrateLegacyVectorProviderSchema(
        await this.persistModule.restore("json", raw),
        collection,
      );
    } catch (err) {
      log.debug(`OramaBackend failed to load ${filePath}: ${err}`);
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
        const embedResult = await this.resolveCompatibleQueryEmbedding(db, query, execution);
        throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
        if (!embedResult) {
          // Fall back to fulltext if no embeddings available
          searchParams = { term: query, limit };
        } else {
          searchParams = { mode: "vector", vector: { value: embedResult.vector, property: "vector" }, limit };
        }
      } else {
        // hybrid
        const embedResult = await this.resolveCompatibleQueryEmbedding(db, query, execution);
        throwIfSearchAborted(execution, `OramaBackend ${mode} search aborted`);
        if (!embedResult) {
          searchParams = { term: query, limit };
        } else {
          searchParams = { mode: "hybrid", term: query, vector: { value: embedResult.vector, property: "vector" }, limit };
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

  private async resolveCompatibleQueryEmbedding(
    db: any,
    query: string,
    execution?: SearchExecutionOptions,
  ): Promise<EmbedWithProviderResult | null> {
    const embedResult = await this.embedHelper.embedWithProvider(query, { signal: execution?.signal });
    throwIfSearchAborted(execution, "OramaBackend query embedding aborted");
    if (!embedResult || !this.isExpectedDimensionVector(embedResult.vector)) return null;

    const storedProviderIdentity = await this.findCompatibleStoredVectorProvider(db, execution);
    if (!storedProviderIdentity) {
      this.rememberVectorProviderCompatibility(db, embedResult.providerIdentity, false);
      return null;
    }
    if (storedProviderIdentity === embedResult.providerIdentity) return embedResult;

    const fallbackEmbed = await this.embedQueryWithStoredFallbackProvider(query, storedProviderIdentity, execution);
    throwIfSearchAborted(execution, "OramaBackend fallback query embedding aborted");
    if (
      fallbackEmbed &&
      fallbackEmbed.providerIdentity === storedProviderIdentity &&
      this.isExpectedDimensionVector(fallbackEmbed.vector)
    ) {
      return fallbackEmbed;
    }

    this.rememberVectorProviderCompatibility(db, embedResult.providerIdentity, false);
    return null;
  }

  private async embedQueryWithStoredFallbackProvider(
    query: string,
    providerIdentity: EmbedProviderIdentity,
    execution?: SearchExecutionOptions,
  ): Promise<EmbedWithProviderResult | null> {
    const embedWithIdentity = (this.embedHelper as unknown as {
      embedWithFallbackProviderIdentity?: (
        text: string,
        identity: EmbedProviderIdentity,
        options?: { signal?: AbortSignal },
      ) => Promise<EmbedWithProviderResult | null>;
    }).embedWithFallbackProviderIdentity;
    if (typeof embedWithIdentity !== "function") return null;
    return embedWithIdentity.call(this.embedHelper, query, providerIdentity, { signal: execution?.signal });
  }

  private async findCompatibleStoredVectorProvider(
    db: any,
    execution?: SearchExecutionOptions,
  ): Promise<EmbedProviderIdentity | null> {
    const { search: oramaSearch, count } = this.oramaModule;
    try {
      const cached = this.vectorProviderCompatibility.get(db);
      if (cached?.compatible) return cached.providerIdentity;
      const existingCount = await count(db);
      if (existingCount === 0) return null;
      const allHits = await oramaSearch(db, {
        term: "",
        limit: existingCount + 100,
        properties: ["vectorProvider"],
      });
      let providerIdentity: EmbedProviderIdentity | null = null;
      let compatible = (allHits.hits ?? []).length > 0;
      for (const hit of allHits.hits ?? []) {
        throwIfSearchAborted(execution, "OramaBackend vector provider check aborted");
        const doc = this.getStoredDocument(db, hit);
        if (
          typeof doc.vectorProvider !== "string" ||
          doc.vectorProvider.length === 0 ||
          !this.isCompatibleStoredVector(this.getStoredVector(db, hit, doc))
        ) {
          compatible = false;
          break;
        }
        if (providerIdentity && doc.vectorProvider !== providerIdentity) {
          compatible = false;
          break;
        }
        providerIdentity = doc.vectorProvider as EmbedProviderIdentity;
      }
      if (compatible && providerIdentity) {
        this.vectorProviderCompatibility.set(db, {
          providerIdentity,
          compatible: true,
        });
        return providerIdentity;
      }
      return null;
    } catch (err) {
      if (isSearchAborted(execution)) throw err;
      log.debug(`OramaBackend stored vector provider check failed: ${err}`);
      return null;
    }
  }

  private async dbHasCompatibleVectors(
    db: any,
    providerIdentity: EmbedProviderIdentity,
    execution?: SearchExecutionOptions,
  ): Promise<boolean> {
    const { search: oramaSearch, count } = this.oramaModule;
    try {
      const cached = this.vectorProviderCompatibility.get(db);
      if (cached?.providerIdentity === providerIdentity) return cached.compatible;
      const existingCount = await count(db);
      if (existingCount === 0) return false;
      const allHits = await oramaSearch(db, {
        term: "",
        limit: existingCount + 100,
        properties: ["vectorProvider"],
      });
      let compatible = (allHits.hits ?? []).length > 0;
      for (const hit of allHits.hits ?? []) {
        throwIfSearchAborted(execution, "OramaBackend vector provider check aborted");
        const doc = this.getStoredDocument(db, hit);
        if (
          doc.vectorProvider !== providerIdentity ||
          !this.isCompatibleStoredVector(this.getStoredVector(db, hit, doc))
        ) {
          compatible = false;
          break;
        }
      }
      this.vectorProviderCompatibility.set(db, { providerIdentity, compatible });
      return compatible;
    } catch (err) {
      if (isSearchAborted(execution)) throw err;
      log.debug(`OramaBackend vector provider check failed: ${err}`);
      return false;
    }
  }

  private rememberVectorProviderCompatibility(
    db: unknown,
    providerIdentity: EmbedProviderIdentity | null,
    compatible: boolean,
  ): void {
    if (!db || typeof db !== "object") return;
    if (!providerIdentity) {
      this.vectorProviderCompatibility.delete(db);
      return;
    }
    this.vectorProviderCompatibility.set(db, { providerIdentity, compatible });
  }

  private getStoredDocument(db: any, hit: any): Record<string, unknown> {
    const internalId = this.getInternalDocumentId(db, hit);
    const internalDoc =
      internalId !== undefined && internalId !== null
        ? db?.data?.docs?.docs?.[String(internalId)]
        : undefined;
    if (internalDoc && typeof internalDoc === "object") {
      return internalDoc as Record<string, unknown>;
    }
    return hit?.document && typeof hit.document === "object"
      ? hit.document as Record<string, unknown>
      : {};
  }

  private getStoredVector(db: any, hit: any, doc: Record<string, unknown>): number[] | null {
    const documentVector = this.normalizeStoredVector(doc.vector);
    if (documentVector) return documentVector;
    const internalId = this.getInternalDocumentId(db, hit);
    if (internalId === undefined || internalId === null) return null;
    const vectorEntry = db?.data?.index?.vectorIndexes?.vector?.node?.vectors?.get?.(internalId);
    const vector = Array.isArray(vectorEntry) ? vectorEntry[1] : vectorEntry;
    return this.normalizeStoredVector(vector);
  }

  private getInternalDocumentId(db: any, hit: any): unknown {
    const publicId =
      typeof hit?.id === "string"
        ? hit.id
        : typeof hit?.document?.id === "string"
          ? hit.document.id
          : undefined;
    return publicId && typeof db?.internalDocumentIDStore?.idToInternalId?.get === "function"
      ? db.internalDocumentIDStore.idToInternalId.get(publicId)
      : undefined;
  }

  private isExpectedDimensionVector(vector: number[] | null | undefined): vector is number[] {
    return Array.isArray(vector) && vector.length === this.embeddingDimension;
  }

  private isCompatibleStoredVector(vector: unknown): vector is number[] {
    if (!vector || typeof vector !== "object") return false;
    const arr = Array.from(vector as ArrayLike<number>);
    return (
      arr.length === this.embeddingDimension &&
      arr.every((value) => Number.isFinite(value)) &&
      arr.some((value) => value !== 0)
    );
  }

  private zeroVector(): number[] {
    return Array.from({ length: this.embeddingDimension }, () => 0);
  }

  private normalizeStoredVector(vector: unknown): number[] | null {
    const values =
      Array.isArray(vector)
        ? vector
        : ArrayBuffer.isView(vector) && !(vector instanceof DataView)
          ? Array.from(vector as unknown as ArrayLike<unknown>)
          : null;
    if (!values || values.length !== this.embeddingDimension) return null;
    const normalized = values.map((value) => Number(value));
    return normalized.every((value) => Number.isFinite(value)) ? normalized : null;
  }
}
