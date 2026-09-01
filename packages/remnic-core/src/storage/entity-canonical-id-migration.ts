import { createHash, randomUUID } from "node:crypto";
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
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { computeSupersessionKey, normalizeSupersessionKey } from "../temporal-supersession.js";
import type { EntityFile, MemoryFile } from "../types.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";
import { withEntityCanonicalMutationLock } from "./entity-canonical-id-lock.js";
import { assertSafeEntityId } from "./entity-id-safety.js";

import {
  ENTITY_CANONICAL_ID_MIGRATION_FILE,
  ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER,
  ENTITY_CANONICAL_ID_RECONCILE_MARKER,
  resolveHistoricalEntityCanonicalId,
} from "./entity-canonical-id-references.js";

const ENTITY_CANONICAL_ID_MIGRATION_VERSION = 1;
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
  /**
   * Pairs the migration refused to resolve, PARKED rather than dropped.
   * Deleting the record would strand the collision: once an operator removes
   * the legacy file, no later scan can rediscover the mapping, so references
   * still naming the legacy id would never be rewritten. Optional so a journal
   * written by an older build still parses.
   */
  blocked: z.record(z.string().min(1)).optional(),
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

async function fingerprintEntityEntries(entitiesDir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(entitiesDir))
      .filter((name) => path.extname(name) === ".md")
      .sort();
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return "missing";
    throw error;
  }
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(`${name.length}:${name}:`);
    try {
      const entry = await lstat(path.join(entitiesDir, name), { bigint: true });
      hash.update(`${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
      hash.update("missing");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Completion fingerprint for migration inputs only. Entity entry identities
 * catch same-path edits that do not change the directory inode; the cooperative
 * sentinel covers managed writes. Memory-corpus writes stay excluded so plain
 * fact writes do not reopen migration.
 */
export async function getFingerprint(
  baseDir: string,
  entitiesDir: string,
  getEntityMutationVersion: () => string,
): Promise<string> {
  const [
    entityDirectoryFingerprint,
    entityEntriesFingerprint,
    aliasFingerprint,
    reconcileFingerprint,
    consumingFingerprint,
  ] = await Promise.all([
    fingerprintPath(entitiesDir),
    fingerprintEntityEntries(entitiesDir),
    fingerprintPath(path.join(baseDir, "config", "aliases.json")),
    fingerprintPath(path.join(baseDir, "state", ENTITY_CANONICAL_ID_RECONCILE_MARKER)),
    fingerprintPath(path.join(baseDir, "state", ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER)),
  ]);
  return [
    entityDirectoryFingerprint,
    entityEntriesFingerprint,
    aliasFingerprint,
    reconcileFingerprint,
    consumingFingerprint,
    getEntityMutationVersion(),
  ].join(":");
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
  for (const mappings of [result.data.mappings, result.data.blocked ?? {}]) {
    for (const [legacyId, canonicalId] of Object.entries(mappings)) {
      assertSafeEntityId(legacyId);
      assertSafeEntityId(canonicalId);
    }
  }
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

/**
 * Every journal publish — additive merges, completion markers, prunes —
 * serializes under the entity MUTATION lock (issue #2213 review): entity
 * writers, post-persist repair settles, and tombstone appends revalidate
 * the journal identity under that lock, so an unlocked publish could land
 * inside their resolve→write window and strand the write on a superseded
 * id space.
 */
async function publishState(
  deps: EntityCanonicalIdMigrationDependencies,
  state: EntityCanonicalIdMigrationState
): Promise<void> {
  await withEntityCanonicalMutationLock(deps.stateDir, async () => {
    await writeState(deps, state);
  });
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
  // Blocks describe THIS scan of the directory, so they are rebuilt per pass.
  // Accumulating them across a run would let a collision another writer has
  // since resolved keep pruning its now-valid mapping: the entity file gets
  // renamed while the pruned mapping skips the reference rewrite, stranding
  // memories on a filename that no longer exists.
  blocked.clear();
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
      continue;
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
      // A raw-byte writer (offline sync, consolidation-undo, governance
      // restore) may have landed memory bytes this process never vetted; the
      // marker requests ONE reference-reconciliation pass (issue #2213). The
      // observed generation is RENAMED aside before the pass so a request made
      // WHILE this run scans creates a fresh marker that survives finish() —
      // and a `.consuming` file left by a crashed run still owes its pass.
      const reconcileMarkerPath = path.join(deps.stateDir, ENTITY_CANONICAL_ID_RECONCILE_MARKER);
      const consumingMarkerPath = path.join(deps.stateDir, ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER);
      let reconcileRequested = await fileExists(consumingMarkerPath);
      if (await fileExists(reconcileMarkerPath)) {
        try {
          await rename(reconcileMarkerPath, consumingMarkerPath);
          reconcileRequested = true;
        } catch (error) {
          if (!isErrnoCode(error, "ENOENT")) throw error;
        }
      }
      let state = await readState(deps);
      if (!state) {
        state = {
          version: ENTITY_CANONICAL_ID_MIGRATION_VERSION,
          complete: false,
          mappings: {},
        };
      }
      const blocked: BlockedEntityPairs = new Map();
      // Parks for pairs whose files are GONE, tracked separately from
      // collision parks: pruneBlocked drops these (the canonical file is gone
      // too), and the rescan's blocked.clear() would otherwise silence them
      // before finish() reports anything.
      const staleParked: BlockedEntityPairs = new Map();
      // ONE aggregated line per run, not one per pair per restart: this used to
      // abort the daemon, so the operator needs the whole list and the remedy.
      const finish = async (): Promise<string | undefined> => {
        if (blocked.size > 0) {
          const pairs = [...blocked].map(([legacyId, canonicalId]) => `${legacyId} -> ${canonicalId}`).join(", ");
          log.warn(
            `entity canonical-id migration skipped ${blocked.size} unresolvable pair(s): ${pairs}. `
            + "Both files were kept and the legacy id still resolves; merge or delete one side to migrate it.",
          );
        }
        if (staleParked.size > 0) {
          const pairs = [...staleParked].map(([legacyId, canonicalId]) => `${legacyId} -> ${canonicalId}`).join(", ");
          log.warn(
            `entity canonical-id migration dropped ${staleParked.size} mapping(s) whose entity files are gone: ${pairs}. `
            + "The stale journal entries were removed; references to those legacy ids do not resolve either way.",
          );
        }
        // Every finish() path either just rewrote references (main/reconcile
        // paths), has none to rewrite (empty mappings), or observed no marker
        // (stable no-op) — so the CONSUMED generation is removed here. A fresh
        // marker written mid-run is untouched, and a crash before this point
        // leaves `.consuming` set for the next run (the rewrite is idempotent).
        if (reconcileRequested) {
          await unlink(consumingMarkerPath).catch((error: unknown) => {
            if (!isErrnoCode(error, "ENOENT")) throw error;
          });
        }
        // A FRESH marker written while this run scanned means bytes landed the
        // pass may not have covered. Withholding the completion fingerprint
        // makes the runner's stability check fail, so it immediately retries —
        // and the retry consumes the fresh generation. ORDER MATTERS: read the
        // fingerprint BEFORE the marker check. A marker landing after the
        // fingerprint read but before the check is caught by the check; one
        // landing after the check is absent from the returned fingerprint, so
        // the live marker mismatches the runner's cached completion and the
        // next ensure() re-invokes. Checking first left a window where the
        // fingerprint could SEAL a marker the check never saw.
        const completionFingerprint = await deps.readMigrationFingerprint?.();
        if (await fileExists(reconcileMarkerPath)) return undefined;
        return completionFingerprint;
      };
      /**
       * Drop blocked pairs from the working set. Discovery only refuses to
       * ADD them; a mapping persisted by an earlier run would otherwise still
       * be applied - migrating one claimant and rewriting every reference onto
       * the canonical file, i.e. picking the winner this fix exists to avoid,
       * off stale state rather than what is on disk.
       */
      /** @returns true when a park was promoted back into the mapping set. */
      const pruneBlocked = async (): Promise<boolean> => {
        const current = state;
        if (!current) return false;
        // THIS scan's verdict wins over the journal: normalization can change
        // between runs, so a stale parked target would otherwise be promoted
        // later and rewrite references onto an id that does not exist.
        let revived = false;
        const parked: Record<string, string> = { ...(current.blocked ?? {}) };
        const active: Record<string, string> = {};
        for (const [legacyId, canonicalId] of Object.entries(current.mappings)) {
          if (!blocked.has(legacyId)) active[legacyId] = canonicalId;
        }
        for (const [legacyId, canonicalId] of blocked) parked[legacyId] = canonicalId;
        // A parked pair whose legacy file is gone was resolved by keeping the
        // canonical side. The rename is moot; the reference rewrite is not, and
        // this record is the only thing that can still perform it.
        // A park survives ONLY while this scan re-establishes the collision.
        // Anything else - the scan found a real migration, or found the source
        // needs none (already canonical under a newer normalization) - makes
        // the record obsolete, and keeping it lets a later deletion promote a
        // target the entity never occupied.
        for (const [legacyId, canonicalId] of Object.entries(parked)) {
          if (blocked.has(legacyId)) continue;
          delete parked[legacyId];
          if (active[legacyId] !== undefined) continue;
          const legacyPath = deps.resolveEntityFilePath(legacyId);
          if (legacyPath !== null && (await fileExists(legacyPath))) continue;
          // Resolve the parked target through ACTIVE moves before deciding
          // its file is gone: a parked A -> B beside an active B -> C must
          // promote to A -> C and rewrite, not drop because B was moved
          // out-of-band. Only a target with no surviving file may drop.
          let target = canonicalId;
          const seenTargets = new Set<string>();
          while (active[target] !== undefined && !seenTargets.has(target)) {
            seenTargets.add(target);
            target = active[target]!;
          }
          const targetPath = deps.resolveEntityFilePath(target);
          if (targetPath === null || !(await fileExists(targetPath))) continue;
          active[legacyId] = target;
          revived = true;
        }
        // Reviving a whole chain at once yields A -> B -> C, and each rewrite
        // surface makes a different number of passes over it - so collapse
        // transitively before anything consumes the set.
        const collapsed = collapseMappings(active);
        // Parked targets follow ACTIVE moves only: hopping over a still-blocked
        // link would jump to an id the migration has not been allowed to reach.
        for (const [legacyId, canonicalId] of Object.entries(parked)) {
          const moved = collapsed[canonicalId];
          if (moved !== undefined && moved !== legacyId) parked[legacyId] = moved;
        }
        const same = (a: Record<string, string>, b: Record<string, string>): boolean =>
          Object.keys(a).length === Object.keys(b).length
          && Object.entries(a).every(([key, value]) => b[key] === value);
        if (same(collapsed, current.mappings) && same(parked, current.blocked ?? {})) return revived;
        // Parking/removing an active mapping mid-entity-write would land an
        // alias/activity/relationship mutation on a now-unrelated canonical
        // claimant — the reconcile pass rewrites references, it cannot move
        // a misplaced mutation. publishState serializes under the lock.
        state = { ...current, mappings: collapsed, blocked: parked };
        await publishState(deps, state);
        return revived;
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
        const revivedBefore = await pruneBlocked();
        const mergedBefore = collapseMappings(mergeDiscoveredMappings(state.mappings, discoveredBefore));
        // Stable completed journal → no-op (issue #2213). Retained mappings are
        // read-compat state whose references were already rewritten (to
        // convergence) before `complete: true` was persisted, so re-running
        // `rewriteKnownReferences` here re-read the ENTIRE hot+cold+archived
        // corpus — twice — and invalidated every memory cache on EVERY
        // `ensureDirectories()`. On a write-active daemon that was a
        // self-sustaining hot loop (multi-GB/s of re-reads, caches never warm,
        // recall degraded to the fallback path). A park revived by THIS run's
        // pruneBlocked still owes its reference rewrite: it falls through to
        // the main flow below, which demotes `complete` BEFORE rewriting — so
        // a crash mid-rewrite resumes, which the old in-place rewrite did not.
        if (
          state.complete
          && Object.keys(discoveredBefore).length === 0
          && !mappingsChanged
          && !revivedBefore
        ) {
          // Stable journal, but a raw-byte writer requested reconciliation:
          // run ONE bounded rewrite pass over the retained mappings, then let
          // finish() consume the marker.
          if (reconcileRequested && Object.keys(state.mappings).length > 0) {
            const rewroteColdMemory = await rewriteKnownReferences(
              deps,
              state.mappings,
              () => lock.refresh(),
            );
            deps.invalidateKnowledgeIndexCache();
            deps.invalidateAllMemoriesCache();
            if (rewroteColdMemory) deps.invalidateColdMemoriesCache();
            deps.bumpMemoryStatusVersion();
          }
          return finish();
        }
        if (
          state.complete
          || Object.keys(discoveredBefore).length > 0
          || Object.keys(mergedBefore).length !== Object.keys(state.mappings).length
        ) {
          state = { ...state, complete: false, mappings: mergedBefore };
          await publishState(deps, state);
        }
        if (Object.keys(state.mappings).length === 0) {
          if (!(await lock.refresh())) throw new Error("Lost entity canonical-id migration lock.");
          const discoveredAfter = rejectMappingCycles(
            state.mappings,
            await discoverMappings(deps, state.mappings, blocked),
          );
          // Reconcile before declaring completion: this rescan can resolve a
          // park (another writer removed the legacy file), and completing
          // without promoting it strands its references behind a fingerprint
          // that already reflects the deletion - so no later run revisits it.
          const revivedInRescan = await pruneBlocked();
          if (Object.keys(discoveredAfter).length === 0 && !revivedInRescan) {
            await publishState(deps, { ...state, complete: true });
            return finish();
          }
          state = {
            ...state,
            complete: false,
            mappings: collapseMappings(mergeDiscoveredMappings(state.mappings, discoveredAfter)),
          };
          await publishState(deps, state);
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
            // Deferred means both files are missing: no later pass can help
            // these pairs, so park them all instead of Fatal-exiting.
            for (const [legacyId, canonicalId] of deferredMappings) {
              blocked.set(legacyId, canonicalId);
              staleParked.set(legacyId, canonicalId);
            }
            break;
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
        // A park resolved after the rewrite pass is promoted here, and a
        // promotion still has to be APPLIED. Completing on `discoveredAfter`
        // alone fingerprints the post-deletion corpus, so the runner never
        // retries and those references stay stranded.
        const revivedAfterRewrite = await pruneBlocked();
        if (Object.keys(discoveredAfter).length === 0 && !revivedAfterRewrite) {
          await publishState(deps, { ...state, complete: true });
          return finish();
        }
        state = {
          ...state,
          complete: false,
          mappings: collapseMappings(mergeDiscoveredMappings(state.mappings, discoveredAfter)),
        };
        await publishState(deps, state);
      }
      throw new Error("Entity canonical-id migration mappings changed while migration was running; retry migration.");
    }
  );
}
