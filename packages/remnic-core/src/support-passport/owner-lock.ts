import path from "node:path";

import type { StorageManager } from "../index.js";
import {
  type HeldFileLockController,
  serializeMutations,
  withHeldFileLock,
} from "../utils/serialize-mutations.js";
import { SupportPassportError } from "./errors.js";

const CARD_MUTATION_LOCK_STALE_MS = 60_000;
const CARD_MUTATION_LOCK_MAX_WAIT_MS = 30_000;

export async function withSupportPassportOwnerLock<T>(
  storage: StorageManager,
  task: (lock: HeldFileLockController) => Promise<T>
): Promise<T> {
  const lockPath = path.join(storage.dir, "state", "support-passport-cards.lock");
  return await serializeMutations(lockPath, () =>
    withHeldFileLock(
      lockPath,
      { staleMs: CARD_MUTATION_LOCK_STALE_MS, maxWaitMs: CARD_MUTATION_LOCK_MAX_WAIT_MS },
      async (acquired, lock) => {
        if (!acquired) {
          throw new SupportPassportError("storage_conflict", "The support passport is busy. Try again.", 409);
        }
        return await task(lock);
      }
    )
  );
}
