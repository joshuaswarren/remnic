/**
 * Amortized entity canonical-id migration completion verdict for entity reads.
 *
 * Key covers every getFingerprint input that is cheap to lstat: entity mutation
 * version, entities/ dir, config/aliases.json, the journal, and reconcile
 * markers. Full fingerprint (including entity entry enumeration) runs only on
 * key miss.
 *
 * ponytail: in-place entity *content* edits still skip revalidation.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import { pathIsInside } from "../utils/path-containment.js";
import { getFingerprint } from "./entity-canonical-id-migration.js";
import {
  ENTITY_CANONICAL_ID_MIGRATION_FILE,
  ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER,
  ENTITY_CANONICAL_ID_RECONCILE_MARKER,
  entityCanonicalIdMigrationCompleted,
  resolveHistoricalEntityCanonicalId,
} from "./entity-canonical-id-references.js";

export type EntityMigrationCompletionCacheDeps = {
  readonly baseDir: string;
  readonly entitiesDir: string;
  getEntityMutationVersion(): number;
};

/**
 * True when `entitiesDir` is a real directory inside `baseDir`.
 * lstat first so a symlinked root is never realpath'd into trust.
 */
export async function isTrustedEntitiesRoot(
  baseDir: string,
  entitiesDir: string,
): Promise<boolean> {
  let rootStat;
  try {
    rootStat = await lstat(entitiesDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
  let memoryRoot: string;
  let entitiesReal: string;
  try {
    memoryRoot = await realpath(baseDir);
    entitiesReal = await realpath(entitiesDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
  return pathIsInside(memoryRoot, entitiesReal);
}

export class EntityMigrationCompletionCache {
  private cache: { version: number; inputSig: string; completed: boolean } | undefined;

  /** lstat identity for one fingerprint input path; nofollow; missing → stable token. */
  private async inputPathSig(filePath: string): Promise<string> {
    try {
      const s = await lstat(filePath);
      return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.isSymbolicLink() ? "L" : s.isDirectory() ? "D" : "F"}`;
    } catch {
      return "missing";
    }
  }

  /**
   * Cheap coherence key. entities/ absence is uncacheable (random suffix) so
   * we never pin a false complete.
   */
  private async inputSig(deps: EntityMigrationCompletionCacheDeps): Promise<string> {
    const stateDir = path.join(deps.baseDir, "state");
    const entitiesSig = await this.inputPathSig(deps.entitiesDir);
    if (entitiesSig === "missing") return `entities-missing:${Math.random()}`;
    const [aliasesSig, journalSig, reconcileSig, consumingSig] = await Promise.all([
      this.inputPathSig(path.join(deps.baseDir, "config", "aliases.json")),
      this.inputPathSig(path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE)),
      this.inputPathSig(path.join(stateDir, ENTITY_CANONICAL_ID_RECONCILE_MARKER)),
      this.inputPathSig(path.join(stateDir, ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER)),
    ]);
    return [entitiesSig, aliasesSig, journalSig, reconcileSig, consumingSig].join("|");
  }

  /**
   * True when journal completion attests to live fingerprint inputs.
   * Untrusted entities roots (symlink / outside base) never reach getFingerprint.
   */
  async isCompleted(deps: EntityMigrationCompletionCacheDeps): Promise<boolean> {
    const version = deps.getEntityMutationVersion();
    const inputSig = await this.inputSig(deps);
    const cached = this.cache;
    if (cached && cached.version === version && cached.inputSig === inputSig) return cached.completed;
    if (!(await isTrustedEntitiesRoot(deps.baseDir, deps.entitiesDir))) {
      this.cache = { version, inputSig, completed: false };
      return false;
    }
    const completed = await entityCanonicalIdMigrationCompleted(path.join(deps.baseDir, "state"), () =>
      getFingerprint(deps.baseDir, deps.entitiesDir, () => String(version)));
    this.cache = { version, inputSig, completed };
    return completed;
  }
}

export type ReadEntityRenameDeps = {
  readonly entitiesDir: string;
  currentHistoricalIds(): Readonly<Record<string, string>>;
  readStorageSecureFile(filePath: string): Promise<string>;
};

/** Resolve a physical entity path through historical id rename candidates. */
export async function readEntityFileResolvingRename(
  deps: ReadEntityRenameDeps,
  firstPath: string,
  entityId: string,
): Promise<{ id: string; content: string } | null> {
  try {
    return { id: entityId, content: await deps.readStorageSecureFile(firstPath) };
  } catch (err) {
    if (err instanceof SecureStoreLockedError) throw err;
    // ENOENT: renamed away (retry below). ELOOP: planted symlink — skip.
    if (isErrnoCode(err, "ELOOP")) return null;
    if (!isErrnoCode(err, "ENOENT")) throw err;
  }
  const historicalIds = deps.currentHistoricalIds();
  const canonical = resolveHistoricalEntityCanonicalId(entityId, historicalIds);
  const candidates = new Set([canonical]);
  for (const legacy of Object.keys(historicalIds)) {
    if (resolveHistoricalEntityCanonicalId(legacy, historicalIds) === canonical) candidates.add(legacy);
  }
  candidates.delete(entityId);
  for (const candidate of candidates) {
    try {
      return {
        id: candidate,
        content: await deps.readStorageSecureFile(
          path.join(deps.entitiesDir, `${candidate}.md`),
        ),
      };
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      // ENOENT/ELOOP: gone or a planted symlink — try the next candidate.
      if (isErrnoCode(err, "ENOENT") || isErrnoCode(err, "ELOOP")) continue;
      throw err;
    }
  }
  return null;
}
