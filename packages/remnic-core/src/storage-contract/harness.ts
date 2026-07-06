/**
 * Issue #1533 — Storage contract test harness.
 *
 * Shared fixture helpers for the storage public-surface contract suite AND
 * the #1522 catalog-touch fitness test (both live under `storage-contract/`
 * per the issue's coordination note: "build both on ONE shared harness so the
 * write-entry-point enumeration lives in exactly one place").
 *
 * Every helper creates a fresh temp directory and returns a `cleanup` that
 * tears it down — tests never share state. `StorageManager.clearAllStaticCaches()`
 * is called on setup and teardown so the module-level caches (readAllMemories
 * in-flight, version sentinels, secure-store entity cache) do not leak between
 * tests.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../storage.js";
import {
  NamespaceStorageRouter,
} from "../namespaces/storage.js";
import type { PluginConfig } from "../types.js";

/** Clear every module-level cache so tests start from a known-empty state. */
export function resetStaticCaches(): void {
  StorageManager.clearAllStaticCaches();
}

/**
 * Create a StorageManager backed by a fresh temp directory.
 *
 * Returns the manager, the on-disk base directory, and a `cleanup` that removes
 * the directory and clears static caches. Callers MUST call `cleanup` in a
 * `try/finally` (or via `node:test`'s `t.after`).
 */
export async function makeStorage(
  prefix = "remnic-storage-contract-",
): Promise<{
  storage: StorageManager;
  baseDir: string;
  cleanup: () => Promise<void>;
}> {
  resetStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const storage = new StorageManager(baseDir);
  await storage.ensureDirectories();
  storage.invalidateAllMemoriesCacheForDir();
  return {
    storage,
    baseDir,
    cleanup: async () => {
      resetStaticCaches();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Build a minimal valid memory markdown body for raw seeding (bypasses
 * writeMemory so the test controls exact on-disk bytes).
 */
export function rawMemoryMarkdown(
  id: string,
  category: string,
  content: string,
  extra: Record<string, string> = {},
): string {
  const now = new Date().toISOString();
  const lines = [
    "---",
    `id: ${id}`,
    `category: ${category}`,
    `created: ${now}`,
    `updated: ${now}`,
    "source: test",
    "confidence: 0.9",
    'tags: ["contract"]',
  ];
  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", content, "");
  return lines.join("\n");
}

/**
 * Seed a raw markdown file at a path relative to `baseDir`. Used when a test
 * needs to control exact placement (e.g. a specific category dir + date nest)
 * without going through `writeMemory`.
 */
export async function seedRawFile(
  baseDir: string,
  relPath: string,
  content: string,
): Promise<string> {
  const fullPath = path.join(baseDir, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  return fullPath;
}

/**
 * Minimal PluginConfig for NamespaceStorageRouter tests. Only the fields the
 * router reads are populated; the rest default to values that keep the router
 * in the namespaces-enabled mode the tests exercise.
 */
export function makeNamespaceConfig(
  memoryDir: string,
  overrides: Record<string, unknown> = {},
): PluginConfig {
  return {
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    entitySchemas: {},
    inlineSourceAttributionFormat: undefined,
    ...overrides,
  } as unknown as PluginConfig;
}

/**
 * Create a NamespaceStorageRouter over a fresh temp dir with namespaces
 * enabled. Returns the router, the memory dir, and a cleanup.
 */
export async function makeNamespaceRouter(
  overrides: Partial<PluginConfig> = {},
): Promise<{
  router: NamespaceStorageRouter;
  memoryDir: string;
  config: PluginConfig;
  cleanup: () => Promise<void>;
}> {
  resetStaticCaches();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-contract-"));
  const config = makeNamespaceConfig(memoryDir, overrides);
  const router = new NamespaceStorageRouter(config);
  return {
    router,
    memoryDir,
    config,
    cleanup: async () => {
      resetStaticCaches();
      await rm(memoryDir, { recursive: true, force: true });
    },
  };
}
