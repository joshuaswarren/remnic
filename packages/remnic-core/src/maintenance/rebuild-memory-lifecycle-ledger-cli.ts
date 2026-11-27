import path from "node:path";

import { probeEncryptedRegularFileHeader, SECURE_STORE_ENVELOPE_OVERHEAD_BYTES } from "../secure-store/secure-fs.js";
import { STATE_FILE_MAX_DECRYPT_BYTES } from "../storage/secure-line-reader.js";
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
  /**
   * Read/decrypt cap the rewritten ledger must land strictly below. Defaults to
   * {@link STATE_FILE_MAX_DECRYPT_BYTES} (the reader's whole-file refusal cap).
   * Exposed as an override so recovery tooling and tests can bound the rewrite
   * deterministically, mirroring the scheduler's `lifecycleLedgerMaxBytes` seam.
   */
  maxLedgerBytesCap?: number;
}

export async function runRebuildMemoryLifecycleLedgerCliCommand(
  options: RebuildMemoryLifecycleLedgerCliCommandOptions,
): Promise<RebuildMemoryLifecycleLedgerResult> {
  const storage = options.storage;
  const ledgerPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const encrypted = await probeEncryptedRegularFileHeader(ledgerPath);
  if (encrypted && !(storage?.isSecureStoreUnlocked() ?? false)) {
    throw new Error(
      "rebuild-memory-lifecycle-ledger: secure store is locked; refusing to rebuild the "
      + "lifecycle ledger, which would read encrypted memories with no key and rewrite the "
      + "ledger as plaintext. Run `remnic secure-store unlock` first, then re-run with --write.",
    );
  }
  const cap = options.maxLedgerBytesCap ?? STATE_FILE_MAX_DECRYPT_BYTES;
  const replacementEncrypted = encrypted || (storage?.willEncryptStateWrites() ?? false);
  const maxLedgerBytes = replacementEncrypted
    ? cap - SECURE_STORE_ENVELOPE_OVERHEAD_BYTES - 1
    : cap - 1;
  return rebuildMemoryLifecycleLedger({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
    storage,
    preserveExistingEvents: true,
    maxLedgerBytes,
  });
}
