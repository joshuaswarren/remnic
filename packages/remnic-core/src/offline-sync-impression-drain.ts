import fs from "node:fs";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import {
  drainPendingLifecycleForSyncOrThrow,
  drainPendingLifecycleLedgerForSync,
  type LifecyclePendingIo,
} from "./storage/memory-lifecycle-ledger-access.js";
import { writeFileAtomically } from "./maintenance/atomic-file.js";
import { log } from "./logger.js";
import { isErrnoCode } from "./utils/errno.js";
import { assertPathInsideRoot, pathIsInside } from "./utils/path-containment.js";
import { displayErrorDetail } from "./runtime/better-sqlite.js";
import { getConfiguredNamespaces } from "./scopes/scope-plan.js";
import { isSafeRouteNamespace } from "./routing/engine.js";
import { namespaceIdentityFromToken } from "./namespaces/identity.js";
import type { PluginConfig } from "./types.js";

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
    ? `: ${displayErrorDetail(lastError) || "unknown error"}`
    : " (rotation lock held by a peer)";
  throw new Error(
    `offline-sync impression drain could not fold pending recall impressions after ${maxAttempts} attempts${detail}; aborting snapshot so the pending rows are not silently excluded (#2033)`,
  );
}


export async function getOfflineSyncStorage<T extends PendingLifecycleDrain & { dir: string }>(
  orchestrator: PendingImpressionHost & {
    config: { memoryDir: string };
    getStorage(namespace: string): Promise<T>;
    listOfflineSyncNamespaces?(): Promise<string[]>;
  },
  namespace: string,
): Promise<T> {
  const storage = await orchestrator.getStorage(namespace);
  const memoryRoot = path.resolve(orchestrator.config.memoryDir);
  // Recall impressions are global: the orchestrator's single LastRecallStore
  // roots at config.memoryDir, so the active recall_impressions.jsonl lives at
  // <memoryDir>/state/. Fold the global pending queue ONLY when THIS snapshot's
  // root actually contains that active file - a root snapshot. A namespace
  // snapshot (storage.dir under namespaces/<token>/) cannot carry it, so
  // draining there would empty the durable pending queue into a file this
  // snapshot omits and strand the row until a root sync; leave it pending for
  // the root sync instead (#2033).
  const impressionsFile = path.join(memoryRoot, "state", "recall_impressions.jsonl");
  if (pathIsInside(path.resolve(storage.dir), impressionsFile)) {
    await drainPendingImpressionsForOfflineSync(() => orchestrator.drainPendingRecallImpressions());
  }
  await drainPendingLifecycleForSyncOrThrow(() => storage.drainPendingMemoryLifecycleEventsForSync());
  // Root snapshot: buildOfflineSyncSnapshot walks `namespaces/<ns>/state/` for
  // every namespace under the memory root and INCLUDES each namespace's active
  // lifecycle ledger, but the per-namespace pending spill dirs are offline-sync
  // EXCLUDED. Draining only the root ledger above would let a root snapshot omit
  // append-only rows still sitting in a namespace's spill queue, so fold every
  // namespace ledger too - each through its OWN namespace storage so secure-store
  // AAD stays namespace-scoped (#2033, matching the CLI all-ledger drain). A
  // namespace snapshot folds only its own ledger, already done above.
  if (path.resolve(storage.dir) === memoryRoot && orchestrator.listOfflineSyncNamespaces) {
    const drained = new Set<string>([memoryRoot]);
    for (const ns of await orchestrator.listOfflineSyncNamespaces()) {
      // A single unresolvable namespace (e.g. a legacy canonical token dir whose
      // name exceeds the route-namespace length cap) must not abort the whole root
      // snapshot — degrade to draining the rest. listOfflineSyncNamespaces already
      // normalizes token dirs, so this is defense-in-depth.
      let nsStorage: T;
      try {
        nsStorage = await orchestrator.getStorage(ns);
      } catch (err) {
        log.debug(`offline-sync root drain: skipping namespace ${ns} (non-fatal): ${err}`);
        continue;
      }
      const nsDir = path.resolve(nsStorage.dir);
      if (drained.has(nsDir)) continue;
      drained.add(nsDir);
      await drainPendingLifecycleForSyncOrThrow(() => nsStorage.drainPendingMemoryLifecycleEventsForSync());
    }
  }
  return storage;
}

type OfflineSyncNamespaceHost = {
  config: PluginConfig;
  namespaceCatalog: { listNamespaces(): Promise<Array<{ namespace: string }>> };
};

/**
 * Every namespace whose lifecycle ledger a ROOT offline snapshot enumerates.
 * Configured namespaces plus catalog-discovered ones; the catalog is queried
 * best-effort so a catalog read failure still drains the configured set (#2033).
 */
export async function listOfflineSyncNamespaces(host: OfflineSyncNamespaceHost): Promise<string[]> {
  const names = new Set<string>(getConfiguredNamespaces(host.config));
  try {
    for (const ledgerPath of await offlineSyncLifecycleLedgerPaths(host.config.memoryDir)) {
      const namespaceDir = path.dirname(path.dirname(ledgerPath));
      if (path.basename(path.dirname(namespaceDir)) !== "namespaces") continue;
      // A namespace is stored under its canonical token dir `ns-<hex>`. Decode the
      // token back to the namespace NAME so the drain fanout resolves the SAME
      // storage the token dir belongs to (the catalog rebuild scanner decodes the
      // same way, catalog.ts finishRebuild). A raw dir already named as a plain
      // namespace is used verbatim. Skip any name the router would reject — e.g. a
      // canonical token dir whose decoded-or-raw name exceeds isSafeRouteNamespace's
      // 64-char cap — because getStorage() would throw `unsafe namespace` and 500
      // the whole root snapshot-stream (the offline-sync regression this fixes).
      const dirName = path.basename(namespaceDir);
      const name = namespaceIdentityFromToken(dirName) ?? dirName;
      if (isSafeRouteNamespace(name)) {
        names.add(name);
      }
    }
  } catch {
    // best-effort: a filesystem scan failure must not block configured/catalog namespaces
  }
  try {
    for (const record of await host.namespaceCatalog.listNamespaces()) {
      names.add(record.namespace);
    }
  } catch {
    // best-effort: fall back to the configured and filesystem namespace sets
  }
  return [...names];
}

/**
 * Resolve the offline-sync storage for a snapshot, folding pending spills first.
 * For a root snapshot this also folds every namespace lifecycle ledger the
 * snapshot will enumerate, so append-only rows in a namespace spill queue are
 * never omitted (#2033).
 */
export function offlineSyncStorageForSnapshot<T extends PendingLifecycleDrain & { dir: string }>(
  host: PendingImpressionHost &
    OfflineSyncNamespaceHost & {
      getStorage(namespace: string): Promise<T>;
    },
  namespace: string,
): Promise<T> {
  return getOfflineSyncStorage(
    {
      config: { memoryDir: host.config.memoryDir },
      drainPendingRecallImpressions: () => host.drainPendingRecallImpressions(),
      getStorage: (ns: string) => host.getStorage(ns),
      listOfflineSyncNamespaces: () => listOfflineSyncNamespaces(host),
    },
    namespace,
  );
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
async function offlineSyncLifecycleLedgerPaths(memoryDir: string): Promise<string[]> {
  const paths = [path.join(memoryDir, "state", LIFECYCLE_LEDGER_FILE)];
  const namespacesBase = path.join(memoryDir, "namespaces");
  // Symlink/traversal containment (#2033): a symlinked <memoryDir>/namespaces
  // (or a symlinked child) must not redirect the pre-sync drain - and the
  // ledger appends/mkdirs it drives - outside memoryDir. Resolve the memory
  // root and the scan base through realpath, reject a symlinked/escaping/
  // non-directory base, and skip any symlinked/escaping child, mirroring the
  // lifecycle-compaction scanner (orchestration/maintenance.ts) and the
  // memory-store walkers (utils/path-containment). A rejected base is
  // non-fatal: drain the root ledger only, never through the poisoned link.
  let memoryDirReal: string;
  try {
    memoryDirReal = await realpath(memoryDir);
    const baseStat = await lstat(namespacesBase);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
      throw new Error("namespaces base is a symlink or not a directory");
    }
    assertPathInsideRoot(memoryDirReal, await realpath(namespacesBase), namespacesBase);
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) {
      log.debug(`offline-sync lifecycle drain: namespaces base rejected (non-fatal): ${err}`);
    }
    return paths;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(namespacesBase, { withFileTypes: true });
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) {
      log.debug(`offline-sync lifecycle drain: namespaces dir scan failed (non-fatal): ${err}`);
    }
    return paths;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const childPath = path.join(namespacesBase, entry.name);
    try {
      assertPathInsideRoot(memoryDirReal, await realpath(childPath), childPath);
    } catch (err) {
      log.debug(`offline-sync lifecycle drain: skipping out-of-root namespace dir ${childPath}: ${err}`);
      continue;
    }
    paths.push(path.join(childPath, "state", LIFECYCLE_LEDGER_FILE));
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
  for (const ledgerPath of await offlineSyncLifecycleLedgerPaths(memoryDir)) {
    await drainPendingLifecycleForSyncOrThrow(() => drainAtPath(ledgerPath));
  }
}
