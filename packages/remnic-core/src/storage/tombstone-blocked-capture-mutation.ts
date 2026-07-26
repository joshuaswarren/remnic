import type { MemoryFile, MemoryFrontmatter } from "../types.js";

export type TombstoneBlockedMutationHost = {
  readCurrent: () => Promise<MemoryFile | null>;
  isBlocked: (memory: MemoryFile | null) => boolean;
  isQueuedReview: (memory: MemoryFile | null) => boolean;
  memoryIdentity: (memory: MemoryFile) => string;
  prepareWrite: () => Promise<string>;
  commitWrite: (marker: string) => Promise<void>;
  discardWrite: (marker: string) => Promise<void>;
  markUntrusted: () => void;
  writeStorageSecureFile: (pathname: string, fileContent: string) => Promise<void>;
  withCaptureWriteLock: (task: () => Promise<void>, identity: string | readonly string[]) => Promise<void>;
  logWarning: (message: string) => void;
};

export type TombstoneBlockedMutation = {
  blocked: boolean;
  pathname: string;
  fileContent: string;
  identity: string | readonly string[];
  updateIndex: (rebuildMarker?: string, current?: MemoryFile | null) => Promise<void>;
  beforeIndexUpdate?: () => Promise<void>;
  coordinate?: boolean;
};

export async function runTombstoneBlockedMutation(
  host: TombstoneBlockedMutationHost,
  mutation: TombstoneBlockedMutation,
): Promise<void> {
  let lockIdentity: string | readonly string[] = mutation.identity;
  let mustLock = mutation.blocked || mutation.coordinate === true;
  for (;;) {
    let retryIdentity: string | undefined;
    const mutate = async (): Promise<void> => {
      const current = await host.readCurrent();
      const currentBlocked = host.isBlocked(current);
      const currentQueuedReview = host.isQueuedReview(current);
      if (current !== null && (currentBlocked || currentQueuedReview)) {
        const currentIdentity = host.memoryIdentity(current);
        const heldIdentities = Array.isArray(lockIdentity) ? lockIdentity : [lockIdentity];
        if (!heldIdentities.includes(currentIdentity)) {
          retryIdentity = currentIdentity;
          return;
        }
      }
      const rebuildMarker = mutation.blocked || currentBlocked ? await host.prepareWrite() : undefined;
      try {
        await host.writeStorageSecureFile(mutation.pathname, mutation.fileContent);
      } catch (err) {
        if (rebuildMarker) {
          try {
            await host.discardWrite(rebuildMarker);
          } catch (cleanupError) {
            host.markUntrusted();
            host.logWarning(`storage.tombstoneBlocked failed to clear write marker: ${cleanupError}`);
          }
        }
        throw err;
      }
      if (rebuildMarker) {
        try {
          await host.commitWrite(rebuildMarker);
        } catch (err) {
          host.markUntrusted();
          host.logWarning(`storage.tombstoneBlocked committed write marker failed: ${err}`);
        }
      }
      if (rebuildMarker) await mutation.beforeIndexUpdate?.();
      await mutation.updateIndex(rebuildMarker, currentBlocked && current !== null ? current : undefined);
    };
    if (mustLock) {
      await host.withCaptureWriteLock(mutate, lockIdentity);
    } else {
      await mutate();
    }
    if (retryIdentity === undefined) return;
    const identities = Array.isArray(lockIdentity)
      ? [...lockIdentity, retryIdentity]
      : [lockIdentity, retryIdentity];
    lockIdentity = [...new Set(identities)];
    mustLock = true;
  }
}

export function tombstoneBlocked(frontmatter: MemoryFrontmatter): boolean {
  return frontmatter.status === "pending_review" && Boolean(frontmatter.blockedBy);
}

export function isQueuedReviewFrontmatter(frontmatter: MemoryFrontmatter): boolean {
  return frontmatter.status === "pending_review" && (frontmatter.tags ?? []).includes("queued-review");
}

export function isQueuedReviewMemory(memory: MemoryFile | null): memory is MemoryFile {
  return memory !== null && isQueuedReviewFrontmatter(memory.frontmatter);
}

export type TombstoneBlockedChunkMutation = {
  blocked: boolean;
  id: string;
  identity: string;
  findDuplicate: () => Promise<MemoryFile | null>;
  persistMemory: () => Promise<void>;
  afterWrite: () => Promise<void>;
  withCaptureWriteLock: (task: () => Promise<string>, identity: string) => Promise<string>;
};

export async function runTombstoneBlockedChunkMutation(
  mutation: TombstoneBlockedChunkMutation,
): Promise<string> {
  const persist = async (): Promise<string> => {
    if (mutation.blocked) {
      const duplicate = await mutation.findDuplicate();
      if (duplicate) return duplicate.frontmatter.id;
    }
    await mutation.persistMemory();
    await mutation.afterWrite();
    return mutation.id;
  };
  return mutation.blocked
    ? await mutation.withCaptureWriteLock(persist, mutation.identity)
    : await persist();
}
