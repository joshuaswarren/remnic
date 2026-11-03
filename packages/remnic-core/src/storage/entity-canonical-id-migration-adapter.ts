import { log } from "../logger.js";
import type { EntityFile, MemoryFile } from "../types.js";
import {
  getFingerprint,
  migrateLegacyEntityCanonicalIds,
  validateRoots,
  type EntityCanonicalIdMigrationDependencies,
} from "./entity-canonical-id-migration.js";
import {
  rewriteProjectedEntityReferences,
  rewriteProjectedMemoryEntityReference,
} from "../memory-projection-mutations.js";
import {
  clearMaintenancePending,
  maintenancePendingExists,
  writeMaintenancePending,
} from "./entity-migration-maintenance-pending.js";

export interface EntityCanonicalIdMigrationHost {
  readonly baseDir: string;
  readonly entitiesDir: string;
  readonly stateDir: string;
  readonly archiveDir: string;
  normalizeEntityName(raw: string, type: string): string;
  resolveEntityFilePath(id: string): string | null;
  readStorageSecureFile(filePath: string): Promise<string>;
  writeStorageSecureFile(filePath: string, content: string, forceEncrypt?: boolean): Promise<void>;
  isEncryptedFileHeader(filePath: string): Promise<boolean>;
  snapshotBeforeWrite(filePath: string, trigger: "write"): Promise<void>;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  readAllMemories(): Promise<MemoryFile[]>;
  readAllColdMemories(): Promise<MemoryFile[]>;
  readArchivedMemories(): Promise<MemoryFile[]>;
  invalidateKnowledgeIndexCache(): void;
  invalidateAllMemoriesCache(): void;
  invalidateColdMemoriesCache(): void;
  bumpMemoryStatusVersion(): void;
  getEntityMutationVersion(): number;
  /**
   * Ask search maintenance to re-index. Returns false when the request was NOT
   * accepted (e.g. the host is shutting down): the pending marker then stays so
   * the next start retries. Any other return value counts as accepted.
   */
  onEntityMigrationComplete?: () => boolean | void;
}

export async function runLegacyEntityCanonicalIdMigration(
  host: EntityCanonicalIdMigrationHost,
  parseEntityFile: (content: string) => EntityFile,
  serializeEntityFile: (entity: EntityFile) => string,
  serializeMemoryWithEntityRef: (memory: MemoryFile, entityRef: string) => string,
): Promise<string | undefined> {
  const readMigrationFingerprint = () =>
    getFingerprint(host.baseDir, host.entitiesDir, () => String(host.getEntityMutationVersion()));
  // The migration bumps the status version only after a pass that rewrote
  // references; a no-op replay must not ask search maintenance to run unless a
  // previous run died owing it (issue #3286 pending marker).
  let rewroteReferences = false;
  const owedFromEarlierRun = await maintenancePendingExists(host.stateDir);
  // Arm the marker before this run rewrites anything, so a crash between the
  // rewrite and the hook leaves it behind. Idempotent per run.
  let armed: Promise<void> | undefined;
  const armPending = (): Promise<void> => (armed ??= writeMaintenancePending(host.stateDir));
  const completionFingerprint = await migrateLegacyEntityCanonicalIds({
    stateDir: host.stateDir,
    entitiesDir: host.entitiesDir,
    normalizeEntityName: host.normalizeEntityName.bind(host),
    resolveEntityFilePath: host.resolveEntityFilePath.bind(host),
    readStorageSecureFile: host.readStorageSecureFile.bind(host),
    writeStorageSecureFile: async (filePath, content, forceEncrypt) => {
      await armPending();
      return host.writeStorageSecureFile(filePath, content, forceEncrypt);
    },
    isEncryptedStorageFile: host.isEncryptedFileHeader.bind(host),
    snapshotBeforeWrite: host.snapshotBeforeWrite.bind(host),
    parseEntityFile,
    serializeEntityFile,
    serializeMemoryWithEntityRef,
    readMemoryByPath: host.readMemoryByPath.bind(host),
    readAllMemories: host.readAllMemories.bind(host),
    readAllColdMemories: host.readAllColdMemories.bind(host),
    readArchivedMemories: host.readArchivedMemories.bind(host),
    validateMemoryScanRoots: () =>
      validateRoots(host.baseDir, host.entitiesDir, host.stateDir, host.archiveDir),
    rewriteProjectedEntityReferences: async (mappings) => {
      await armPending();
      return rewriteProjectedEntityReferences(host.baseDir, mappings);
    },
    rewriteProjectedMemoryEntityReference: async (memoryId, previousEntityRef, nextEntityRef) => {
      await armPending();
      return rewriteProjectedMemoryEntityReference(host.baseDir, memoryId, previousEntityRef, nextEntityRef);
    },
    invalidateKnowledgeIndexCache: host.invalidateKnowledgeIndexCache.bind(host),
    invalidateAllMemoriesCache: host.invalidateAllMemoriesCache.bind(host),
    invalidateColdMemoriesCache: host.invalidateColdMemoriesCache.bind(host),
    bumpMemoryStatusVersion: () => {
      rewroteReferences = true;
      host.bumpMemoryStatusVersion();
    },
    readMigrationFingerprint,
  } satisfies EntityCanonicalIdMigrationDependencies);
  if (completionFingerprint !== undefined && (rewroteReferences || owedFromEarlierRun) && host.onEntityMigrationComplete) {
    try {
      // A refused request keeps the marker; the clear happens only on acceptance.
      // No hook wired (e.g. a CLI-only process) skips this block, keeping it too.
      if (host.onEntityMigrationComplete() !== false) await clearMaintenancePending(host.stateDir);
    } catch {
      log.warn("entity migration: search maintenance scheduling failed");
    }
  }
  // An undefined completion fingerprint is a deliberate signal (issue #2213):
  // a reconcile marker landed while the run scanned, and recomputing the
  // fingerprint here would seal that pending request into the runner's
  // completed state. Propagate it so the runner retries instead.
  return completionFingerprint;
}
