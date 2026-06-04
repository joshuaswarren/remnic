import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MemoryFile } from "./types.js";
import { StorageManager } from "./storage.js";
import type { MemoryTier } from "./tier-routing.js";
import type { SearchBackend } from "./search/port.js";

export type { MemoryTier } from "./tier-routing.js";

export interface TierMigrationRequest {
  memory: MemoryFile;
  fromTier: MemoryTier;
  toTier: MemoryTier;
  reason: string;
}

export interface TierMigrationResult {
  memoryId: string;
  fromTier: MemoryTier;
  toTier: MemoryTier;
  changed: boolean;
  reason: string;
  targetPath: string;
}

export interface TierMigrationExecutorOptions {
  storage: StorageManager;
  qmd: SearchBackend;
  hotCollection: string;
  coldCollection: string;
  autoEmbed?: boolean;
  journalPath?: string;
}

type TierMigrationJournalEntry = {
  ts: string;
  memoryId: string;
  fromTier: MemoryTier;
  toTier: MemoryTier;
  changed: boolean;
  reason: string;
  targetPath: string;
};

export class TierMigrationExecutor {
  private readonly storage: StorageManager;
  private readonly qmd: SearchBackend;
  private readonly hotCollection: string;
  private readonly coldCollection: string;
  private readonly autoEmbed: boolean;
  private readonly journalPath: string;

  constructor(options: TierMigrationExecutorOptions) {
    this.storage = options.storage;
    this.qmd = options.qmd;
    this.hotCollection = options.hotCollection;
    this.coldCollection = options.coldCollection;
    this.autoEmbed = options.autoEmbed === true;
    this.journalPath = options.journalPath ?? path.join(this.storage.dir, "state", "tier-migration-journal.jsonl");
  }

  async migrateMemory(request: TierMigrationRequest): Promise<TierMigrationResult> {
    const { memory, fromTier, toTier, reason } = request;
    const targetPath = this.storage.buildTierMemoryPath(memory, toTier);

    if (fromTier === toTier) {
      const noChange: TierMigrationResult = {
        memoryId: memory.frontmatter.id,
        fromTier,
        toTier,
        changed: false,
        reason,
        targetPath,
      };
      await this.appendJournal(noChange);
      return noChange;
    }

    const moved = await this.storage.migrateMemoryToTier(memory, toTier);
    const result: TierMigrationResult = {
      memoryId: memory.frontmatter.id,
      fromTier,
      toTier,
      changed: moved.changed,
      reason,
      targetPath: moved.targetPath,
    };

    await this.appendJournal(result);

    if (result.changed) {
      const destinationCollection = this.collectionForTier(toTier);
      const sourceCollection = this.collectionForTier(fromTier);
      await this.updateCollectionFromTierRoot(destinationCollection, toTier);
      if (sourceCollection !== destinationCollection && this.qmd.updatesAllCollections?.() !== true) {
        await this.updateCollectionFromTierRoot(sourceCollection, fromTier);
      }
      if (this.autoEmbed) {
        await this.qmd.embedCollection(destinationCollection);
        if (sourceCollection !== destinationCollection) {
          await this.qmd.embedCollection(sourceCollection);
        }
      }
    }

    return result;
  }

  private collectionForTier(tier: MemoryTier): string {
    return tier === "cold" ? this.coldCollection : this.hotCollection;
  }

  private async updateCollectionFromTierRoot(collection: string, tier: MemoryTier): Promise<void> {
    const memoryDir = tier === "cold" ? path.join(this.storage.dir, "cold") : this.storage.dir;
    if (this.qmd.updatesAllCollections?.() !== true && this.qmd.updateCollectionFromDir) {
      await this.qmd.updateCollectionFromDir(collection, memoryDir);
      return;
    }
    await this.qmd.updateCollection(collection);
  }

  private async appendJournal(result: TierMigrationResult): Promise<void> {
    const entry: TierMigrationJournalEntry = {
      ts: new Date().toISOString(),
      memoryId: result.memoryId,
      fromTier: result.fromTier,
      toTier: result.toTier,
      changed: result.changed,
      reason: result.reason,
      targetPath: result.targetPath,
    };
    await mkdir(path.dirname(this.journalPath), { recursive: true });
    await appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
