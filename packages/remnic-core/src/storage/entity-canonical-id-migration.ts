import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeLegacyEntityName } from "../entity-id-normalization.js";
import type { EntityFile, MemoryFile } from "../types.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";

const ENTITY_CANONICAL_ID_MIGRATION_VERSION = 1;
const ENTITY_CANONICAL_ID_MIGRATION_FILE = "entity-canonical-id-migration-v1.json";
const ENTITY_CANONICAL_ID_MIGRATION_LOCK_STALE_MS = 60_000;
const ENTITY_CANONICAL_ID_MIGRATION_LOCK_MAX_WAIT_MS = 300_000;

const EntityCanonicalIdMigrationStateSchema = z.object({
  version: z.literal(ENTITY_CANONICAL_ID_MIGRATION_VERSION),
  complete: z.boolean(),
  mappings: z.record(z.string().min(1)),
});

type EntityCanonicalIdMigrationState = z.infer<typeof EntityCanonicalIdMigrationStateSchema>;

export interface EntityCanonicalIdMigrationDependencies {
  stateDir: string;
  entitiesDir: string;
  entityAliases: Readonly<Record<string, string>>;
  normalizeEntityName(raw: string, type: string): string;
  resolveEntityFilePath(id: string): string | null;
  readStorageSecureFile(filePath: string): Promise<string>;
  writeStorageSecureFile(filePath: string, content: string): Promise<void>;
  snapshotBeforeWrite(filePath: string, trigger: "write"): Promise<void>;
  parseEntityFile(content: string): EntityFile;
  serializeEntityFile(entity: EntityFile): string;
  serializeMemoryWithEntityRef(memory: MemoryFile, entityRef: string): string;
  readAllMemories(): Promise<MemoryFile[]>;
  readAllColdMemories(): Promise<MemoryFile[]>;
  readArchivedMemories(): Promise<MemoryFile[]>;
  rewriteProjectedEntityReferences(mappings: Readonly<Record<string, string>>): void;
  rewriteProjectedMemoryEntityReference(memoryId: string, previousEntityRef: string, nextEntityRef: string): void;
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

async function discoverMappings(deps: EntityCanonicalIdMigrationDependencies): Promise<Record<string, string>> {
  const mappings: Record<string, string> = {};
  const entityEntries = await readdir(deps.entitiesDir);
  for (const entry of entityEntries) {
    if (!entry.endsWith(".md")) continue;
    const legacyId = entry.slice(0, -".md".length);
    const legacyPath = deps.resolveEntityFilePath(legacyId);
    if (legacyPath === null) continue;
    const entity = deps.parseEntityFile(await deps.readStorageSecureFile(legacyPath));
    const previousCanonicalId = normalizeLegacyEntityName(entity.name, entity.type, deps.entityAliases);
    const canonicalId = deps.normalizeEntityName(entity.name, entity.type);
    if (legacyId !== previousCanonicalId || previousCanonicalId === canonicalId) continue;
    const canonicalPath = deps.resolveEntityFilePath(canonicalId);
    if (canonicalPath === null) continue;
    if (await fileExists(canonicalPath)) {
      throw new Error(`Cannot migrate legacy entity id ${legacyId}: ${canonicalId} already exists.`);
    }
    mappings[legacyId] = canonicalId;
  }
  return mappings;
}

async function rewriteReferences(
  deps: EntityCanonicalIdMigrationDependencies,
  mappings: Readonly<Record<string, string>>,
  refreshLock: () => Promise<boolean>
): Promise<{ rewroteColdMemory: boolean }> {
  const [hotMemories, coldMemories, archivedMemories] = await Promise.all([
    deps.readAllMemories(),
    deps.readAllColdMemories(),
    deps.readArchivedMemories(),
  ]);
  const seenPaths = new Set<string>();
  let rewroteColdMemory = false;
  for (const memory of [...hotMemories, ...coldMemories, ...archivedMemories]) {
    const memoryPath = path.resolve(memory.path);
    if (seenPaths.has(memoryPath)) continue;
    seenPaths.add(memoryPath);
    const previousEntityRef = memory.frontmatter.entityRef;
    const canonicalId = previousEntityRef ? mappings[previousEntityRef] : undefined;
    if (!previousEntityRef || !canonicalId) continue;
    if (!(await refreshLock())) throw new Error("Lost entity canonical-id migration lock.");
    await deps.snapshotBeforeWrite(memory.path, "write");
    await deps.writeStorageSecureFile(memory.path, deps.serializeMemoryWithEntityRef(memory, canonicalId));
    deps.rewriteProjectedMemoryEntityReference(memory.frontmatter.id, previousEntityRef, canonicalId);
    rewroteColdMemory ||= memory.path.includes(`${path.sep}cold${path.sep}`);
  }
  return { rewroteColdMemory };
}

async function rewriteRelationshipTargets(
  deps: EntityCanonicalIdMigrationDependencies,
  mappings: Readonly<Record<string, string>>,
  refreshLock: () => Promise<boolean>
): Promise<boolean> {
  let rewritten = false;
  const entries = await readdir(deps.entitiesDir);
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
    await deps.snapshotBeforeWrite(entityPath, "write");
    await deps.writeStorageSecureFile(entityPath, deps.serializeEntityFile({ ...entity, relationships }));
    rewritten = true;
  }
  return rewritten;
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
      let state = await readState(deps);
      if (state?.complete) return;
      if (!state) {
        state = {
          version: ENTITY_CANONICAL_ID_MIGRATION_VERSION,
          complete: false,
          mappings: await discoverMappings(deps),
        };
        await writeState(deps, state);
      }
      if (Object.keys(state.mappings).length === 0) {
        await writeState(deps, { ...state, complete: true });
        return;
      }
      for (const [legacyId, canonicalId] of Object.entries(state.mappings)) {
        const legacyPath = deps.resolveEntityFilePath(legacyId);
        const canonicalPath = deps.resolveEntityFilePath(canonicalId);
        if (legacyPath === null || canonicalPath === null) {
          throw new Error("Invalid entity canonical-id migration path.");
        }
        const legacyExists = await fileExists(legacyPath);
        const canonicalExists = await fileExists(canonicalPath);
        if (legacyExists && canonicalExists) {
          const [legacyContent, canonicalContent] = await Promise.all([
            deps.readStorageSecureFile(legacyPath),
            deps.readStorageSecureFile(canonicalPath),
          ]);
          if (legacyContent !== canonicalContent) {
            throw new Error(`Cannot migrate legacy entity id ${legacyId}: ${canonicalId} already exists.`);
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
        const entityContent = await deps.readStorageSecureFile(legacyPath);
        await deps.snapshotBeforeWrite(legacyPath, "write");
        await deps.writeStorageSecureFile(canonicalPath, entityContent);
        if ((await deps.readStorageSecureFile(canonicalPath)) !== entityContent) {
          throw new Error(`Cannot verify migrated entity id ${canonicalId}.`);
        }
        if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
        await unlink(legacyPath);
      }

      await rewriteRelationshipTargets(deps, state.mappings, () => lock.refresh());
      const { rewroteColdMemory } = await rewriteReferences(deps, state.mappings, () => lock.refresh());
      deps.rewriteProjectedEntityReferences(state.mappings);
      deps.invalidateKnowledgeIndexCache();
      deps.invalidateAllMemoriesCache();
      if (rewroteColdMemory) deps.invalidateColdMemoriesCache();
      deps.bumpMemoryStatusVersion();
      await writeState(deps, { ...state, complete: true });
    }
  );
}
