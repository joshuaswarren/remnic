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
  listMaintenancePending,
  settleMaintenancePending,
  trackMaintenanceSettlement,
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
   * Ask search maintenance to re-index. `false` means the request was refused
   * (e.g. the host is shutting down) and a promise settling to `false` means no
   * pass served it: the pending markers stay so the next start retries. A
   * promise is awaited off the startup path; `true` or nothing clears them.
   */
  onEntityMigrationComplete?: () => boolean | Promise<boolean> | void;
}

export async function runLegacyEntityCanonicalIdMigration(
  host: EntityCanonicalIdMigrationHost,
  parseEntityFile: (content: string) => EntityFile,
  serializeEntityFile: (entity: EntityFile) => string,
  serializeMemoryWithEntityRef: (memory: MemoryFile, entityRef: string) => string,
): Promise<string | undefined> {
  const readMigrationFingerprint = () =>
    getFingerprint(host.baseDir, host.entitiesDir, () => String(host.getEntityMutationVersion()));
  let rewroteReferences = false;
  const owed = await listMaintenancePending(host.stateDir);
  let armed: Promise<string> | undefined;
  const armPending = (): Promise<string> => (armed ??= writeMaintenancePending(host.stateDir));
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
  if (completionFingerprint !== undefined && (rewroteReferences || owed.length > 0) && host.onEntityMigrationComplete) {
    const held = armed ? [...owed, await armed] : owed;
    try {
      const outcome = host.onEntityMigrationComplete();
      const settling = settleMaintenancePending(host.stateDir, held, outcome).catch(() => {
        log.warn("entity migration: search maintenance scheduling failed");
      });
      if (outcome instanceof Promise) trackMaintenanceSettlement(host.stateDir, settling);
      else await settling;
    } catch {
      log.warn("entity migration: search maintenance scheduling failed");
    }
  }
  return completionFingerprint;
}
