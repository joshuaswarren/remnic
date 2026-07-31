import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { invalidateForScope } from "../memory-cache.js";
import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";

const ENTITY_CANONICAL_ID_MUTATION_LOCK_STALE_MS = 60_000;
const ENTITY_CANONICAL_ID_MUTATION_LOCK_MAX_WAIT_MS = 300_000;

export function isEntityPagePath(baseDir: string, filePath: string): boolean {
  if (path.extname(filePath) !== ".md") return false;
  const parentDir = path.dirname(path.resolve(filePath));
  const entitiesDir = path.resolve(baseDir, "entities");
  if (parentDir === entitiesDir) return true;
  try {
    return realpathSync(parentDir) === path.join(realpathSync(baseDir), "entities");
  } catch {
    return false;
  }
}

function recordRawEntityMutation(baseDir: string, stateDir: string): void {
  invalidateForScope(baseDir, "entity-write");
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(path.join(stateDir, ".entity-mutation-version.log"), "x");
}

export function withEntityCanonicalMutationLock<T>(
  stateDir: string,
  task: (refreshLock: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const lockPath = path.join(stateDir, "entity-canonical-id-mutation.lock");
  return serializeMutations(lockPath, () =>
    withHeldFileLock(
      lockPath,
      {
        staleMs: ENTITY_CANONICAL_ID_MUTATION_LOCK_STALE_MS,
        maxWaitMs: ENTITY_CANONICAL_ID_MUTATION_LOCK_MAX_WAIT_MS,
      },
      async (acquired, lock) => {
        if (!acquired) throw new Error("Timed out waiting for entity mutation lock.");
        return task(() => lock.refresh());
      },
    ),
  );
}

export async function withRawEntityPageMutation<T>(
  baseDir: string,
  filePath: string,
  task: (refreshLock: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  if (!isEntityPagePath(baseDir, filePath)) {
    return task(async () => true);
  }
  const stateDir = path.join(baseDir, "state");
  return withEntityCanonicalMutationLock(stateDir, async (refreshLock) => {
    try {
      return await task(refreshLock);
    } finally {
      recordRawEntityMutation(baseDir, stateDir);
    }
  });
}
