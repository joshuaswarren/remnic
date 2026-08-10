import { log } from "../logger.js";

export interface CommittedInvalidationCallbacks {
  memoryId: string;
  recordProof: (() => Promise<void>) | undefined;
  clearProof: (() => Promise<void>) | undefined;
  deleteMemory: () => Promise<boolean>;
  afterDelete: () => Promise<void>;
}

async function clearProofFailOpen(callbacks: CommittedInvalidationCallbacks): Promise<void> {
  await callbacks.clearProof?.().catch((error) => {
    log.warn(`failed to clear invalidation proof for ${callbacks.memoryId}: ${error}`);
  });
}

export async function runCommittedInvalidation(
  callbacks: CommittedInvalidationCallbacks,
): Promise<boolean> {
  let deletionCompleted = false;
  try {
    await callbacks.recordProof?.();
    if (!await callbacks.deleteMemory()) {
      await clearProofFailOpen(callbacks);
      return false;
    }
    deletionCompleted = true;
    await callbacks.afterDelete();
    return true;
  } catch (error) {
    if (!deletionCompleted) await clearProofFailOpen(callbacks);
    throw error;
  }
}
