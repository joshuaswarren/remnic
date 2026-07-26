import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  stat as statFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { computeSupersessionKey, normalizeSupersessionKey } from "../temporal-supersession.js";
import type { EntityFile, MemoryFile } from "../types.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";

const ENTITY_CANONICAL_ID_MIGRATION_VERSION = 1;
export const ENTITY_CANONICAL_ID_MIGRATION_FILE = "entity-canonical-id-migration-v1.json";
const ENTITY_CANONICAL_ID_MIGRATION_LOCK_STALE_MS = 60_000;
const ENTITY_CANONICAL_ID_MIGRATION_LOCK_MAX_WAIT_MS = 300_000;
const TOMBSTONE_LOCK_STALE_MS = 30_000;
const TOMBSTONE_LOCK_MAX_WAIT_MS = 5_000;
const ENTITY_CANONICAL_ID_MUTATION_LOCK_STALE_MS = 60_000;
const ENTITY_CANONICAL_ID_MUTATION_LOCK_MAX_WAIT_MS = 300_000;
const MEMORY_REWRITE_MAX_PASSES = 3;
const ENTITY_MAPPING_RESCAN_MAX_PASSES = 3;

export function loadHistoricalEntityCanonicalIds(stateDir: string): Readonly<Record<string, string>> {
  const statePath = path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE);
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const mappings = (parsed as { mappings?: unknown }).mappings;
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return {};
    const cleaned: Record<string, string> = {};
    for (const [legacyId, canonicalId] of Object.entries(mappings)) {
      if (legacyId.length > 0 && typeof canonicalId === "string" && canonicalId.length > 0) {
        cleaned[legacyId] = canonicalId;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

export function resolveHistoricalEntityCanonicalId(
  normalized: string,
  mappings: Readonly<Record<string, string>>,
): string {
  let current = normalized;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = mappings[current];
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

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
  validateMemoryScanRoots?(): Promise<void>;
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
  readMigrationFingerprint?(): Promise<string>;
}

async function fingerprintPath(filePath: string): Promise<string> {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
  return fileStat
    ? `${fileStat.dev}:${fileStat.ino}:${fileStat.mtimeMs}:${fileStat.ctimeMs}:${fileStat.size}`
    : "missing";
}

export async function getFingerprint(
  baseDir: string,
  entitiesDir: string,
  getCorpusScanVersion: () => string,
): Promise<string> {
  const [entityFingerprint, aliasFingerprint] = await Promise.all([
    fingerprintPath(entitiesDir),
    fingerprintPath(path.join(baseDir, "config", "aliases.json")),
  ]);
  return `${entityFingerprint}:${aliasFingerprint}:${getCorpusScanVersion()}`;
}

export async function validateRoots(
  baseDir: string,
  entitiesDir: string,
  stateDir: string,
  archiveDir: string,
): Promise<void> {
  let baseStat;
  try {
    baseStat = await lstat(baseDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error(`Refusing entity canonical-id migration through unsafe memory root: ${baseDir}.`);
  }
  const memoryRoot = await realpath(baseDir);
  const roots = [
    entitiesDir,
    stateDir,
    ...RECALL_FALLBACK_DIRS.map((directory) => path.join(baseDir, directory)),
    path.join(baseDir, "cold"),
    archiveDir,
  ];
  for (const root of roots) {
    let rootStat;
    try {
      rootStat = await lstat(root);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) continue;
      throw error;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Refusing entity canonical-id migration through unsafe memory root: ${root}.`);
    }
    assertPathInsideRoot(memoryRoot, await realpath(root), root);
  }
}

function statePath(deps: EntityCanonicalIdMigrationDependencies): string {
  return path.join(deps.stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE);
}

async function assertSafeMigrationStateFile(
  deps: EntityCanonicalIdMigrationDependencies,
): Promise<void> {
  const migrationStatePath = statePath(deps);
  let fileStat;
  try {
    fileStat = await lstat(migrationStatePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(
      `Refusing entity canonical-id migration through unsafe migration state file: ${migrationStatePath}.`,
    );
  }
  const [stateRoot, stateFile] = await Promise.all([
    realpath(deps.stateDir),
    realpath(migrationStatePath),
  ]);
  assertPathInsideRoot(stateRoot, stateFile, migrationStatePath);
}
async function assertSafeTombstoneFile(
  deps: EntityCanonicalIdMigrationDependencies,
  tombstonePath: string,
): Promise<boolean> {
  let fileStat;
  try {
    fileStat = await lstat(tombstonePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(
      `Refusing entity canonical-id migration through unsafe tombstone ledger: ${tombstonePath}.`,
    );
  }
  const [stateRoot, tombstoneFile] = await Promise.all([
    realpath(deps.stateDir),
    realpath(tombstonePath),
  ]);
  assertPathInsideRoot(stateRoot, tombstoneFile, tombstonePath);
  return true;
}

function lockPath(deps: EntityCanonicalIdMigrationDependencies): string {
  return path.join(deps.stateDir, "entity-canonical-id-migration.lock");
}

export async function withEntityCanonicalMutationLock<T>(
  stateDir: string,
  task: (refreshLock: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  return withHeldFileLock(
    path.join(stateDir, "entity-canonical-id-mutation.lock"),
    {
      staleMs: ENTITY_CANONICAL_ID_MUTATION_LOCK_STALE_MS,
      maxWaitMs: ENTITY_CANONICAL_ID_MUTATION_LOCK_MAX_WAIT_MS,
    },
    async (acquired, lock) => {
      if (!acquired) throw new Error("Timed out waiting for entity mutation lock.");
      return task(() => lock.refresh());
    },
  );
}

async function readState(
  deps: EntityCanonicalIdMigrationDependencies
): Promise<EntityCanonicalIdMigrationState | null> {
  await assertSafeMigrationStateFile(deps);
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

function assertSafeEntityId(entityId: string): void {
  if (/[\/\\\0]/.test(entityId)) {
    throw new Error(`Refusing entity canonical-id migration through unsafe entity id: ${entityId}.`);
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
async function assertNotMemorySymlink(filePath: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing entity canonical-id migration through symlinked memory: ${filePath}.`);
  }
}
async function assertEntityContentUnchanged(
  deps: EntityCanonicalIdMigrationDependencies,
  filePath: string,
  expectedContent: string,
  legacyId: string,
): Promise<void> {
  const latestContent = await deps.readStorageSecureFile(filePath);
  if (latestContent !== expectedContent) {
    throw new Error(`Legacy entity id ${legacyId} changed while migration was running; retry migration.`);
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

/**
 * Legacy ids the migration cannot resolve on its own, mapped to the canonical
 * id they collide with. Two entity files describing one entity is an ORDINARY
 * operator state, and picking a winner would silently drop whichever side lost.
 * So the pair is skipped and reported: reads of the legacy id keep working
 * exactly as they did before the migration ran.
 */
export type BlockedEntityPairs = Map<string, string>;

async function discoverMappings(
  deps: EntityCanonicalIdMigrationDependencies,
  knownMappings: Readonly<Record<string, string>> = {},
  blocked: BlockedEntityPairs = new Map(),
): Promise<Record<string, string>> {
  const mappings: Record<string, string> = {};
  const canonicalOwners = new Map<string, string[]>();
  const entityEntries = await readSafeEntityEntries(deps.entitiesDir);
  for (const entry of entityEntries) {
    if (!entry.endsWith(".md")) continue;
    const legacyId = entry.slice(0, -".md".length);
    assertSafeEntityId(legacyId);
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
    assertSafeEntityId(canonicalId);
    if (legacyId === canonicalId) continue;
    const canonicalPath = deps.resolveEntityFilePath(canonicalId);
    if (canonicalPath === null) continue;
    const canonicalExists = await fileExists(canonicalPath);
    if (
      canonicalExists
      && await sameFileIdentity(legacyPath, canonicalPath)
      && knownMappings[legacyId] === canonicalId
    ) continue;
    if (canonicalExists) {
      const canonicalContent = await deps.readStorageSecureFile(canonicalPath);
      if (entityContent !== canonicalContent) {
        blocked.set(legacyId, canonicalId);
        continue;
      }
    }
    canonicalOwners.set(canonicalId, [...(canonicalOwners.get(canonicalId) ?? []), legacyId]);
    mappings[legacyId] = canonicalId;
  }
  // A canonical id claimed by more than one legacy file has no non-arbitrary
  // winner, and readdir order is not stable (§6) - so the "winner" would differ
  // between hosts reading identical data. Block every claimant instead.
  for (const [canonicalId, claimants] of canonicalOwners) {
    if (claimants.length < 2) continue;
    for (const legacyId of claimants) {
      blocked.set(legacyId, canonicalId);
      delete mappings[legacyId];
    }
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
      await assertNotMemorySymlink(memory.path);
      const observedMemoryFingerprint = await fingerprintPath(memory.path);
      if (observedMemoryFingerprint === "missing") continue;
      if (!(await refreshLock())) throw new Error("Lost entity canonical-id migration lock.");
      const latestMemory = await deps.readMemoryByPath(memory.path);
      if (!latestMemory) continue;
      const latestMemoryFingerprint = await fingerprintPath(latestMemory.path);
      if (latestMemoryFingerprint !== observedMemoryFingerprint) continue;
      const latestPreviousEntityRef = latestMemory.frontmatter.entityRef;
      const latestCanonicalId = latestPreviousEntityRef ? mappings[latestPreviousEntityRef] : undefined;
      if (!latestPreviousEntityRef || !latestCanonicalId) continue;
      const memoryEncrypted = await deps.isEncryptedStorageFile(latestMemory.path);
      if ((await fingerprintPath(latestMemory.path)) !== latestMemoryFingerprint) continue;
      await deps.snapshotBeforeWrite(latestMemory.path, "write");
      if ((await fingerprintPath(latestMemory.path)) !== latestMemoryFingerprint) continue;
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
      if (!(await assertSafeTombstoneFile(deps, tombstonePath))) return;
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
    const observedEntityFingerprint = await fingerprintPath(entityPath);
    if (observedEntityFingerprint === "missing") continue;
    const entity = deps.parseEntityFile(await deps.readStorageSecureFile(entityPath));
    const relationships = entity.relationships.map((relationship) => {
      const target = mappings[relationship.target];
      return target ? { ...relationship, target } : relationship;
    });
    if (relationships.every((relationship, index) => relationship === entity.relationships[index])) continue;
    const rewroteEntity = await withEntityCanonicalMutationLock(
      deps.stateDir,
      async (refreshEntityLock) => {
        if (!(await refreshLock())) throw new Error("Lost entity canonical-id migration lock.");
        const latestEntity = deps.parseEntityFile(await deps.readStorageSecureFile(entityPath));
        if ((await fingerprintPath(entityPath)) !== observedEntityFingerprint) return false;
        const latestRelationships = latestEntity.relationships.map((relationship) => {
          const target = mappings[relationship.target];
          return target ? { ...relationship, target } : relationship;
        });
        if (latestRelationships.every((relationship, index) => relationship === latestEntity.relationships[index])) {
          return false;
        }
        const entityEncrypted = await deps.isEncryptedStorageFile(entityPath);
        if (!(await refreshEntityLock())) throw new Error("Lost entity mutation lock.");
        if ((await fingerprintPath(entityPath)) !== observedEntityFingerprint) return false;
        await deps.snapshotBeforeWrite(entityPath, "write");
        if ((await fingerprintPath(entityPath)) !== observedEntityFingerprint) return false;
        await deps.writeStorageSecureFile(
          entityPath,
          deps.serializeEntityFile({ ...latestEntity, relationships: latestRelationships }),
          entityEncrypted,
        );
        return true;
      },
    );
    rewritten ||= rewroteEntity;
  }
  return rewritten;
}

async function rewriteKnownReferences(
  deps: EntityCanonicalIdMigrationDependencies,
  mappings: Readonly<Record<string, string>>,
  refreshLock: () => Promise<boolean>,
): Promise<boolean> {
  await rewriteRelationshipTargets(deps, mappings, refreshLock);
  let rewroteColdMemory = (await rewriteReferences(deps, mappings, refreshLock)).rewroteColdMemory;
  await rewriteTombstoneReferences(deps, mappings, refreshLock);
  await deps.rewriteProjectedEntityReferences(mappings);
  const finalMemoryPass = await rewriteReferences(deps, mappings, refreshLock);
  rewroteColdMemory ||= finalMemoryPass.rewroteColdMemory;
  return rewroteColdMemory;
}

function wouldCreateMappingCycle(
  mappings: Readonly<Record<string, string>>,
  legacyId: string,
  canonicalId: string,
): boolean {
  let current = canonicalId;
  const seen = new Set<string>();
  while (true) {
    if (current === legacyId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const next = mappings[current];
    if (!next || next === current) return false;
    current = next;
  }
}

function rejectMappingCycles(
  existing: Readonly<Record<string, string>>,
  discovered: Readonly<Record<string, string>>,
): Record<string, string> {
  const accepted: Record<string, string> = {};
  const merged = { ...existing };
  for (const [legacyId, canonicalId] of Object.entries(discovered)) {
    if (
      merged[legacyId] === undefined &&
      wouldCreateMappingCycle(merged, legacyId, canonicalId)
    ) continue;
    accepted[legacyId] = canonicalId;
    merged[legacyId] = canonicalId;
  }
  return accepted;
}

function mergeDiscoveredMappings(
  existing: Readonly<Record<string, string>>,
  discovered: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = { ...existing };
  const canonicalOwners = new Map<string, string>();
  for (const [legacyId, canonicalId] of Object.entries(discovered)) {
    const previousMapping = merged[legacyId];
    if (previousMapping !== undefined && previousMapping !== canonicalId) {
      throw new Error(`Legacy entity id ${legacyId} changed canonical target during migration.`);
    }
    if (previousMapping === undefined && wouldCreateMappingCycle(merged, legacyId, canonicalId)) continue;
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
function collapseMappings(mappings: Readonly<Record<string, string>>): Record<string, string> {
  const collapsed: Record<string, string> = {};
  for (const legacyId of Object.keys(mappings)) {
    let current = legacyId;
    const seen = new Set<string>();
    while (true) {
      const next = mappings[current];
      if (!next || next === current) break;
      if (seen.has(current)) {
        throw new Error(`Entity canonical-id migration mapping cycle includes ${legacyId}.`);
      }
      seen.add(current);
      current = next;
    }
    if (current !== legacyId) collapsed[legacyId] = current;
  }
  return collapsed;
}

type EntityFileMigrationResult = {
  deferred: boolean;
  progressed: boolean;
  /** The pair collided on content; skipped and reported, never migrated. */
  blocked?: boolean;
};

async function migrateEntityFilePair(
  deps: EntityCanonicalIdMigrationDependencies,
  legacyId: string,
  canonicalId: string,
  refreshMigrationLock: () => Promise<boolean>,
): Promise<EntityFileMigrationResult> {
  return withEntityCanonicalMutationLock(deps.stateDir, async (refreshEntityLock) => {
    assertSafeEntityId(legacyId);
    assertSafeEntityId(canonicalId);
    const legacyPath = deps.resolveEntityFilePath(legacyId);
    const canonicalPath = deps.resolveEntityFilePath(canonicalId);
    if (legacyPath === null || canonicalPath === null) {
      throw new Error("Invalid entity canonical-id migration path.");
    }
    await assertNotSymlink(legacyPath, legacyId);
    await assertNotSymlink(canonicalPath, canonicalId);
    const legacyExists = await fileExists(legacyPath);
    const canonicalExists = await fileExists(canonicalPath);
    if (!legacyExists && !canonicalExists) return { deferred: true, progressed: false };
    if (legacyExists && canonicalExists) {
      if (await sameFileIdentity(legacyPath, canonicalPath)) return { deferred: false, progressed: false };
      const [legacyContent, canonicalContent, legacyEncrypted, canonicalEncrypted] = await Promise.all([
        deps.readStorageSecureFile(legacyPath),
        deps.readStorageSecureFile(canonicalPath),
        deps.isEncryptedStorageFile(legacyPath),
        deps.isEncryptedStorageFile(canonicalPath),
      ]);
      if (legacyContent !== canonicalContent) {
        // A mapping persisted by an older build, or a file changed since
        // discovery. Same verdict as discovery: skip the pair, keep both files.
        return { deferred: false, progressed: false, blocked: true };
      }
      if (legacyEncrypted && !canonicalEncrypted) {
        if (!(await refreshMigrationLock()) || !(await refreshEntityLock())) {
          throw new Error("Lost entity canonical-id migration lock.");
        }
        await deps.snapshotBeforeWrite(canonicalPath, "write");
        await deps.writeStorageSecureFile(canonicalPath, legacyContent, true);
        if ((await deps.readStorageSecureFile(canonicalPath)) !== legacyContent) {
          throw new Error(`Cannot verify migrated entity id ${canonicalId}.`);
        }
      }
      if (!(await refreshMigrationLock()) || !(await refreshEntityLock())) {
        throw new Error("Lost entity canonical-id migration lock.");
      }
      await deps.snapshotBeforeWrite(legacyPath, "write");
      await assertNotSymlink(legacyPath, legacyId);
      await assertEntityContentUnchanged(deps, legacyPath, legacyContent, legacyId);
      await unlink(legacyPath);
      return { deferred: false, progressed: true };
    }
    if (!legacyExists) return { deferred: false, progressed: false };
    if (!(await refreshMigrationLock()) || !(await refreshEntityLock())) {
      throw new Error("Lost entity canonical-id migration lock.");
    }
    const entityEncrypted = await deps.isEncryptedStorageFile(legacyPath);
    const entityContent = await deps.readStorageSecureFile(legacyPath);
    await assertNotSymlink(legacyPath, legacyId);
    await assertEntityContentUnchanged(deps, legacyPath, entityContent, legacyId);
    let canonicalFingerprintAfterWrite: string | null = null;
    try {
      await deps.writeStorageSecureFile(canonicalPath, entityContent, entityEncrypted);
      canonicalFingerprintAfterWrite = await fingerprintPath(canonicalPath);
      if ((await deps.readStorageSecureFile(canonicalPath)) !== entityContent) {
        throw new Error(`Cannot verify migrated entity id ${canonicalId}.`);
      }
      if (!(await refreshMigrationLock()) || !(await refreshEntityLock())) {
        throw new Error("Lost entity canonical-id migration lock.");
      }
      await deps.snapshotBeforeWrite(legacyPath, "write");
      await assertNotSymlink(legacyPath, legacyId);
      await assertEntityContentUnchanged(deps, legacyPath, entityContent, legacyId);
      await unlink(legacyPath);
    } catch (error) {
      if (!canonicalExists && canonicalFingerprintAfterWrite !== null) {
        try {
          if ((await fingerprintPath(canonicalPath)) === canonicalFingerprintAfterWrite) {
            await assertNotSymlink(canonicalPath, canonicalId);
            await unlink(canonicalPath);
          }
        } catch {
          // Preserve the migration error when cleanup races another writer.
        }
      }
      throw error;
    }
    return { deferred: false, progressed: true };
  });
}

export async function migrateLegacyEntityCanonicalIds(
  deps: EntityCanonicalIdMigrationDependencies,
): Promise<string | undefined> {
  return withHeldFileLock(
    lockPath(deps),
    {
      staleMs: ENTITY_CANONICAL_ID_MIGRATION_LOCK_STALE_MS,
      maxWaitMs: ENTITY_CANONICAL_ID_MIGRATION_LOCK_MAX_WAIT_MS,
    },
    async (acquired, lock) => {
      if (!acquired) throw new Error("Timed out waiting for active entity canonical-id migration.");
      await deps.validateMemoryScanRoots?.();
      await readSafeEntityEntries(deps.entitiesDir);
      let state = await readState(deps);
      if (!state) {
        state = {
          version: ENTITY_CANONICAL_ID_MIGRATION_VERSION,
          complete: false,
          mappings: {},
        };
      }
      const blocked: BlockedEntityPairs = new Map();
      // ONE aggregated line per run, not one per pair per restart: this used to
      // abort the daemon, so the operator needs the whole list and the remedy.
      const finish = (): Promise<string | undefined> | string | undefined => {
        if (blocked.size > 0) {
          const pairs = [...blocked].map(([legacyId, canonicalId]) => `${legacyId} -> ${canonicalId}`).join(", ");
          log.warn(
            `entity canonical-id migration skipped ${blocked.size} unresolvable pair(s): ${pairs}. `
            + "Both files were kept and the legacy id still resolves; merge or delete one side to migrate it.",
          );
        }
        return deps.readMigrationFingerprint?.();
      };
      /**
       * Drop blocked pairs from the working set. Discovery only refuses to
       * ADD them; a mapping persisted by an earlier run would otherwise still
       * be applied - migrating one claimant and rewriting every reference onto
       * the canonical file, i.e. picking the winner this fix exists to avoid,
       * off stale state rather than what is on disk.
       */
      const pruneBlocked = async (): Promise<void> => {
        const current = state;
        if (blocked.size === 0 || !current) return;
        const remaining: Record<string, string> = Object.fromEntries(
          Object.entries(current.mappings).filter(([legacyId]) => !blocked.has(legacyId)),
        );
        if (Object.keys(remaining).length === Object.keys(current.mappings).length) return;
        state = { ...current, mappings: remaining };
        await writeState(deps, state);
      };
      const previousMappings = state.mappings;
      const collapsedMappings = collapseMappings(previousMappings);
      const mappingsChanged =
        Object.keys(collapsedMappings).length !== Object.keys(previousMappings).length
        || Object.entries(collapsedMappings).some(([legacyId, canonicalId]) =>
          previousMappings[legacyId] !== canonicalId
        );
      state = { ...state, mappings: collapsedMappings };
      for (let migrationPass = 0; migrationPass < ENTITY_MAPPING_RESCAN_MAX_PASSES; migrationPass += 1) {
        if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
        const discoveredBefore = rejectMappingCycles(
          state.mappings,
          await discoverMappings(deps, state.mappings, blocked),
        );
        await pruneBlocked();
        const mergedBefore = collapseMappings(mergeDiscoveredMappings(state.mappings, discoveredBefore));
        if (state.complete && Object.keys(discoveredBefore).length === 0 && !mappingsChanged) {
          if (Object.keys(state.mappings).length === 0) return finish();
          const rewroteColdMemory = await rewriteKnownReferences(
            deps,
            state.mappings,
            () => lock.refresh(),
          );
          deps.invalidateKnowledgeIndexCache();
          deps.invalidateAllMemoriesCache();
          if (rewroteColdMemory) deps.invalidateColdMemoriesCache();
          deps.bumpMemoryStatusVersion();
          return finish();
        }
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
          const discoveredAfter = rejectMappingCycles(
            state.mappings,
            await discoverMappings(deps, state.mappings, blocked),
          );
          if (Object.keys(discoveredAfter).length === 0) {
            await writeState(deps, { ...state, complete: true });
            return finish();
          }
          state = {
            ...state,
            complete: false,
            mappings: collapseMappings(mergeDiscoveredMappings(state.mappings, discoveredAfter)),
          };
          await writeState(deps, state);
          continue;
        }
        let pendingMappings = Object.entries(state.mappings);
        while (pendingMappings.length > 0) {
          const deferredMappings: Array<[string, string]> = [];
          let progressed = false;
          for (const [legacyId, canonicalId] of pendingMappings) {
            const result = await migrateEntityFilePair(
              deps,
              legacyId,
              canonicalId,
              () => lock.refresh(),
            );
            if (result.blocked) blocked.set(legacyId, canonicalId);
            else if (result.deferred) deferredMappings.push([legacyId, canonicalId]);
            progressed ||= result.progressed;
          }
          if (deferredMappings.length === 0) break;
          if (!progressed) {
            const [legacyId, canonicalId] = deferredMappings[0]!;
            throw new Error(
              `Cannot migrate legacy entity id ${legacyId}: both files are missing and no intermediate mapping can advance migration.`,
            );
          }
          pendingMappings = deferredMappings;
        }
        await pruneBlocked();

        const rewroteColdMemory = await rewriteKnownReferences(
          deps,
          state.mappings,
          () => lock.refresh(),
        );
        deps.invalidateKnowledgeIndexCache();
        deps.invalidateAllMemoriesCache();
        if (rewroteColdMemory) deps.invalidateColdMemoriesCache();
        deps.bumpMemoryStatusVersion();

        if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
        const discoveredAfter = rejectMappingCycles(
          state.mappings,
          await discoverMappings(deps, state.mappings, blocked),
        );
        await pruneBlocked();
        if (Object.keys(discoveredAfter).length === 0) {
          await writeState(deps, { ...state, complete: true });
          return finish();
        }
        state = {
          ...state,
          complete: false,
          mappings: collapseMappings(mergeDiscoveredMappings(state.mappings, discoveredAfter)),
        };
        await writeState(deps, state);
      }
      throw new Error("Entity canonical-id migration mappings changed while migration was running; retry migration.");
    }
  );
}
