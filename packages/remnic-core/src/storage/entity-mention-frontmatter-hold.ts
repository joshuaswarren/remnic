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
