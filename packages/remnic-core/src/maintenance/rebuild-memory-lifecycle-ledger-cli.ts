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
  // Refuse a keyless plaintext rewrite of an encrypted-at-rest ledger (#2033):
  // without an unlocked secure StorageManager the rebuild would read encrypted
  // memories with no key and rewrite the ledger as plaintext, defeating
  // encryption-at-rest. Fail safely and point the operator at the unlock step.
  if (encrypted && !(storage?.isSecureStoreUnlocked() ?? false)) {
    throw new Error(
      "rebuild-memory-lifecycle-ledger: secure store is locked; refusing to rebuild the "
      + "lifecycle ledger, which would read encrypted memories with no key and rewrite the "
      + "ledger as plaintext. Run `remnic secure-store unlock` first, then re-run with --write.",
    );
  }
  // This command is the advertised recovery for an over-cap ledger, so it must
  // give the SAME guarantees as background compaction (#2033): (1) preserve
  // append-only history frontmatter cannot reconstruct (explicit_capture_accepted,
  // imported, promoted) instead of silently dropping it, and (2) bound the
  // rewritten ledger under the read/decrypt cap so the repaired ledger is
  // readable. Bound the PLAINTEXT payload, reserving the secure-store envelope
  // (+1 byte) whenever the REPLACEMENT will be encrypted — NOT only when the
  // current header is encrypted. A plaintext ledger rewritten through an unlocked
  // encrypt-on-write store becomes encrypted, so it needs the reserve even though
  // its current header is plaintext; base the decision on
  // `willEncryptStateWrites()` exactly as auto-compaction does (#2033 write-mode
  // finding), so the on-disk file lands STRICTLY under the cap.
  const cap = options.maxLedgerBytesCap ?? STATE_FILE_MAX_DECRYPT_BYTES;
  const replacementEncrypted = encrypted || (storage?.willEncryptStateWrites() ?? false);
  const maxLedgerBytes = replacementEncrypted
    ? cap - SECURE_STORE_ENVELOPE_OVERHEAD_BYTES - 1
    : cap - 1;
  return rebuildMemoryLifecycleLedger({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
    // Carry the live (unlocked) secure StorageManager so encrypted memories
    // decrypt on read and the rewritten ledger stays encrypted at rest; a
    // plaintext store passes a plaintext manager here, which is correct.
    storage,
    preserveExistingEvents: true,
    maxLedgerBytes,
  });
}
