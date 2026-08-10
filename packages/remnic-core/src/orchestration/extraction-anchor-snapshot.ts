import path from "node:path";

import type { StorageManager } from "../index.js";
import type { MemoryCategory, MemoryFile } from "../types.js";
import { resolvePersistedMemoryRelativePath } from "../orchestrator.js";
import { mergeMemorySnapshots } from "./update-localization.js";

type AnchorSnapshotOptions = {
  enabled?: boolean;
  candidateLimit?: number;
};

/** Maintains one hot+cold anchor snapshot per storage during a persistence pass. */
export class ExtractionAnchorSnapshot {
  private readonly snapshots = new WeakMap<StorageManager, Promise<MemoryFile[]>>();

  constructor(private readonly options: AnchorSnapshotOptions = {}) {}

  get(storage: StorageManager, entityRef: unknown): Promise<MemoryFile[] | undefined> {
    const candidateLimit = this.options.candidateLimit ?? 5;
    if (
      this.options.enabled === false ||
      !Number.isInteger(candidateLimit) ||
      candidateLimit <= 0 ||
      typeof entityRef !== "string" ||
      entityRef.trim().length === 0
    ) {
      return Promise.resolve(undefined);
    }
    const cached = this.snapshots.get(storage);
    if (cached) return cached;
    const snapshot = Promise.all([
      storage.readAllMemories(),
      storage.readAllColdMemories(),
    ]).then(([hot, cold]) => mergeMemorySnapshots(hot, cold));
    void snapshot.catch(() => {
      if (this.snapshots.get(storage) === snapshot) {
        this.snapshots.delete(storage);
      }
    });
    this.snapshots.set(storage, snapshot);
    return snapshot;
  }

  async replace(
    storage: StorageManager,
    memoryId: string,
    category: MemoryCategory,
    pathById: Map<string, string>,
  ): Promise<void> {
    const cached = this.snapshots.get(storage);
    if (!cached) return;
    const snapshot = await cached;
    const relativePath = resolvePersistedMemoryRelativePath({ memoryId, pathById, category });
    const memory = await storage.readMemoryByPath(path.join(storage.dir, relativePath));
    if (!memory) return;
    const existingIndex = snapshot.findIndex((entry) => entry.frontmatter.id === memoryId);
    if (existingIndex >= 0) snapshot.splice(existingIndex, 1);
    snapshot.push(memory);
  }

  async remove(storage: StorageManager, memoryId: string): Promise<void> {
    const cached = this.snapshots.get(storage);
    if (!cached) return;
    const snapshot = await cached;
    const index = snapshot.findIndex((entry) => entry.frontmatter.id === memoryId);
    if (index >= 0) snapshot.splice(index, 1);
  }
}
