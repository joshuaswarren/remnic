/**
 * Entity store (extracted from storage.ts StorageManager; god-file
 * decomposition, #1526 playbook: verbatim move + live selfDeps wiring so
 * Object.create(prototype) fakes and instance stubs keep working).
 *
 * Owns the entity file subsystem:
 *   - entity name normalization (alias table aware)
 *   - entity read/write (incl. schema-validated structured sections)
 *   - entity synthesis updates and knowledge-index construction
 *   - fragmented-entity merge (consolidation)
 */

import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { checkCorpusReadAbort, type CorpusReadOptions } from "../corpus-read-cancellation.js";
import { normalizeEntityStructuredSection, sortStructuredSectionsBySchema } from "../entity-schema.js";
import { withEntityCanonicalMutationLock } from "./entity-canonical-id-lock.js";
import { log } from "../logger.js";
import { getCachedEntities, setCachedEntities } from "../memory-cache.js";
import type { VersionTrigger } from "../page-versioning.js";
import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import type {
  EntityActivityEntry,
  EntityFile,
  EntityRelationship,
  EntityStructuredSection,
  PluginConfig,
  ScoredEntity,
} from "../types.js";
import { isErrnoCode } from "../utils/errno.js";
import {
  reconcileIfJournalMovedSync,
  requestEntityCanonicalIdReconcileSync,
  resolveHistoricalEntityCanonicalId,
} from "./entity-canonical-id-references.js";
import {
  buildEntitySchemaCacheKey,
  compareEntityTimestamps,
  compileEntityFacts,
  countEntityStructuredFacts,
  fingerprintEntityStructuredFacts,
  normalizeEntityName as normalizeEntityNameShared,
  normalizeStructuredSectionFactsWithOrigins,
  parseEntityFile,
  serializeEntityFile,
  StorageManager,
} from "../storage.js";
// Issue #1533 Phase B: importers take entity-file parsing from this storage/
// subsystem module, not the storage.ts god file (see check-ratchets.mjs).
export { parseEntityFile } from "../storage.js";
import { parseOriginClass } from "../security/origin-authority.js";

export interface EntityStoreDeps {
  /** Live class object of the host instance — shared static caches (see storage.ts storageManagerClass). */
  readonly storageManagerClass: typeof StorageManager;
  readonly baseDir: string;
  bumpMemoryStatusVersion(): void;
  /** Entity-mutation sentinel for the migration fingerprint (issue #2213). */
  bumpEntityMutationVersion(): void;
  ensureDirectories(): Promise<void>;
  readonly entitiesDir: string;
  readonly entitySchemas: PluginConfig["entitySchemas"] | undefined;
  currentHistoricalIds(): Readonly<Record<string, string>>;
  findMatchingEntity(proposedName: string, type: string): Promise<string | null>;
  getEntityCacheSecureStoreKey(): string;
  getEntityMutationVersion(): number;
  getMemoryStatusVersion(): number;
  invalidateKnowledgeIndexCache(): void;
  knowledgeIndexCache: { result: string; builtAt: number } | null;
  okfConformanceEnabled(): boolean;
  normalizeEntityName(raw: string, type: string): string;
  readAllEntityFiles(): Promise<EntityFile[]>;
  readStorageSecureFile(filePath: string): Promise<string>;
  removeEntitySynthesisQueueEntries(entityNames: string[]): Promise<void>;
  resolveEntityFilePath(name: string): string | null;
  snapshotBeforeWrite(filePath: string, trigger: VersionTrigger): Promise<void>;
  readonly userAliases: Record<string, string>;
  writeStorageSecureFile(filePath: string, content: string | Buffer): Promise<void>;
}

export class EntityStore {
  constructor(
    private readonly deps: EntityStoreDeps,
  ) {}

  /** Normalize an entity name using this store's alias table. */
  normalizeEntityName(raw: string, type: string): string {
    return normalizeEntityNameShared(raw, type, this.deps.userAliases);
  }

  /**
   * Read an entity file by id, resolving through the migration journal with a
   * fallback to the caller's original id (issue #2213): mid-migration, the
   * journal maps legacy → canonical BEFORE the file moves — writing the
   * still-existing legacy file is safe (the rename retry carries it), while
   * resolving only the canonical path silently drops the mutation.
   */
  private async readEntityForMutation(
    name: string,
    method: string,
    historicalIds: Readonly<Record<string, string>>,
  ): Promise<{ filePath: string; entity: EntityFile } | null> {
    const canonical = resolveHistoricalEntityCanonicalId(name, historicalIds);
    for (const candidate of canonical === name ? [name] : [canonical, name]) {
      const filePath = path.join(this.deps.entitiesDir, `${candidate}.md`);
      try {
        const entity = parseEntityFile(await this.deps.readStorageSecureFile(filePath), this.deps.entitySchemas);
        return { filePath, entity };
      } catch (err) {
        if (err instanceof SecureStoreLockedError) throw err;
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
    }
    log.debug(`${method}: entity file ${canonical}.md not found`);
    return null;
  }

  /**
   * Locked read-modify-write for the entity-file mutators (issue #2213):
   * holding the entity-mutation lock keeps `migrateEntityFilePair` (which
   * takes the same lock) from moving the file between the fallback read and
   * this write — an unlocked write could recreate a just-renamed legacy file.
   * The journal itself is NOT serialized by this lock (`pruneBlocked` can
   * park a mapping mid-mutation), so the journal identity is REVALIDATED
   * just before committing — a moved journal restarts resolution against the
   * fresh table instead of writing into a since-contested claimant — and
   * checked once more after the write for a move across the write itself.
   * `mutate` returns false to skip the write. Resolves true when written.
   */
  private async mutateEntityFile(
    name: string,
    method: string,
    mutate: (entity: EntityFile, historicalIds: Readonly<Record<string, string>>) => boolean,
  ): Promise<boolean> {
    const stateDir = path.join(this.deps.baseDir, "state");
    return withEntityCanonicalMutationLock(stateDir, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const idsAtResolve = this.deps.currentHistoricalIds();
        const located = await this.readEntityForMutation(name, method, idsAtResolve);
        const mutated = located !== null && mutate(located.entity, idsAtResolve);
        // Revalidate BEFORE honoring either verdict: a journal that moved
        // makes both the resolution AND a dedupe-based no-op stale (a parked
        // mapping can make "already present on the claimant" wrong).
        if (this.deps.currentHistoricalIds() !== idsAtResolve) continue;
        if (!located || !mutated) return false;
        located.entity.updated = new Date().toISOString();
        await this.deps.writeStorageSecureFile(
          located.filePath,
          serializeEntityFile(located.entity, this.deps.entitySchemas, this.deps.okfConformanceEnabled()),
        );
        reconcileIfJournalMovedSync(stateDir, idsAtResolve, this.deps.currentHistoricalIds());
        this.deps.invalidateKnowledgeIndexCache();
        this.deps.bumpEntityMutationVersion();
        return true;
      }
      // The journal kept moving under us. A silent false would DROP the
      // requested mutation (the reconcile pass rewrites existing references;
      // it cannot replay a mutation that was never written) — surface a
      // retryable error so the caller's persist machinery logs/retries it.
      requestEntityCanonicalIdReconcileSync(stateDir);
      throw new Error(
        `${method}: entity canonical-id journal kept changing; mutation not applied — retry`,
      );
    });
  }

  /** Add a relationship to an entity file. Deduplicates by target+label. */
  async addEntityRelationship(name: string, rel: EntityRelationship): Promise<void> {
    await this.mutateEntityFile(name, "addEntityRelationship", (entity, historicalIds) => {
      // Resolve the target with the SAME snapshot the locked read used, and
      // dedupe against CANONICALIZED stored targets — an existing edge the
      // migration has not rewritten yet still names the legacy id, and a
      // plain equality check would miss it and leave duplicates after the
      // rewrite (issue #2213).
      const target = resolveHistoricalEntityCanonicalId(rel.target, historicalIds);
      const duplicate = entity.relationships.some(
        (r) => resolveHistoricalEntityCanonicalId(r.target, historicalIds) === target && r.label === rel.label,
      );
      if (duplicate) return false;
      entity.relationships.push({ ...rel, target });
      return true;
    });
  }

  /** Add an activity entry to an entity file; prunes oldest beyond maxEntries. */
  async addEntityActivity(name: string, entry: EntityActivityEntry, maxEntries: number): Promise<void> {
    await this.mutateEntityFile(name, "addEntityActivity", (entity) => {
      entity.activity.unshift(entry);
      if (entity.activity.length > maxEntries) entity.activity = entity.activity.slice(0, maxEntries);
      return true;
    });
  }

  async addEntityAlias(name: string, alias: string): Promise<void> {
    const wrote = await this.mutateEntityFile(name, "addEntityAlias", (entity) => {
      if (entity.aliases.includes(alias)) return false;
      entity.aliases.push(alias);
      return true;
    });
    if (wrote) this.deps.bumpMemoryStatusVersion();
  }

  async writeEntity(
    name: string,
    type: string,
    facts: string[],
    options: {
      timestamp?: string;
      source?: string;
      sessionKey?: string;
      principal?: string;
      origin?: string;
      structuredSections?: EntityStructuredSection[];
    } = {},
  ): Promise<string> {
    await this.deps.ensureDirectories();
    return withEntityCanonicalMutationLock(
      path.join(this.deps.baseDir, "state"),
      () => this.writeEntityUnlocked(name, type, facts, options),
    );
  }

  private async writeEntityUnlocked(
    name: string,
    type: string,
    facts: string[],
    options: {
      timestamp?: string;
      source?: string;
      sessionKey?: string;
      principal?: string;
      origin?: string;
      structuredSections?: EntityStructuredSection[];
    } = {},
  ): Promise<string> {
    if (typeof name !== "string" || !name.trim() || typeof type !== "string" || !type.trim()) {
      log.warn("writeEntity: invalid entity payload, skipping", {
        nameType: typeof name,
        typeType: typeof type,
      });
      return "";
    }
    const safeFacts = Array.isArray(facts)
      ? [...new Set(
        facts
          .filter((fact) => typeof fact === "string")
          .map((fact) => fact.trim())
          .filter((fact) => fact.length > 0),
      )]
      : [];
    let normalized = this.deps.normalizeEntityName(name, type);

    // Check for fuzzy match against existing entities before creating a new file
    const match = await this.deps.findMatchingEntity(name, type);
    if (match && match !== normalized) {
      log.debug(`fuzzy match: "${normalized}" → existing "${match}"`);
      normalized = match;
    }

    const filePath = path.join(this.deps.entitiesDir, `${normalized}.md`);

    // Parse existing file to preserve relationships/activity/aliases/summary
    let entity: EntityFile = {
      name,
      type,
      created: "",
      updated: new Date().toISOString(),
      facts: [],
      summary: undefined,
      synthesis: undefined,
      synthesisUpdatedAt: undefined,
      synthesisVersion: undefined,
      synthesisStructuredFactCount: undefined,
      synthesisStructuredFactDigest: undefined,
      timeline: [],
      relationships: [],
      activity: [],
      aliases: [],
    };
    try {
      const existing = await this.deps.readStorageSecureFile(filePath);
      entity = parseEntityFile(existing, this.deps.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      // File doesn't exist yet
    }

    const timestamp = options.timestamp?.trim() || new Date().toISOString();
    const source = options.source?.trim() || undefined;
    const sessionKey = options.sessionKey?.trim() || undefined;
    const principal = options.principal?.trim() || undefined;
    const origin = options.origin?.trim() ? parseOriginClass(options.origin) : undefined;
    const structuredSectionMap = new Map(
      (entity.structuredSections ?? []).map((section) => [section.key, {
        ...section,
        facts: [...section.facts],
        ...(section.factOrigins ? { factOrigins: [...section.factOrigins] } : {}),
      }]),
    );
    for (const section of options.structuredSections ?? []) {
      const normalizedSection = normalizeEntityStructuredSection(type, section, this.deps.entitySchemas);
      const normalized = normalizeStructuredSectionFactsWithOrigins(section.facts, section.factOrigins, origin);
      if (normalized.facts.length === 0) continue;
      const existingSection = structuredSectionMap.get(normalizedSection.key);
      if (!existingSection) {
        structuredSectionMap.set(normalizedSection.key, {
          key: normalizedSection.key,
          title: normalizedSection.title,
          ...normalized,
        });
        continue;
      }
      const existingOrigins = existingSection.facts.map((_, index) => existingSection.factOrigins?.[index]);
      const incomingOrigins = normalized.facts.map((_, index) => normalized.factOrigins?.[index]);
      const merged = normalizeStructuredSectionFactsWithOrigins(
        [...existingSection.facts, ...normalized.facts],
        [...existingOrigins, ...incomingOrigins],
      );
      existingSection.facts = merged.facts;
      existingSection.factOrigins = merged.factOrigins;
      if (!existingSection.title.trim() && normalizedSection.title.trim()) {
        existingSection.title = normalizedSection.title;
      }
    }
    for (const fact of safeFacts) {
      const nextEntry = {
        timestamp,
        text: fact,
        ...(source ? { source } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(principal ? { principal } : {}),
        ...(origin ? { origin } : {}),
      };
      const alreadyPresent = entity.timeline.some((entry) =>
        entry.timestamp === nextEntry.timestamp
        && entry.text === nextEntry.text
        && entry.source === nextEntry.source
        && entry.sessionKey === nextEntry.sessionKey
        && entry.principal === nextEntry.principal
        && entry.origin === nextEntry.origin
      );
      if (alreadyPresent) continue;
      entity.timeline.push(nextEntry);
    }
    entity.structuredSections = sortStructuredSectionsBySchema(
      type,
      Array.from(structuredSectionMap.values()).filter((section) => section.facts.length > 0),
      this.deps.entitySchemas,
    );
    entity.facts = compileEntityFacts(entity.timeline, entity.structuredSections);
    entity.summary = entity.synthesis || entity.summary;
    entity.name = name;
    entity.type = type;
    entity.created = entity.created || timestamp;
    entity.updated = new Date().toISOString();

    await this.deps.snapshotBeforeWrite(filePath, "write");
    await this.deps.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.deps.entitySchemas, this.deps.okfConformanceEnabled()));
    this.deps.invalidateKnowledgeIndexCache();
    this.deps.bumpMemoryStatusVersion(); // invalidate entity cache
    this.deps.bumpEntityMutationVersion();
    log.debug(`wrote entity ${normalized}`);
    return normalized;
  }

  async readEntity(name: string): Promise<string> {
    const filePath = this.deps.resolveEntityFilePath(name);
    if (filePath === null) {
      return "";
    }
    try {
      return await this.deps.readStorageSecureFile(filePath);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return "";
    }
  }

  /** Return sorted list of entity filenames (without .md extension) */
  async listEntityNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.deps.entitiesDir);
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((e) => e.replace(".md", ""))
        .sort();
    } catch {
      return [];
    }
  }

  /** Re-serialize every entity file into the compiled-truth timeline shape. */
  async migrateEntityFilesToCompiledTruthTimeline(): Promise<{ total: number; migrated: number }> {
    const entityNames = await this.listEntityNames();
    const stateDir = path.join(this.deps.baseDir, "state");
    let migrated = 0;
    for (const entityName of entityNames) {
      // Read+rewrite under the entity MUTATION lock (issue #2213): an
      // unlocked whole-record rewrite could restore relationship targets a
      // peer migration rewrote between the read and the write, and this
      // path bumps only the status version, which never re-triggers the
      // completed migration's reference scan.
      const wrote = await withEntityCanonicalMutationLock(stateDir, async () => {
        const raw = await this.readEntity(entityName);
        if (!raw) return false;
        const serialized = serializeEntityFile(parseEntityFile(raw, this.deps.entitySchemas), this.deps.entitySchemas, this.deps.okfConformanceEnabled());
        if (raw.trimEnd() === serialized.trimEnd()) return false;
        const filePath = this.deps.resolveEntityFilePath(entityName);
        if (filePath === null) return false;
        await this.deps.writeStorageSecureFile(filePath, serialized);
        this.deps.bumpEntityMutationVersion();
        return true;
      });
      if (wrote) migrated += 1;
    }
    if (migrated > 0) {
      this.deps.invalidateKnowledgeIndexCache();
      this.deps.bumpMemoryStatusVersion();
    }
    return { total: entityNames.length, migrated };
  }

  /**
   * Set or rewrite the synthesis layer of an entity file.
   */
  async updateEntitySynthesis(
    name: string,
    synthesis: string,
    options: {
      entityUpdatedAt?: string;
      synthesisStructuredFactCount?: number;
      synthesisStructuredFactDigest?: string;
      synthesisTimelineCount?: number;
      updatedAt?: string;
      incrementVersion?: boolean;
    } = {},
  ): Promise<void> {
    return withEntityCanonicalMutationLock(
      path.join(this.deps.baseDir, "state"),
      () => this.updateEntitySynthesisUnlocked(name, synthesis, options),
    );
  }

  private async updateEntitySynthesisUnlocked(
    name: string,
    synthesis: string,
    options: {
      entityUpdatedAt?: string;
      synthesisStructuredFactCount?: number;
      synthesisStructuredFactDigest?: string;
      synthesisTimelineCount?: number;
      updatedAt?: string;
      incrementVersion?: boolean;
    } = {},
  ): Promise<void> {
    const filePath = path.join(this.deps.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await this.deps.readStorageSecureFile(filePath);
      entity = parseEntityFile(content, this.deps.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug(`updateEntitySynthesis: entity file ${name}.md not found`);
      return;
    }

    const updatedAt = options.updatedAt?.trim() || entity.synthesisUpdatedAt?.trim() || undefined;
    const entityUpdatedAt = options.entityUpdatedAt?.trim() || updatedAt || entity.updated || new Date().toISOString();
    const synthesisTimelineCount = Number.isInteger(options.synthesisTimelineCount)
      && (options.synthesisTimelineCount ?? 0) >= 0
      ? options.synthesisTimelineCount
      : undefined;
    const synthesisStructuredFactCount = Number.isInteger(options.synthesisStructuredFactCount)
      && (options.synthesisStructuredFactCount ?? 0) >= 0
      ? options.synthesisStructuredFactCount
      : countEntityStructuredFacts(entity);
    const synthesisStructuredFactDigest = options.synthesisStructuredFactDigest?.trim()
      || fingerprintEntityStructuredFacts(entity);
    entity.synthesis = synthesis.trim();
    entity.summary = entity.synthesis;
    entity.synthesisUpdatedAt = updatedAt;
    entity.synthesisTimelineCount = synthesisTimelineCount;
    entity.synthesisStructuredFactCount = synthesisStructuredFactCount;
    entity.synthesisStructuredFactDigest = synthesisStructuredFactDigest;
    entity.synthesisVersion = Math.max(0, entity.synthesisVersion ?? 0)
      + (options.incrementVersion === false ? 0 : 1);
    entity.updated = entityUpdatedAt;
    await this.deps.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.deps.entitySchemas, this.deps.okfConformanceEnabled()));
    await this.deps.removeEntitySynthesisQueueEntries([
      ...new Set([name, this.deps.normalizeEntityName(entity.name, entity.type)]),
    ]);
    this.deps.invalidateKnowledgeIndexCache();
    this.deps.bumpMemoryStatusVersion(); // invalidate entity cache
    this.deps.bumpEntityMutationVersion();
  }

  /**
   * Read all entity files and return lightweight EntityFile objects.
   * Parsing is fast (~50-100ms for ~1,800 files) since entity files are small.
   */
  async readAllEntityFiles(options?: CorpusReadOptions): Promise<EntityFile[]> {
    checkCorpusReadAbort(options);
    const currentVersion = this.deps.getMemoryStatusVersion();
    const cacheKey = [
      this.deps.getEntityCacheSecureStoreKey(),
      buildEntitySchemaCacheKey(this.deps.entitySchemas),
      this.deps.getEntityMutationVersion(),
    ].join("\u0000");
    const cached = getCachedEntities(this.deps.baseDir, currentVersion, cacheKey);
    if (cached) return cached;

    try {
      const entries = await readdir(this.deps.entitiesDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));
      if (mdFiles.length === 0) return [];

      // Read all entity files in parallel batches to avoid O(N) sequential I/O.
      // With 3000+ entity files, sequential reads can take 15-20s under load.
      // Batching at 100 keeps file-descriptor pressure manageable while staying fast.
      const BATCH_SIZE = 100;
      const entities: EntityFile[] = [];
      for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
        // Per batch, so an abandoned caller stops within one batch of I/O instead
        // of reading every entity file for a result nobody awaits (issue #2307).
        checkCorpusReadAbort(options);
        const batch = mdFiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (entry) => {
            try {
              return await this.deps.readStorageSecureFile(path.join(this.deps.entitiesDir, entry));
            } catch (err) {
              if (err instanceof SecureStoreLockedError) throw err;
              if (!isErrnoCode(err, "ENOENT")) throw err;
              return null;
            }
          }),
        );
        for (const content of results) {
          if (content !== null) entities.push(parseEntityFile(content, this.deps.entitySchemas));
        }
      }
      // A signal that fired during the last batch's await would otherwise publish
      // and return as if uncancelled (issue #2307 review).
      checkCorpusReadAbort(options);
      setCachedEntities(this.deps.baseDir, entities, currentVersion, cacheKey);
      return entities;
    } catch (err) {
      if (err instanceof SecureStoreLockedError || !isErrnoCode(err, "ENOENT")) throw err;
      // Directory doesn't exist yet
      return [];
    }
  }

  /**
   * Build the Knowledge Index: a compact markdown table of top-scored entities.
   * Respects maxEntities and maxChars limits from config.
   */
  async buildKnowledgeIndex(
    config: PluginConfig,
    overrides?: { maxEntities?: number; maxChars?: number },
  ): Promise<{ result: string; cached: boolean }> {
    const useDefaultLimits =
      overrides?.maxEntities === undefined &&
      overrides?.maxChars === undefined;
    // Return cached index if still fresh
    if (
      useDefaultLimits &&
      this.deps.knowledgeIndexCache &&
      Date.now() - this.deps.knowledgeIndexCache.builtAt < this.deps.storageManagerClass.KNOWLEDGE_INDEX_CACHE_TTL_MS
    ) {
      return { result: this.deps.knowledgeIndexCache.result, cached: true };
    }

    const entities = await this.deps.readAllEntityFiles();
    if (entities.length === 0) {
      if (useDefaultLimits) this.deps.knowledgeIndexCache = { result: "", builtAt: Date.now() };
      return { result: "", cached: false };
    }

    const now = new Date();
    const scored: ScoredEntity[] = entities.map((e) => ({
      name: e.name,
      type: e.type,
      score: this.deps.storageManagerClass.scoreEntity(e, now),
      factCount: e.facts.length,
      summary: e.synthesis ?? e.summary,
      topRelationships: e.relationships.slice(0, 3).map((r) => r.target),
    }));

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    const maxEntities = typeof overrides?.maxEntities === "number"
      ? Math.max(0, Math.floor(overrides.maxEntities))
      : config.knowledgeIndexMaxEntities;
    const topN = scored.slice(0, maxEntities);

    if (topN.length === 0) {
      if (useDefaultLimits) this.deps.knowledgeIndexCache = { result: "", builtAt: Date.now() };
      return { result: "", cached: false };
    }

    // Build markdown table
    const header = "## Knowledge Index\n\n| Entity | Type | Summary | Connected to |\n|--------|------|---------|-------------|";
    const rows: string[] = [];
    let totalChars = header.length;
    const maxChars = typeof overrides?.maxChars === "number"
      ? Math.max(0, Math.floor(overrides.maxChars))
      : config.knowledgeIndexMaxChars;

    for (const entity of topN) {
      const summary = entity.summary || `${entity.factCount} facts`;
      const connected = entity.topRelationships.length > 0
        ? entity.topRelationships.join(", ")
        : "—";
      const row = `| ${entity.name} | ${entity.type} | ${summary} | ${connected} |`;

      if (totalChars + row.length + 1 > maxChars) break;
      rows.push(row);
      totalChars += row.length + 1;
    }

    const result = rows.length === 0 ? "" : `${header}\n${rows.join("\n")}\n`;
    if (useDefaultLimits) this.deps.knowledgeIndexCache = { result, builtAt: Date.now() };
    return { result, cached: false };
  }

  /**
   * Merge fragmented entity files that resolve to the same canonical name.
   * Preserves relationships, activity, aliases, and summary from all fragments.
   * Returns count of files merged.
   */
  async mergeFragmentedEntities(): Promise<number> {
    return withEntityCanonicalMutationLock(
      path.join(this.deps.baseDir, "state"),
      () => this.mergeFragmentedEntitiesUnlocked(),
    );
  }

  private async mergeFragmentedEntitiesUnlocked(): Promise<number> {
    let merged = 0;
    try {
      const entries = await readdir(this.deps.entitiesDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));

      // Group files by their canonical name
      const groups = new Map<string, string[]>();
      for (const file of mdFiles) {
        const baseName = file.replace(".md", "");
        // Extract type and name from filename (type-rest-of-name)
        const dashIdx = baseName.indexOf("-");
        if (dashIdx === -1) continue;
        const type = baseName.slice(0, dashIdx);
        const restOfName = baseName.slice(dashIdx + 1);
        const canonical = this.deps.normalizeEntityName(restOfName, type);

        if (!groups.has(canonical)) groups.set(canonical, []);
        groups.get(canonical)!.push(file);
      }

      // Merge groups with more than one file
      for (const [canonical, files] of groups) {
        if (files.length <= 1) continue;

        // Parse all files and merge into a single EntityFile
        const mergedEntity: EntityFile = {
          name: "",
          type: "other",
          created: "",
          updated: "",
          extraFrontmatterLines: [],
          preSectionLines: [],
          facts: [],
          summary: undefined,
          synthesis: undefined,
          synthesisUpdatedAt: undefined,
          synthesisTimelineCount: undefined,
          synthesisStructuredFactCount: undefined,
          synthesisStructuredFactDigest: undefined,
          synthesisVersion: undefined,
          timeline: [],
          relationships: [],
          activity: [],
          aliases: [],
          structuredSections: [],
          extraSections: [],
        };

        for (const file of files) {
          const filePath = path.join(this.deps.entitiesDir, file);
          try {
            const content = await this.deps.readStorageSecureFile(filePath);
            const parsed = parseEntityFile(content, this.deps.entitySchemas);

            // Prefer specific types over "other"
            if (!mergedEntity.type || mergedEntity.type === "other") {
              mergedEntity.type = parsed.type;
            }

            // Keep latest update time
            if (!mergedEntity.updated || compareEntityTimestamps(parsed.updated, mergedEntity.updated) > 0) {
              mergedEntity.updated = parsed.updated;
            }

            const parsedCreated = parsed.created || parsed.updated;
            const mergedCreated = mergedEntity.created?.trim() || "";
            const parsedCreatedMs = parsedCreated ? Date.parse(parsedCreated) : Number.NaN;
            const mergedCreatedMs = mergedCreated ? Date.parse(mergedCreated) : Number.NaN;
            const parsedCreatedIsValid = Number.isFinite(parsedCreatedMs);
            const mergedCreatedIsValid = Number.isFinite(mergedCreatedMs);
            if (
              parsedCreated &&
              (
                !mergedCreated
                || (parsedCreatedIsValid && !mergedCreatedIsValid)
                || (
                  parsedCreatedIsValid
                  && mergedCreatedIsValid
                  && parsedCreatedMs < mergedCreatedMs
                )
                || (
                  !parsedCreatedIsValid
                  && !mergedCreatedIsValid
                  && compareEntityTimestamps(parsedCreated, mergedCreated) < 0
                )
              )
            ) {
              mergedEntity.created = parsedCreated;
            }

            // Keep longest/best name
            if (parsed.name.length > mergedEntity.name.length) {
              mergedEntity.name = parsed.name;
            }

            const parsedSynthesisUpdatedAt = parsed.synthesisUpdatedAt?.trim() || undefined;
            const mergedSynthesisUpdatedAt = mergedEntity.synthesisUpdatedAt?.trim() || undefined;

            // Prefer the freshest synthesis/summary available.
            if (
              parsed.synthesis &&
              (!mergedEntity.synthesis
                || (!mergedSynthesisUpdatedAt && Boolean(parsedSynthesisUpdatedAt))
                || (Boolean(mergedSynthesisUpdatedAt)
                  && Boolean(parsedSynthesisUpdatedAt)
                  && compareEntityTimestamps(parsedSynthesisUpdatedAt, mergedSynthesisUpdatedAt) > 0))
            ) {
              mergedEntity.synthesis = parsed.synthesis;
              mergedEntity.summary = parsed.synthesis;
              mergedEntity.synthesisUpdatedAt = parsedSynthesisUpdatedAt;
              mergedEntity.synthesisTimelineCount = parsed.synthesisTimelineCount;
              mergedEntity.synthesisStructuredFactCount = parsed.synthesisStructuredFactCount;
              mergedEntity.synthesisStructuredFactDigest = parsed.synthesisStructuredFactDigest;
              mergedEntity.synthesisVersion = parsed.synthesisVersion;
            } else if (!mergedEntity.summary && parsed.summary) {
              mergedEntity.summary = parsed.summary;
              mergedEntity.synthesis = parsed.summary;
              mergedEntity.synthesisUpdatedAt = parsedSynthesisUpdatedAt;
              mergedEntity.synthesisTimelineCount = parsed.synthesisTimelineCount;
              mergedEntity.synthesisStructuredFactCount = parsed.synthesisStructuredFactCount;
              mergedEntity.synthesisStructuredFactDigest = parsed.synthesisStructuredFactDigest;
              mergedEntity.synthesisVersion = parsed.synthesisVersion;
            }

            // Collect all timeline evidence; facts are derived below.
            mergedEntity.timeline.push(...parsed.timeline);

            // Collect relationships (dedup later)
            mergedEntity.relationships.push(...parsed.relationships);

            // Collect activity entries
            mergedEntity.activity.push(...parsed.activity);

            // Collect aliases
            mergedEntity.aliases.push(...parsed.aliases);

            const mergedStructuredSectionMap = new Map(
              (mergedEntity.structuredSections ?? []).map((section) => [section.key, {
                ...section,
                facts: [...section.facts],
                factOrigins: section.factOrigins ? [...section.factOrigins] : undefined,
              }]),
            );
            for (const section of parsed.structuredSections ?? []) {
              const existingSection = mergedStructuredSectionMap.get(section.key);
              if (!existingSection) {
                const facts: string[] = [];
                const factOrigins: Array<string | undefined> = [];
                for (const [index, fact] of section.facts.entries()) {
                  const trimmed = fact.trim();
                  if (!trimmed || facts.includes(trimmed)) continue;
                  facts.push(trimmed);
                  factOrigins.push(section.factOrigins?.[index]);
                }
                mergedStructuredSectionMap.set(section.key, {
                  key: section.key,
                  title: section.title,
                  facts,
                  factOrigins: section.factOrigins ? factOrigins : undefined,
                });
                continue;
              }

              if (section.factOrigins && !existingSection.factOrigins) {
                existingSection.factOrigins = existingSection.facts.map(() => undefined);
              }
              for (const [index, fact] of section.facts.entries()) {
                const trimmed = fact.trim();
                if (!trimmed) continue;
                const existingIndex = existingSection.facts.indexOf(trimmed);
                const origin = section.factOrigins?.[index];
                if (existingIndex === -1) {
                  existingSection.facts.push(trimmed);
                  existingSection.factOrigins?.push(origin);
                } else if (existingSection.factOrigins?.[existingIndex] !== origin) {
                  existingSection.factOrigins?.splice(existingIndex, 1, undefined);
                }
              }
              if (!existingSection.title.trim() && section.title.trim()) {
                existingSection.title = section.title;
              }
            }
            mergedEntity.structuredSections = Array.from(mergedStructuredSectionMap.values());

            // Preserve custom metadata and user-authored freeform content from fragments.
            mergedEntity.extraFrontmatterLines!.push(...(parsed.extraFrontmatterLines ?? []));
            mergedEntity.preSectionLines!.push(...(parsed.preSectionLines ?? []));
            mergedEntity.extraSections!.push(...(parsed.extraSections ?? []).map((section) => ({
              title: section.title,
              lines: [...section.lines],
            })));
          } catch (err) {
            if (err instanceof SecureStoreLockedError) throw err;
            if (!isErrnoCode(err, "ENOENT")) throw err;
            // Skip unreadable
          }
        }

        const timelineByKey = new Map<string, (typeof mergedEntity.timeline)[number]>();
        for (const entry of mergedEntity.timeline) {
          const key = JSON.stringify([
            entry.timestamp,
            entry.source ?? "",
            entry.sessionKey ?? "",
            entry.principal ?? "",
            entry.text,
          ]);
          const existing = timelineByKey.get(key);
          if (!existing) {
            timelineByKey.set(key, entry);
          } else if (existing.origin !== entry.origin) {
            existing.origin = undefined;
          }
        }
        mergedEntity.timeline = [...timelineByKey.values()];
        // Deduplicate relationships by target+label
        const relKeys = new Set<string>();
        mergedEntity.relationships = mergedEntity.relationships.filter((r) => {
          const key = `${r.target}::${r.label}`;
          if (relKeys.has(key)) return false;
          relKeys.add(key);
          return true;
        });

        // Sort activity by date descending, deduplicate by date+note
        const actKeys = new Set<string>();
        mergedEntity.activity = mergedEntity.activity
          .filter((a) => {
            const key = `${a.date}::${a.note}`;
            if (actKeys.has(key)) return false;
            actKeys.add(key);
            return true;
          })
          .sort((a, b) => b.date.localeCompare(a.date));

        // Deduplicate aliases
        mergedEntity.aliases = [...new Set(mergedEntity.aliases)];
        mergedEntity.structuredSections = sortStructuredSectionsBySchema(
          mergedEntity.type,
          mergedEntity.structuredSections ?? [],
          this.deps.entitySchemas,
        );
        mergedEntity.facts = compileEntityFacts(mergedEntity.timeline, mergedEntity.structuredSections);

        const extraSectionKeys = new Set<string>();
        mergedEntity.extraSections = (mergedEntity.extraSections ?? []).filter((section) => {
          const key = `${section.title}::${section.lines.join("\n")}`;
          if (extraSectionKeys.has(key)) return false;
          extraSectionKeys.add(key);
          return true;
        });

        // Fallback name from canonical
        if (!mergedEntity.name) {
          const dashIdx = canonical.indexOf("-");
          mergedEntity.name = dashIdx !== -1 ? canonical.slice(dashIdx + 1) : canonical;
        }

        mergedEntity.created = mergedEntity.created || mergedEntity.updated || new Date().toISOString();
        mergedEntity.updated = mergedEntity.updated || new Date().toISOString();

        const canonicalPath = path.join(this.deps.entitiesDir, `${canonical}.md`);
        await this.deps.writeStorageSecureFile(canonicalPath, serializeEntityFile(mergedEntity, this.deps.entitySchemas, this.deps.okfConformanceEnabled()));
        this.deps.bumpEntityMutationVersion();

        // Remove non-canonical files
        for (const file of files) {
          const filePath = path.join(this.deps.entitiesDir, file);
          if (filePath !== canonicalPath) {
            try {
              await unlink(filePath);
              merged++;
              log.debug(`merged entity ${file} → ${canonical}.md`);
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof SecureStoreLockedError || !isErrnoCode(err, "ENOENT")) throw err;
      // Directory doesn't exist yet
    }

    return merged;
  }
}
