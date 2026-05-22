import path from "node:path";
import { stat } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import type { MemoryLifecycleEvent } from "../types.js";
import { toBackupStamp } from "./backup-stamp.js";
import { writeFileAtomically } from "./atomic-file.js";
import {
  buildLifecycleEventsForMemory,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";

export interface RebuildMemoryLifecycleLedgerOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
}

export interface RebuildMemoryLifecycleLedgerResult {
  dryRun: boolean;
  scannedMemories: number;
  rebuiltRows: number;
  outputPath: string;
  backupPath?: string;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

export async function backupExistingLedger(
  memoryDir: string,
  outputPath: string,
  now: Date,
): Promise<string | undefined> {
  try {
    await stat(outputPath);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  const backupPath = path.join(
    memoryDir,
    "archive",
    "memory-lifecycle-ledger",
    toBackupStamp(now),
    "state",
    "memory-lifecycle-ledger.jsonl",
  );
  return backupPath;
}

export async function rebuildMemoryLifecycleLedger(
  options: RebuildMemoryLifecycleLedgerOptions,
): Promise<RebuildMemoryLifecycleLedgerResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const outputPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const storage = new StorageManager(options.memoryDir);
  const allMemories = [
    ...await storage.readAllMemories(),
    ...await storage.readAllColdMemories(),
    ...await storage.readArchivedMemories(),
  ]
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

  const events: MemoryLifecycleEvent[] = sortMemoryLifecycleEvents(
    allMemories.flatMap((memory) => buildLifecycleEventsForMemory(memory)),
  );

  let backupPath: string | undefined;
  if (!dryRun) {
    backupPath = await backupExistingLedger(options.memoryDir, outputPath, now);
    const payload = events.map((event) => JSON.stringify(event)).join("\n");
    backupPath = await writeFileAtomically(
      outputPath,
      payload.length > 0 ? `${payload}\n` : "",
      backupPath,
    );
  }

  return {
    dryRun,
    scannedMemories: allMemories.length,
    rebuiltRows: events.length,
    outputPath,
    backupPath,
  };
}
