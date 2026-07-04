/**
 * Shared storage-contract test harness (issues #1522 + #1533).
 *
 * Provides the minimal scaffolding to exercise StorageManager write entry
 * points against a real NamespaceCatalog + NamespaceStorageRouter in a temp
 * memoryDir, and assert catalog-touch parity (#1522) or storage contract
 * invariants (#1533).
 *
 * The harness is shared between lane R1 (#1522 catalog-write-chokepoint) and
 * lane T (#1533 storage-contract tests). Extend — don't fork.
 */
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { NamespaceCatalog } from "../../packages/remnic-core/src/namespaces/catalog.js";
import { NamespaceStorageRouter } from "../../packages/remnic-core/src/namespaces/storage.js";
import { StorageManager } from "../../packages/remnic-core/src/storage.js";
import { parseConfig } from "../../packages/remnic-core/src/config.js";
import type { PluginConfig } from "../../packages/remnic-core/src/types.js";

/**
 * Offline-safe config for storage-contract tests: QMD off, embedding fallback
 * off, namespaces ENABLED (the catalog is inert without it), extraction
 * thresholds floored, consolidation far out.
 */
export function makeStorageTestConfig(
  memoryDir: string,
  overrides: Record<string, unknown> = {},
): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    triggerMode: "smart",
    bufferMaxTurns: 10,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    consolidateEveryN: 50,
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

/**
 * A fully-wired storage-contract fixture: temp memoryDir, catalog, router
 * (with catalog attached per #1522), and a pre-resolved StorageManager for
 * the given namespace. Cleaned up via `fixture.cleanup()`.
 */
export interface StorageContractFixture {
  readonly memoryDir: string;
  readonly config: PluginConfig;
  readonly catalog: NamespaceCatalog;
  readonly router: NamespaceStorageRouter;
  /** Get (or create+cache) the StorageManager for a namespace via the router. */
  storageFor(namespace: string): Promise<StorageManager>;
  /** Read the catalog's lastWriteAt for a namespace (undefined if not registered). */
  lastWriteAt(namespace: string): Promise<string | undefined>;
  /** Await all pending fire-and-forget write touches for the router. */
  settleWriteTouches(): Promise<void>;
  /** Remove the temp dir, retrying transient ENOTEMPTY. */
  cleanup(): Promise<void>;
}

export async function createStorageFixture(
  namespace: string = "default",
  overrides: Record<string, unknown> = {},
): Promise<StorageContractFixture> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-storage-contract-"));
  const config = makeStorageTestConfig(memoryDir, overrides);
  const catalog = new NamespaceCatalog(config);
  await catalog.registerConfiguredNamespaces();

  const router = new NamespaceStorageRouter(
    config,
    {
      onResolve: (ns, dir) => catalog.registerResolved(ns, dir),
    },
    catalog,
  );

  const storageCache = new Map<string, StorageManager>();

  const fixture: StorageContractFixture = {
    memoryDir,
    config,
    catalog,
    router,
    async storageFor(ns: string) {
      let sm = storageCache.get(ns);
      if (!sm) {
        sm = await router.storageFor(ns);
        storageCache.set(ns, sm);
      }
      return sm;
    },
    async lastWriteAt(ns: string) {
      const rec = await catalog.getNamespaceRecord(ns);
      return rec?.lastWriteAt;
    },
    settleWriteTouches: () => router.whenWriteTouchesSettled(),
    async cleanup() {
      // Retry transient ENOTEMPTY/EBUSY (background indexers on macOS/Windows).
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(memoryDir, { recursive: true, force: true });
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOTEMPTY" && code !== "EBUSY") throw err;
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 100 * (attempt + 1));
          await promise;
        }
      }
    },
  };

  // Pre-warm the namespace's storage so the catalog registers it.
  await fixture.storageFor(namespace);
  await router.whenResolveHooksSettled();

  return fixture;
}
