import { randomUUID } from "node:crypto";
import { access, lstat, readFile, readdir, rename, stat as statFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { computeSupersessionKey, normalizeSupersessionKey } from "../temporal-supersession.js";
import type { EntityFile, MemoryFile } from "../types.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";

const ENTITY_CANONICAL_ID_MIGRATION_VERSION = 1;
const ENTITY_CANONICAL_ID_MIGRATION_FILE = "entity-canonical-id-migration-v1.json";
const ENTITY_CANONICAL_ID_MIGRATION_LOCK_STALE_MS = 60_000;
const ENTITY_CANONICAL_ID_MIGRATION_LOCK_MAX_WAIT_MS = 300_000;
const TOMBSTONE_LOCK_STALE_MS = 30_000;
const TOMBSTONE_LOCK_MAX_WAIT_MS = 5_000;
const MEMORY_REWRITE_MAX_PASSES = 3;
const ENTITY_MAPPING_RESCAN_MAX_PASSES = 3;

const EntityCanonicalIdMigrationStateSchema = z.object({
  version: z.literal(ENTITY_CANONICAL_ID_MIGRATION_VERSION),
  complete: z.boolean(),
  mappings: z.record(z.string().min(1)),
});

type EntityCanonicalIdMigrationState = z.infer<typeof EntityCanonicalIdMigrationStateSchema>;

export interface EntityCanonicalIdMigrationDependencies {
  stateDir: string;
  entitiesDir: string;
  normalizeEntityName(raw: string, type: string): string;
  resolveEntityFilePath(id: string): string | null;
  readStorageSecureFile(filePath: string): Promise<string>;
  writeStorageSecureFile(filePath: string, content: string, forceEncrypt?: boolean): Promise<void>;
  isEncryptedStorageFile(filePath: string): Promise<boolean>;
  snapshotBeforeWrite(filePath: string, trigger: "write"): Promise<void>;
  parseEntityFile(content: string): EntityFile;
  serializeEntityFile(entity: EntityFile): string;
  serializeMemoryWithEntityRef(memory: MemoryFile, entityRef: string): string;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  readAllMemories(): Promise<MemoryFile[]>;
  readAllColdMemories(): Promise<MemoryFile[]>;
  readArchivedMemories(): Promise<MemoryFile[]>;
  rewriteProjectedEntityReferences(mappings: Readonly<Record<string, string>>): Promise<void>;
  rewriteProjectedMemoryEntityReference(
    memoryId: string,
    previousEntityRef: string,
    nextEntityRef: string,
  ): Promise<void>;
  invalidateKnowledgeIndexCache(): void;
  invalidateAllMemoriesCache(): void;
  invalidateColdMemoriesCache(): void;
  bumpMemoryStatusVersion(): void;
}

function statePath(deps: EntityCanonicalIdMigrationDependencies): string {
  return path.join(deps.stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE);
}

function lockPath(deps: EntityCanonicalIdMigrationDependencies): string {
  return path.join(deps.stateDir, "entity-canonical-id-migration.lock");
}

async function readState(
  deps: EntityCanonicalIdMigrationDependencies
): Promise<EntityCanonicalIdMigrationState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(deps), "utf-8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid entity canonical-id migration state.");
  }
  const result = EntityCanonicalIdMigrationStateSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid entity canonical-id migration state.");
  return result.data;
}

async function writeState(
  deps: EntityCanonicalIdMigrationDependencies,
  state: EntityCanonicalIdMigrationState
): Promise<void> {
  const destination = statePath(deps);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function sameFileIdentity(leftPath: string, rightPath: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([statFile(leftPath), statFile(rightPath)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertNotSymlink(filePath: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing entity canonical-id migration through symlink: ${label}.`);
  }
}

async function readSafeEntityEntries(entitiesDir: string): Promise<string[]> {
  const rootStat = await lstat(entitiesDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Refusing entity canonical-id migration through a symlinked or non-directory entities root.");
  }
  const entries = await readdir(entitiesDir);
  for (const entry of entries) {
    await assertNotSymlink(path.join(entitiesDir, entry), entry);
  }
  return entries;
}

async function discoverMappings(deps: EntityCanonicalIdMigrationDependencies): Promise<Record<string, string>> {
  const mappings: Record<string, string> = {};
  const canonicalOwners = new Map<string, string>();
  const entityEntries = await readSafeEntityEntries(deps.entitiesDir);
  for (const entry of entityEntries) {
    if (!entry.endsWith(".md")) continue;
    const legacyId = entry.slice(0, -".md".length);
    const legacyPath = deps.resolveEntityFilePath(legacyId);
    if (legacyPath === null) continue;
    const entityContent = await deps.readStorageSecureFile(legacyPath);
    if (
      !/^#[ \t]+[^\r\n \t]/m.test(entityContent)
      || !/^\*\*Type:\*\*[ \t]*[^\r\n \t]/m.test(entityContent)
    ) {
      throw new Error(`Cannot migrate malformed entity file ${entry}: missing name heading or type.`);
    }
    const entity = deps.parseEntityFile(entityContent);
    if (!entity.name.trim() || !entity.type.trim()) {
      throw new Error(`Cannot migrate malformed entity file ${entry}: missing name or type.`);
    }
    const canonicalId = deps.normalizeEntityName(entity.name, entity.type);
    if (legacyId === canonicalId) continue;
    const canonicalPath = deps.resolveEntityFilePath(canonicalId);
    if (canonicalPath === null) continue;
    const canonicalExists = await fileExists(canonicalPath);
    if (canonicalExists && await sameFileIdentity(legacyPath, canonicalPath)) continue;
    if (canonicalExists) {
      const canonicalContent = await deps.readStorageSecureFile(canonicalPath);
      if (entityContent !== canonicalContent) {
        throw new Error(`Cannot migrate legacy entity id ${legacyId}: ${canonicalId} already exists.`);
      }
    }
    const previousOwner = canonicalOwners.get(canonicalId);
    if (previousOwner !== undefined && previousOwner !== legacyId) {
      throw new Error(
        `Cannot migrate legacy entity ids ${previousOwner} and ${legacyId}: both normalize to ${canonicalId}.`,
      );
    }
    canonicalOwners.set(canonicalId, legacyId);
    mappings[legacyId] = canonicalId;
  }
  return mappings;
}

async function rewriteReferences(
  deps: EntityCanonicalIdMigrationDependencies,
  mappings: Readonly<Record<string, string>>,
  refreshLock: () => Promise<boolean>
): Promise<{ rewroteColdMemory: boolean }> {
  let rewroteColdMemory = false;
  for (let pass = 0; pass < MEMORY_REWRITE_MAX_PASSES; pass += 1) {
    deps.invalidateAllMemoriesCache();
    deps.invalidateColdMemoriesCache();
    const [hotMemories, coldMemories, archivedMemories] = await Promise.all([
      deps.readAllMemories(),
      deps.readAllColdMemories(),
      deps.readArchivedMemories(),
    ]);
    const seenPaths = new Set<string>();
    let rewroteAny = false;
    for (const memory of [...hotMemories, ...coldMemories, ...archivedMemories]) {
      const memoryPath = path.resolve(memory.path);
      if (seenPaths.has(memoryPath)) continue;
      seenPaths.add(memoryPath);
      const previousEntityRef = memory.frontmatter.entityRef;
      const canonicalId = previousEntityRef ? mappings[previousEntityRef] : undefined;
      if (!previousEntityRef || !canonicalId) continue;
      if (!(await refreshLock())) throw new Error("Lost entity canonical-id migration lock.");
      const latestMemory = await deps.readMemoryByPath(memory.path);
      if (!latestMemory) continue;
      const latestPreviousEntityRef = latestMemory.frontmatter.entityRef;
      const latestCanonicalId = latestPreviousEntityRef ? mappings[latestPreviousEntityRef] : undefined;
      if (!latestPreviousEntityRef || !latestCanonicalId) continue;
      const memoryEncrypted = await deps.isEncryptedStorageFile(latestMemory.path);
      await deps.snapshotBeforeWrite(latestMemory.path, "write");
      await deps.writeStorageSecureFile(
        latestMemory.path,
        deps.serializeMemoryWithEntityRef(latestMemory, latestCanonicalId),
        memoryEncrypted,
      );
      await deps.rewriteProjectedMemoryEntityReference(
        latestMemory.frontmatter.id,
        latestPreviousEntityRef,
        latestCanonicalId,
      );
      rewroteAny = true;
      rewroteColdMemory ||= latestMemory.path.includes(`${path.sep}cold${path.sep}`);
    }
    if (!rewroteAny) return { rewroteColdMemory };
  }
  throw new Error("Memory references changed while entity canonical-id migration was running; retry migration.");
}

function rewriteTombstoneLine(
  line: string,
  mappings: Readonly<Record<string, string>>,
  normalizedMappings: ReadonlyMap<string, string>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;

  const tombstone = parsed as Record<string, unknown>;
  let changed = false;
  if (typeof tombstone.entityRef === "string") {
    const canonicalId = mappings[tombstone.entityRef];
    if (canonicalId) {
      tombstone.entityRef = canonicalId;
      changed = true;
    }
  }
  if (typeof tombstone.supersessionKey === "string") {
    const separator = tombstone.supersessionKey.indexOf("::");
    if (separator < 0) return changed ? JSON.stringify(tombstone) : line;
    const normalizedLegacyId = normalizeSupersessionKey(tombstone.supersessionKey.slice(0, separator));
    const canonicalId = normalizedMappings.get(normalizedLegacyId);
    if (canonicalId) {
      const canonicalKey = computeSupersessionKey(canonicalId, tombstone.supersessionKey.slice(separator + 2));
      if (canonicalKey) {
        tombstone.supersessionKey = canonicalKey;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(tombstone) : line;
}

async function rewriteTombstoneReferences(
  deps: EntityCanonicalIdMigrationDependencies,
  mappings: Readonly<Record<string, string>>,
  refreshLock: () => Promise<boolean>
): Promise<void> {
  const tombstonePath = path.join(deps.stateDir, "tombstones.jsonl");
  const normalizedMappings = new Map<string, string>();
  for (const [legacyId, canonicalId] of Object.entries(mappings)) {
    const normalizedLegacyId = normalizeSupersessionKey(legacyId);
    if (normalizedLegacyId && !normalizedMappings.has(normalizedLegacyId)) {
      normalizedMappings.set(normalizedLegacyId, canonicalId);
    }
  }

  await withHeldFileLock(
    path.join(deps.stateDir, "tombstones.lock"),
    {
      staleMs: TOMBSTONE_LOCK_STALE_MS,
      maxWaitMs: TOMBSTONE_LOCK_MAX_WAIT_MS,
    },
    async (acquired, tombstoneLock) => {
      if (!acquired) throw new Error("Timed out waiting for active tombstone migration.");
      if (!(await fileExists(tombstonePath))) return;
      const tombstoneEncrypted = await deps.isEncryptedStorageFile(tombstonePath);
      const original = await deps.readStorageSecureFile(tombstonePath);
      let changed = false;
      const rewritten = original
        .split("\n")
        .map((line) => {
          const next = rewriteTombstoneLine(line, mappings, normalizedMappings);
          changed ||= next !== line;
          return next;
        })
        .join("\n");
      if (!changed) return;
      if (!(await refreshLock())) throw new Error("Lost entity canonical-id migration lock.");
      if (!(await tombstoneLock.refresh())) throw new Error("Lost tombstone migration lock.");
      await deps.snapshotBeforeWrite(tombstonePath, "write");
      await deps.writeStorageSecureFile(tombstonePath, rewritten, tombstoneEncrypted);
    },
  );
}

async function rewriteRelationshipTargets(
  deps: EntityCanonicalIdMigrationDependencies,
  mappings: Readonly<Record<string, string>>,
  refreshLock: () => Promise<boolean>
): Promise<boolean> {
  let rewritten = false;
  const entries = await readSafeEntityEntries(deps.entitiesDir);
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const entityPath = deps.resolveEntityFilePath(entry.slice(0, -".md".length));
    if (entityPath === null) continue;
    const entity = deps.parseEntityFile(await deps.readStorageSecureFile(entityPath));
    const relationships = entity.relationships.map((relationship) => {
      const target = mappings[relationship.target];
      return target ? { ...relationship, target } : relationship;
    });
    if (relationships.every((relationship, index) => relationship === entity.relationships[index])) continue;
    if (!(await refreshLock())) throw new Error("Lost entity canonical-id migration lock.");
    const latestEntity = deps.parseEntityFile(await deps.readStorageSecureFile(entityPath));
    const latestRelationships = latestEntity.relationships.map((relationship) => {
      const target = mappings[relationship.target];
      return target ? { ...relationship, target } : relationship;
    });
    if (latestRelationships.every((relationship, index) => relationship === latestEntity.relationships[index])) continue;
    const entityEncrypted = await deps.isEncryptedStorageFile(entityPath);
    await deps.snapshotBeforeWrite(entityPath, "write");
    await deps.writeStorageSecureFile(
      entityPath,
      deps.serializeEntityFile({ ...latestEntity, relationships: latestRelationships }),
      entityEncrypted,
    );
    rewritten = true;
  }
  return rewritten;
}

function mergeDiscoveredMappings(
  existing: Readonly<Record<string, string>>,
  discovered: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = { ...existing };
  const canonicalOwners = new Map<string, string>();
  for (const [legacyId, canonicalId] of Object.entries(merged)) {
    const previousOwner = canonicalOwners.get(canonicalId);
    if (previousOwner !== undefined && previousOwner !== legacyId) {
      throw new Error(
        `Cannot migrate legacy entity ids ${previousOwner} and ${legacyId}: both normalize to ${canonicalId}.`,
      );
    }
    canonicalOwners.set(canonicalId, legacyId);
  }
  for (const [legacyId, canonicalId] of Object.entries(discovered)) {
    const previousMapping = merged[legacyId];
    if (previousMapping !== undefined && previousMapping !== canonicalId) {
      throw new Error(`Legacy entity id ${legacyId} changed canonical target during migration.`);
    }
    const previousOwner = canonicalOwners.get(canonicalId);
    if (previousOwner !== undefined && previousOwner !== legacyId) {
      throw new Error(
        `Cannot migrate legacy entity ids ${previousOwner} and ${legacyId}: both normalize to ${canonicalId}.`,
      );
    }
    merged[legacyId] = canonicalId;
    canonicalOwners.set(canonicalId, legacyId);
  }
  return merged;
}

export async function migrateLegacyEntityCanonicalIds(deps: EntityCanonicalIdMigrationDependencies): Promise<void> {
  await withHeldFileLock(
    lockPath(deps),
    {
      staleMs: ENTITY_CANONICAL_ID_MIGRATION_LOCK_STALE_MS,
      maxWaitMs: ENTITY_CANONICAL_ID_MIGRATION_LOCK_MAX_WAIT_MS,
    },
    async (acquired, lock) => {
      if (!acquired) throw new Error("Timed out waiting for active entity canonical-id migration.");
      await readSafeEntityEntries(deps.entitiesDir);
      let state = await readState(deps);
      if (!state) {
        state = {
          version: ENTITY_CANONICAL_ID_MIGRATION_VERSION,
          complete: false,
          mappings: {},
        };
      }
      for (let migrationPass = 0; migrationPass < ENTITY_MAPPING_RESCAN_MAX_PASSES; migrationPass += 1) {
        if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
        const discoveredBefore = await discoverMappings(deps);
        const mergedBefore = mergeDiscoveredMappings(state.mappings, discoveredBefore);
        if (state.complete && Object.keys(discoveredBefore).length === 0) return;
        if (
          state.complete
          || Object.keys(discoveredBefore).length > 0
          || Object.keys(mergedBefore).length !== Object.keys(state.mappings).length
        ) {
          state = { ...state, complete: false, mappings: mergedBefore };
          await writeState(deps, state);
        }
        if (Object.keys(state.mappings).length === 0) {
          if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
          const discoveredAfter = await discoverMappings(deps);
          if (Object.keys(discoveredAfter).length === 0) {
            await writeState(deps, { ...state, complete: true });
            return;
          }
          state = {
            ...state,
            complete: false,
            mappings: mergeDiscoveredMappings(state.mappings, discoveredAfter),
          };
          await writeState(deps, state);
          continue;
        }
        for (const [legacyId, canonicalId] of Object.entries(state.mappings)) {
          const legacyPath = deps.resolveEntityFilePath(legacyId);
          const canonicalPath = deps.resolveEntityFilePath(canonicalId);
          if (legacyPath === null || canonicalPath === null) {
            throw new Error("Invalid entity canonical-id migration path.");
          }
          await assertNotSymlink(legacyPath, legacyId);
          await assertNotSymlink(canonicalPath, canonicalId);
          const legacyExists = await fileExists(legacyPath);
          const canonicalExists = await fileExists(canonicalPath);
          if (legacyExists && canonicalExists) {
            if (await sameFileIdentity(legacyPath, canonicalPath)) continue;
            const [legacyContent, canonicalContent, legacyEncrypted, canonicalEncrypted] = await Promise.all([
              deps.readStorageSecureFile(legacyPath),
              deps.readStorageSecureFile(canonicalPath),
              deps.isEncryptedStorageFile(legacyPath),
              deps.isEncryptedStorageFile(canonicalPath),
            ]);
            if (legacyContent !== canonicalContent) {
              throw new Error(`Cannot migrate legacy entity id ${legacyId}: ${canonicalId} already exists.`);
            }
            if (legacyEncrypted && !canonicalEncrypted) {
              if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
              await deps.snapshotBeforeWrite(canonicalPath, "write");
              await deps.writeStorageSecureFile(canonicalPath, legacyContent, true);
              if ((await deps.readStorageSecureFile(canonicalPath)) !== legacyContent) {
                throw new Error(`Cannot verify migrated entity id ${canonicalId}.`);
              }
            }
            if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
            await deps.snapshotBeforeWrite(legacyPath, "write");
            await unlink(legacyPath);
            continue;
          }
          if (!legacyExists && !canonicalExists) {
            throw new Error(`Cannot migrate legacy entity id ${legacyId}: both files are missing.`);
          }
          if (!legacyExists) continue;
          if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
          const entityEncrypted = await deps.isEncryptedStorageFile(legacyPath);
          const entityContent = await deps.readStorageSecureFile(legacyPath);
          await deps.snapshotBeforeWrite(legacyPath, "write");
          await deps.writeStorageSecureFile(canonicalPath, entityContent, entityEncrypted);
          if ((await deps.readStorageSecureFile(canonicalPath)) !== entityContent) {
            throw new Error(`Cannot verify migrated entity id ${canonicalId}.`);
          }
          if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
          await unlink(legacyPath);
        }

        await rewriteRelationshipTargets(deps, state.mappings, () => lock.refresh());
        let rewroteColdMemory = (await rewriteReferences(deps, state.mappings, () => lock.refresh())).rewroteColdMemory;
        await rewriteTombstoneReferences(deps, state.mappings, () => lock.refresh());
        await deps.rewriteProjectedEntityReferences(state.mappings);
        const finalMemoryPass = await rewriteReferences(deps, state.mappings, () => lock.refresh());
        rewroteColdMemory ||= finalMemoryPass.rewroteColdMemory;
        deps.invalidateKnowledgeIndexCache();
        deps.invalidateAllMemoriesCache();
        if (rewroteColdMemory) deps.invalidateColdMemoriesCache();
        deps.bumpMemoryStatusVersion();

        if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
        const discoveredAfter = await discoverMappings(deps);
        if (Object.keys(discoveredAfter).length === 0) {
          await writeState(deps, { ...state, complete: true });
          return;
        }
        state = {
          ...state,
          complete: false,
          mappings: mergeDiscoveredMappings(state.mappings, discoveredAfter),
        };
        await writeState(deps, state);
      }
      throw new Error("Entity canonical-id migration mappings changed while migration was running; retry migration.");
    }
  );
}
