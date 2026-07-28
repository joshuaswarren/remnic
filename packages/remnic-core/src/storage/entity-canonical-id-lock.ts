/**
 * Entity canonical-id MUTATION lock (issue #2213).
 *
 * Serializes every writer whose correctness depends on the canonical-id
 * journal not moving mid-write: entity file mutations (entity-store),
 * per-pair file migration and journal pruning (entity-canonical-id-migration),
 * and the final settle attempt of the post-persist repair helpers
 * (entity-canonical-id-references). Lives in its own module so the reference
 * helpers can take the lock without importing the migration module, which
 * itself imports the reference helpers.
 */
import path from "node:path";
import { withHeldFileLock } from "../utils/serialize-mutations.js";

const ENTITY_CANONICAL_ID_MUTATION_LOCK_STALE_MS = 60_000;
const ENTITY_CANONICAL_ID_MUTATION_LOCK_MAX_WAIT_MS = 300_000;

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
