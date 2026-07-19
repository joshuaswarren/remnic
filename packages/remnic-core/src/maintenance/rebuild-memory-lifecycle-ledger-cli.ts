import path from "node:path";

import { probeEncryptedRegularFileHeader } from "../secure-store/secure-fs.js";
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

export async function runRebuildMemoryLifecycleLedgerCliCommand(
  options: RebuildMemoryLifecycleLedgerCliCommandOptions,
): Promise<RebuildMemoryLifecycleLedgerResult> {
  const storage = options.storage;
  const ledgerPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  // Refuse a keyless plaintext rewrite of an encrypted-at-rest ledger (#2033):
  // without an unlocked secure StorageManager the rebuild would read encrypted
  // memories with no key and rewrite the ledger as plaintext, defeating
  // encryption-at-rest. Fail safely and point the operator at the unlock step.
  if ((await probeEncryptedRegularFileHeader(ledgerPath)) && !(storage?.isSecureStoreUnlocked() ?? false)) {
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
