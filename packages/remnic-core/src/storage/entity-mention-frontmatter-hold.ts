import { entityMentionEpoch } from "../entity-mention-epoch.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import {
  buildCapturePathLockIdentity,
  buildExplicitCaptureDedupKey,
} from "./tombstone-blocked-capture-mutation.js";

type MentionHoldStorage = {
  withTombstoneBlockedCaptureWriteLock<T>(
    task: () => Promise<T>,
    identity?: readonly string[],
  ): Promise<T>;
  readMemoryByPath(pathname: string): Promise<MemoryFile | null>;
};

/**
 * Metadata frontmatter writes may suppress the mention epoch only when the
 * file still has the same body, entityRef, and origin while the path lock is
 * held. The write runs in that same lock so a concurrent body or entityRef
 * change cannot be overwritten under suppression.
 */
export async function holdMentionNeutralFrontmatter<T>(
  storage: MentionHoldStorage,
  memory: MemoryFile,
  updated: MemoryFrontmatter,
  write: () => Promise<T>,
): Promise<T | undefined> {
  const identities = [
    buildCapturePathLockIdentity(memory.path),
    buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector),
    buildExplicitCaptureDedupKey(memory.content, updated.category, updated.sourceConnector),
  ];
  return storage.withTombstoneBlockedCaptureWriteLock(async () => {
    const persisted = await storage.readMemoryByPath(memory.path);
    if (
      !persisted ||
      persisted.content !== memory.content ||
      !entityMentionEpoch.neutral(persisted.frontmatter, updated)
    ) {
      return undefined;
    }
    return write();
  }, identities);
}
