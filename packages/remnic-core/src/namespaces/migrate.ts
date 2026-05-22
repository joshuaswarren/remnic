import path from "node:path";
import { access, lstat, mkdir, readdir, realpath, rename, rmdir } from "node:fs/promises";
import type { PluginConfig } from "../types.js";
import { NamespaceStorageRouter } from "./storage.js";
import { namespaceCollectionName } from "./search.js";
import { isSafeRouteNamespace } from "../routing/engine.js";

const LEGACY_NAMESPACE_CHILDREN = [
  "facts",
  "corrections",
  "entities",
  "questions",
  "artifacts",
  "identity",
  "state",
  "config",
  "summaries",
  "procedures",
  // Issue #564 PR 3: reasoning_trace memories live in their own subtree.
  // Must be included here so namespace migration moves existing traces
  // into the target namespace root alongside other memory data.
  "reasoning-traces",
  "profile.md",
] as const;

export interface NamespaceInventoryEntry {
  namespace: string;
  rootDir: string;
  exists: boolean;
  usesLegacyRoot: boolean;
  hasMemoryData: boolean;
  collection: string;
}

export interface NamespaceVerifyReport {
  ok: boolean;
  problems: string[];
  namespaces: NamespaceInventoryEntry[];
}

export interface NamespaceMigrationMove {
  from: string;
  to: string;
}

export interface NamespaceMigrationReport {
  dryRun: boolean;
  fromRoot: string;
  targetRoot: string;
  moved: NamespaceMigrationMove[];
  collection: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasAnyLegacyData(rootDir: string): Promise<boolean> {
  for (const child of LEGACY_NAMESPACE_CHILDREN) {
    if (await exists(path.join(rootDir, child))) return true;
  }
  return false;
}

async function discoverConfiguredNamespaces(
  config: PluginConfig,
): Promise<string[]> {
  const discovered = new Set<string>([
    config.defaultNamespace,
    config.sharedNamespace,
    ...config.namespacePolicies.map((policy) => policy.name),
  ]);

  const namespacesDir = path.join(config.memoryDir, "namespaces");
  try {
    const entries = await readdir(namespacesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && isSafeRouteNamespace(entry.name)) {
        discovered.add(entry.name);
      }
    }
  } catch {
    // No namespace directory yet.
  }

  return [...discovered];
}

export async function listNamespaces(options: {
  config: PluginConfig;
  storageRouter?: NamespaceStorageRouter;
}): Promise<NamespaceInventoryEntry[]> {
  const storageRouter = options.storageRouter ?? new NamespaceStorageRouter(options.config);
  const namespaces = await discoverConfiguredNamespaces(options.config);
  const items = await Promise.all(
    namespaces.map(async (namespace) => {
      const storage = await storageRouter.storageFor(namespace);
      const usesLegacyRoot =
        namespace === options.config.defaultNamespace &&
        storage.dir === options.config.memoryDir;
      return {
        namespace,
        rootDir: storage.dir,
        exists: await exists(storage.dir),
        usesLegacyRoot,
        hasMemoryData: await hasAnyLegacyData(storage.dir),
        collection: namespaceCollectionName(options.config.qmdCollection, namespace, {
          defaultNamespace: options.config.defaultNamespace,
          useLegacyDefaultCollection: usesLegacyRoot,
        }),
      } satisfies NamespaceInventoryEntry;
    }),
  );

  return items.sort((a, b) => a.namespace.localeCompare(b.namespace));
}

export async function verifyNamespaces(options: {
  config: PluginConfig;
  storageRouter?: NamespaceStorageRouter;
}): Promise<NamespaceVerifyReport> {
  const namespaces = await listNamespaces(options);
  const problems: string[] = [];

  for (const entry of namespaces) {
    if (entry.exists && !entry.hasMemoryData) {
      problems.push(`${entry.namespace}: root exists but contains no Engram data`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    namespaces,
  };
}

export async function runNamespaceMigration(options: {
  config: PluginConfig;
  to: string;
  dryRun?: boolean;
  renameFn?: typeof rename;
}): Promise<NamespaceMigrationReport> {
  if (!options.config.namespacesEnabled) {
    throw new Error("Namespaces are disabled.");
  }

  const targetNamespace = options.to.trim();
  if (!isSafeRouteNamespace(targetNamespace)) {
    throw new Error(`Invalid namespace: ${options.to}`);
  }

  const targetRoot = path.join(options.config.memoryDir, "namespaces", targetNamespace);
  const moved: NamespaceMigrationMove[] = [];
  const renamePath = options.renameFn ?? rename;

  for (const child of LEGACY_NAMESPACE_CHILDREN) {
    const from = path.join(options.config.memoryDir, child);
    if (!(await exists(from))) continue;
    const to = path.join(targetRoot, child);
    if (await exists(to)) {
      throw new Error(`Target already contains ${child}: ${to}`);
    }
    const sourceStat = await lstat(from);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing to migrate symlinked legacy path: ${from}`);
    }
    moved.push({ from, to });
  }

  if (!options.dryRun && moved.length > 0) {
    await assertSafeNamespaceTarget(options.config.memoryDir, targetRoot);
    await mkdir(targetRoot, { recursive: true });
    await assertSafeNamespaceTarget(options.config.memoryDir, targetRoot);
    const completed: NamespaceMigrationMove[] = [];
    try {
      for (const move of moved) {
        await renamePath(move.from, move.to);
        completed.push(move);
      }
    } catch (cause) {
      const rollbackErrors: string[] = [];
      for (const move of completed.reverse()) {
        try {
          if (!(await exists(move.from)) && (await exists(move.to))) {
            await rename(move.to, move.from);
          }
        } catch (rollbackCause) {
          rollbackErrors.push(rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause));
        }
      }
      try {
        await rmdir(targetRoot);
      } catch {
        // Target may predate migration or still contain unrelated files.
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Namespace migration failed and was rolled back: ${message}` +
          (rollbackErrors.length > 0 ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""),
        { cause },
      );
    }
  }

  return {
    dryRun: options.dryRun === true,
    fromRoot: options.config.memoryDir,
    targetRoot,
    moved,
    collection: namespaceCollectionName(options.config.qmdCollection, targetNamespace, {
      defaultNamespace: options.config.defaultNamespace,
      useLegacyDefaultCollection: false,
    }),
  };
}

async function assertSafeNamespaceTarget(memoryDir: string, targetRoot: string): Promise<void> {
  const memoryReal = await realpath(memoryDir);
  const namespacesDir = path.join(memoryDir, "namespaces");
  if (await exists(namespacesDir)) {
    const namespacesStat = await lstat(namespacesDir);
    if (namespacesStat.isSymbolicLink()) {
      throw new Error(`Refusing to migrate through symlinked namespaces directory: ${namespacesDir}`);
    }
    const namespacesReal = await realpath(namespacesDir);
    if (!isPathInside(memoryReal, namespacesReal)) {
      throw new Error(`Refusing to migrate through namespaces directory outside memoryDir: ${namespacesDir}`);
    }
  }
  if (await exists(targetRoot)) {
    const targetStat = await lstat(targetRoot);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to migrate into symlinked namespace root: ${targetRoot}`);
    }
    const targetReal = await realpath(targetRoot);
    if (!isPathInside(memoryReal, targetReal)) {
      throw new Error(`Refusing to migrate into namespace root outside memoryDir: ${targetRoot}`);
    }
  }
}

function isPathInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
