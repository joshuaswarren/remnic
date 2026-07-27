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
  getMemoryStatusVersion(): number;
}

export async function runLegacyEntityCanonicalIdMigration(
  host: EntityCanonicalIdMigrationHost,
  parseEntityFile: (content: string) => EntityFile,
  serializeEntityFile: (entity: EntityFile) => string,
  serializeMemoryWithEntityRef: (memory: MemoryFile, entityRef: string) => string,
): Promise<string> {
  const readMigrationFingerprint = () =>
    getFingerprint(host.baseDir, host.entitiesDir, () => String(host.getMemoryStatusVersion()));
  const completionFingerprint = await migrateLegacyEntityCanonicalIds({
    stateDir: host.stateDir,
    entitiesDir: host.entitiesDir,
    normalizeEntityName: host.normalizeEntityName.bind(host),
    resolveEntityFilePath: host.resolveEntityFilePath.bind(host),
    readStorageSecureFile: host.readStorageSecureFile.bind(host),
    writeStorageSecureFile: host.writeStorageSecureFile.bind(host),
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
    rewriteProjectedEntityReferences: (mappings) =>
      rewriteProjectedEntityReferences(host.baseDir, mappings),
    rewriteProjectedMemoryEntityReference: (memoryId, previousEntityRef, nextEntityRef) =>
      rewriteProjectedMemoryEntityReference(host.baseDir, memoryId, previousEntityRef, nextEntityRef),
    invalidateKnowledgeIndexCache: host.invalidateKnowledgeIndexCache.bind(host),
    invalidateAllMemoriesCache: host.invalidateAllMemoriesCache.bind(host),
    invalidateColdMemoriesCache: host.invalidateColdMemoriesCache.bind(host),
    bumpMemoryStatusVersion: host.bumpMemoryStatusVersion.bind(host),
    readMigrationFingerprint,
  } satisfies EntityCanonicalIdMigrationDependencies);
  return completionFingerprint ?? readMigrationFingerprint();
}
