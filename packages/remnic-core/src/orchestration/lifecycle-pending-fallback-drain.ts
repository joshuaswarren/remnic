/**
 * Fallback lifecycle pending-append drain for targets with no secure
 * StorageManager. Moved verbatim out of maintenance.ts (issue #2033) so that
 * file stays under the structural size ceiling; behavior is unchanged.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { log } from "../logger.js";
import {
  drainPendingLifecycleLedgerIfAny,
  pendingLifecycleLedgerDir,
  type LifecyclePendingIo,
} from "../storage/memory-lifecycle-ledger-access.js";
import { probeEncryptedRegularFileHeader } from "../secure-store/secure-fs.js";
import { listContainedSpillFiles } from "../utils/path-containment.js";

/**
 * Drain a filesystem-fallback target's pending lifecycle-append spill when no
 * secure StorageManager is available (catalog-disabled namespace; issue
 * #2033). Uses the safe path-scoped PLAINTEXT context this fallback already
 * operates in: a keyless drain can only fold plaintext spills into a plaintext
 * ledger, so it refuses when the ledger or ANY spill is encrypted at rest,
 * leaving those pending for a keyed (catalog-path) drain — exactly mirroring
 * the fallback compaction's encrypted-ledger deferral. Non-fatal; a fast
 * no-op when nothing is pending. The shared spill lister enforces the symlink/
 * containment guard on every spill file it reads or deletes.
 */
export async function drainPendingLifecycleAppendsForPath(memoryDir: string): Promise<void> {
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const spillDir = pendingLifecycleLedgerDir(ledgerPath);
  // Enumerate spills through the SAME guarded lister the actual drain uses
  // (listContainedSpillFiles): it rejects a symlinked/non-directory spill dir
  // and skips any symlink/FIFO/device/escaping entry, returning only regular
  // files contained in the dir. Never raw-readdir + open() an untrusted name:
  // opening a FIFO would block until a writer appears and a symlink would
  // redirect the probe outside the dir (#2033). Enumerate BOTH live `*.jsonl`
  // spills and crash-orphaned `*.jsonl.claimed` files: a drain that died
  // between claiming a spill (rename to `.claimed`) and committing it leaves
  // the ONLY copy of those rows as a claimed orphan. Gating solely on live
  // spills would early-return here whenever the pending dir holds nothing but
  // orphans, stranding those rows forever; proceeding lets
  // drainPendingLifecycleLedgerIfAny -> recoverOrphanedClaims restore and
  // re-commit them under the ledger lock (#2033).
  let spillFiles: string[];
  let claimedOrphans: string[];
  try {
    spillFiles = await listContainedSpillFiles(spillDir);
    claimedOrphans = await listContainedSpillFiles(spillDir, ".jsonl.claimed");
  } catch (err) {
    log.debug(`fallback lifecycle pending scan failed (non-fatal) for ${memoryDir}: ${err}`);
    return;
  }
  if (spillFiles.length === 0 && claimedOrphans.length === 0) return;
  // The pending encryption state is authoritative only UNDER the ledger lock:
  // drainPendingLifecycleLedgerIfAny waits for the lock and re-enumerates the
  // pending dir, so a secure-store writer that spills an encrypted file — or a
  // keyed compaction that rewrites the ledger encrypted — while this fallback
  // waits would defeat any pre-lock probe (#2033). Probe each file at the
  // moment of use inside the held lock instead: readSecure refuses an
  // encrypted spill (the fold reads each spill lazily and propagates the throw
  // BEFORE claiming that spill, leaving it intact) and the append refuses a
  // ledger that became encrypted (the fold rolls the claims back). Either way
  // the plaintext IO
  // never reads or writes ciphertext; the keyed catalog-path drain handles the
  // deferred rows.
  const io: LifecyclePendingIo = {
    writeSecure: async (filePath, payload) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, payload, "utf-8");
    },
    readSecure: async (filePath) => {
      if (await probeEncryptedRegularFileHeader(filePath)) {
        throw new Error(`fallback lifecycle drain deferred: encrypted spill at ${filePath}`);
      }
      return readFile(filePath, "utf-8");
    },
  };
  try {
    await drainPendingLifecycleLedgerIfAny(
      ledgerPath,
      io,
      async (payload) => {
        if (await probeEncryptedRegularFileHeader(ledgerPath)) {
          throw new Error(`fallback lifecycle drain deferred: ledger became encrypted at ${ledgerPath}`);
        }
        await appendFile(ledgerPath, payload, "utf-8");
      },
      async () => {
        await mkdir(path.dirname(ledgerPath), { recursive: true });
      },
    );
  } catch (err) {
    log.debug(`fallback lifecycle pending drain failed (non-fatal) for ${memoryDir}: ${err}`);
  }
}
