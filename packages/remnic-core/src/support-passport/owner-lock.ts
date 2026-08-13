import { createHash } from "node:crypto";
import path from "node:path";

import type { StorageManager } from "../index.js";
import { type HeldFileLockController, serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import { computeSupportPassportOwnerKey } from "./card-projection.js";
import { SupportPassportError } from "./errors.js";

const CARD_MUTATION_LOCK_STALE_MS = 60_000;
const CARD_MUTATION_LOCK_MAX_WAIT_MS = 30_000;

export type SupportPassportOwnerLockScope =
  | { namespace: string; principal: string; ownerKey?: never }
  | { namespace: string; ownerKey: string; principal?: never };

export function supportPassportOwnerLockPath(
  storage: StorageManager,
  scope: SupportPassportOwnerLockScope
): string {
  const ownerKey = scope.ownerKey ?? computeSupportPassportOwnerKey(scope.principal);
  if (!/^[a-f0-9]{64}$/.test(ownerKey)) {
    throw new SupportPassportError("card_data_invalid", "The support passport owner scope is invalid.", 500);
  }
  const scopeKey = createHash("sha256").update(JSON.stringify([scope.namespace, ownerKey])).digest("hex");
  return path.join(storage.dir, "state", `support-passport-cards-${scopeKey}.lock`);
}

export async function withSupportPassportOwnerLock<T>(
  storage: StorageManager,
  scope: SupportPassportOwnerLockScope,
  task: (lock: HeldFileLockController) => Promise<T>
): Promise<T> {
  const lockPath = supportPassportOwnerLockPath(storage, scope);
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

export async function requireSupportPassportOwnerLock(lock: HeldFileLockController): Promise<void> {
  if (await lock.refresh()) return;
  throw new SupportPassportError("storage_conflict", "The support passport changed during the request.", 409);
}
