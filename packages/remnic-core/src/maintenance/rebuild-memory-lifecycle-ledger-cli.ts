import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { isEncryptedFile, MAGIC_HEADER_SIZE } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import type { StorageManager } from "../index.js";
import {
  rebuildMemoryLifecycleLedger,
  type RebuildMemoryLifecycleLedgerResult,
} from "./rebuild-memory-lifecycle-ledger.js";

export interface RebuildMemoryLifecycleLedgerCliCommandOptions {
  memoryDir: string;
  write?: boolean;
  now?: Date;
  /**
   * Live storage for secure-store deployments (#2033). When the store is
   * encrypted at rest, the rebuild must read encrypted memories and re-encrypt
   * the rewritten ledger through this unlocked StorageManager; a keyless manager
   * would read with no key and rewrite the ledger as plaintext. The command
   * refuses when the on-disk ledger is encrypted and no unlocked key is present.
   */
  storage?: StorageManager;
}

/**
 * True when the lifecycle ledger at `ledgerPath` is encrypted at rest (its first
 * bytes are the secure-store magic header). ENOENT resolves to false — an absent
 * ledger has nothing to recover. Mirrors the auto-compaction probe so the CLI
 * recovery refuses the same encrypted-without-key case (#2033).
 */
async function ledgerEncryptedOnDisk(ledgerPath: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(ledgerPath, "r");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
  try {
    const header = Buffer.alloc(MAGIC_HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return isEncryptedFile(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function runRebuildMemoryLifecycleLedgerCliCommand(
  options: RebuildMemoryLifecycleLedgerCliCommandOptions,
): Promise<RebuildMemoryLifecycleLedgerResult> {
  const storage = options.storage;
  const ledgerPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  // Refuse a keyless plaintext rewrite of an encrypted-at-rest ledger (#2033):
  // without an unlocked secure StorageManager the rebuild would read encrypted
  // memories with no key and rewrite the ledger as plaintext, defeating
  // encryption-at-rest. Fail safely and point the operator at the unlock step.
  if ((await ledgerEncryptedOnDisk(ledgerPath)) && !(storage?.isSecureStoreUnlocked() ?? false)) {
    throw new Error(
      "rebuild-memory-lifecycle-ledger: secure store is locked; refusing to rebuild the "
      + "lifecycle ledger, which would read encrypted memories with no key and rewrite the "
      + "ledger as plaintext. Run `remnic secure-store unlock` first, then re-run with --write.",
    );
  }
  return rebuildMemoryLifecycleLedger({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
    // Carry the live (unlocked) secure StorageManager so encrypted memories
    // decrypt on read and the rewritten ledger stays encrypted at rest; a
    // plaintext store passes a plaintext manager here, which is correct.
    storage,
  });
}
