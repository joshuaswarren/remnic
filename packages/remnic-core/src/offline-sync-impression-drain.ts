import fs from "node:fs";
import path from "node:path";
import {
  drainPendingLifecycleForSyncOrThrow,
  drainPendingLifecycleLedgerForSync,
  type LifecyclePendingIo,
} from "./storage/memory-lifecycle-ledger-access.js";
import { writeFileAtomically } from "./maintenance/atomic-file.js";

type PendingImpressionDrain = () => Promise<{ pendingDeferred: boolean }>;

type PendingLifecycleDrain = {
  drainPendingMemoryLifecycleEventsForSync(): Promise<{ folded: boolean; pendingDeferred: boolean }>;
};

type LifecycleDrainAtPath = (
  ledgerPath: string,
) => Promise<{ folded: boolean; pendingDeferred: boolean }>;

type PendingImpressionHost = {
  drainPendingRecallImpressions(): Promise<{ pendingDeferred: boolean }>;
};
/**
 * Fold pending recall-impression spills before building an offline-sync snapshot.
 * A deferred or failed drain must abort the snapshot rather than silently omit
 * durable rows from the sync payload.
 */
export async function drainPendingImpressionsForOfflineSync(
  host: PendingImpressionDrain,
): Promise<void> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await host();
      if (!result.pendingDeferred) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError
    ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : " (rotation lock held by a peer)";
  throw new Error(
    `offline-sync impression drain could not fold pending recall impressions after ${maxAttempts} attempts${detail}; aborting snapshot so the pending rows are not silently excluded (#2033)`,
  );
}


export async function getOfflineSyncStorage<T extends PendingLifecycleDrain>(
  orchestrator: PendingImpressionHost & {
    getStorage(namespace: string): Promise<T>;
  },
  namespace: string,
): Promise<T> {
  const storage = await orchestrator.getStorage(namespace);
  await drainPendingImpressionsForOfflineSync(() => orchestrator.drainPendingRecallImpressions());
  await drainPendingLifecycleForSyncOrThrow(() => storage.drainPendingMemoryLifecycleEventsForSync());
  return storage;
}

const LIFECYCLE_LEDGER_FILE = "memory-lifecycle-ledger.jsonl";

/**
 * Plaintext filesystem IO for a standalone (CLI) offline-sync lifecycle drain.
 * A standalone offline cache is plaintext - exactly like its LastRecallStore
 * impression drain - so spills read/append as UTF-8. `writeSecure` keeps the
 * atomic temp+rename the pending contract requires (#2033); a pure drain never
 * spills a new event, but the interface demands an atomic writer.
 */
function plaintextLifecyclePendingIo(): LifecyclePendingIo {
  return {
    writeSecure: async (filePath, payload) => {
      await writeFileAtomically(filePath, payload);
    },
    readSecure: (filePath) => fs.promises.readFile(filePath, "utf8"),
  };
}

/**
 * Lifecycle ledger paths under a standalone memory dir: the root `state/` ledger
 * plus every per-namespace `namespaces/<ns>/state/` ledger (#2033). Offline sync
 * pushes the whole memory dir, so every namespace's ledger can carry pending
 * spills that must be folded first.
 */
function offlineSyncLifecycleLedgerPaths(memoryDir: string): string[] {
  const paths = [path.join(memoryDir, "state", LIFECYCLE_LEDGER_FILE)];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(memoryDir, "namespaces"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return paths;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(path.join(memoryDir, "namespaces", entry.name, "state", LIFECYCLE_LEDGER_FILE));
  }
  return paths;
}

/**
 * Fold pending memory-lifecycle spills into each active ledger under `memoryDir`
 * before a standalone (CLI) offline-sync snapshot (#2033). Mirrors the
 * access-service snapshot entrypoints, which drain lifecycle pending first: the
 * default sync exclude globs keep `memory-lifecycle-ledger.jsonl.pending.d` out
 * of the push, so an append-only row (promotion/import/explicit capture) that
 * spilled while the ledger lock was held would be silently dropped if the local
 * node were discarded before maintenance folds it. A deferred drain (lock held
 * by a peer) or a repeatedly failing fold ABORTS via
 * {@link drainPendingLifecycleForSyncOrThrow} rather than building/pushing a
 * snapshot that omits durable rows. Fast no-op per ledger with no pending dir.
 */
export async function drainPendingLifecycleForOfflineSync(
  memoryDir: string,
  drainAtPath: LifecycleDrainAtPath = (ledgerPath) => {
    const io = plaintextLifecyclePendingIo();
    const stateDir = path.dirname(ledgerPath);
    return drainPendingLifecycleLedgerForSync(
      ledgerPath,
      io,
      (payload) => fs.promises.appendFile(ledgerPath, payload),
      async () => {
        await fs.promises.mkdir(stateDir, { recursive: true });
      },
    );
  },
): Promise<void> {
  for (const ledgerPath of offlineSyncLifecycleLedgerPaths(memoryDir)) {
    await drainPendingLifecycleForSyncOrThrow(() => drainAtPath(ledgerPath));
  }
}
