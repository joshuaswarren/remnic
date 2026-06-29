import path from "node:path";
import { access, lstat, readdir } from "node:fs/promises";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasStoredEntries(p: string): Promise<boolean> {
  try {
    const entry = await lstat(p);
    if (entry.isSymbolicLink()) return true;
    if (!entry.isDirectory()) return true;
    const children = await readdir(p, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(p, child.name);
      if (child.isSymbolicLink() || child.isFile()) return true;
      if (child.isDirectory() && (await hasStoredEntries(childPath))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Build a per-namespace directory under `<memoryDir>/namespaces` and assert the
// resolved path stays inside that base. Namespace identifiers can originate from
// operator config (config.defaultNamespace) and request-derived routing, so this
// containment check prevents directory traversal (CodeQL js/path-injection).
// For safe segments this returns exactly `path.join(base, segment)`, so there is
// no behavioral change for valid namespaces.
function resolveNamespaceDir(memoryDir: string, segment: string): string {
  // Mirror isSafeRouteNamespace's separator/parent-ref rejection (without its
  // 64-char cap, so identity tokens still pass). Rejecting separators and ".."
  // up front keeps the value a single contained child of <memoryDir>/namespaces.
  if (
    segment.length === 0 ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("..") ||
    path.isAbsolute(segment)
  ) {
    throw new Error(`unsafe namespace path segment: ${segment}`);
  }
  return path.join(memoryDir, "namespaces", segment);
}

const LEGACY_NAMESPACE_CONTENT_CHILDREN = [
  ...ALL_CATEGORY_DIRS,
  "entities",
  "artifacts",
  "identity",
  "config",
  "summaries",
  "profile.md",
] as const;

const LEGACY_NAMESPACE_RUNTIME_CHILDREN = ["state"] as const;

async function hasAnyLegacyData(
  rootDir: string,
  options: { includeRuntimeState?: boolean } = {},
): Promise<boolean> {
  const children = options.includeRuntimeState === true
    ? [...LEGACY_NAMESPACE_CONTENT_CHILDREN, ...LEGACY_NAMESPACE_RUNTIME_CHILDREN]
    : LEGACY_NAMESPACE_CONTENT_CHILDREN;
  for (const child of children) {
    if (await hasStoredEntries(path.join(rootDir, child))) return true;
  }
  return false;
}

async function hasAnyNamespaceStorageMarker(
  rootDir: string,
  options: { includeRuntimeState?: boolean } = {},
): Promise<boolean> {
  const children = options.includeRuntimeState === true
    ? [...LEGACY_NAMESPACE_CONTENT_CHILDREN, ...LEGACY_NAMESPACE_RUNTIME_CHILDREN]
    : LEGACY_NAMESPACE_CONTENT_CHILDREN;
  for (const child of children) {
    if (await exists(path.join(rootDir, child))) return true;
  }
  return false;
}

/**
 * Storage routing for namespaces.
 *
 * Compatibility note:
 * - When namespaces are enabled, existing raw namespace roots are preserved.
 *   New namespace roots use tokenized names under `memoryDir/namespaces/<token>`.
 * - The default namespace continues to use the legacy `memoryDir` root unless the caller
 *   has created `memoryDir/namespaces/<defaultNamespace>` (in which case we use that).
 *
 * This avoids surprising "lost memories" when an install flips namespaces on without
 * migrating existing data.
 */
/**
 * Optional hooks for the storage router. `onResolve` fires (fire-and-forget)
 * whenever a namespace's storage is resolved/created, so a downstream consumer
 * (e.g. the namespace catalog, issue #1499) can register the namespace. The
 * hook MUST NOT throw into the router; the router invokes it defensively and a
 * hook failure never affects storage resolution.
 */
export interface NamespaceStorageRouterHooks {
  onResolve?: (namespace: string, storageDir: string) => void;
}

/**
 * Resolve the runtime storage root for the configured DEFAULT namespace.
 *
 * Shared between the live router (`NamespaceStorageRouter.defaultNamespaceRoot`)
 * and the rebuildable catalog (`NamespaceCatalog.rebuildFromDisk`) so the two
 * can never diverge (CLAUDE.md rule #22/#42 — read & write paths resolve through
 * the same logic). The contract is: while legacy memory data still lives
 * directly under `memoryDir`, the default root stays `memoryDir`; only once the
 * legacy root is empty and a `namespaces/<default|token>` dir holds data does
 * the default migrate into that tokenized/legacy-named dir.
 */
export async function resolveDefaultNamespaceRoot(config: PluginConfig): Promise<string> {
  if (!config.namespacesEnabled) {
    return config.memoryDir;
  }

  const legacyNsDir = resolveNamespaceDir(config.memoryDir, config.defaultNamespace);
  const tokenizedNsDir = resolveNamespaceDir(
    config.memoryDir,
    namespaceIdentityToken(config.defaultNamespace),
  );
  const tokenizedHasData =
    (await exists(tokenizedNsDir)) &&
    (await hasAnyNamespaceStorageMarker(tokenizedNsDir, { includeRuntimeState: true }));
  const nsDir = tokenizedHasData
    ? tokenizedNsDir
    : (await exists(legacyNsDir))
      ? legacyNsDir
      : tokenizedNsDir;
  return (await exists(nsDir)) && !(await hasAnyLegacyData(config.memoryDir))
    ? nsDir
    : config.memoryDir;
}

/**
 * Resolve the runtime storage root for ANY namespace exactly as the live router
 * would (`NamespaceStorageRouter.namespaceRoot`). Shared so the rebuildable
 * catalog records the SAME on-disk root the router routes to — a recall/read
 * touch must not guess `namespaces/<token>` when the router actually serves a
 * legacy raw-name dir or a migrated default root (CLAUDE.md rule #22/#42; round
 * 4, cursor Medium). The default namespace delegates to `resolveDefaultNamespaceRoot`;
 * every other namespace prefers the tokenized root when it has a storage marker,
 * else a legacy raw-name dir when present, else the tokenized root.
 */
export async function resolveNamespaceStorageRoot(
  config: PluginConfig,
  namespace: string,
): Promise<string> {
  if (!config.namespacesEnabled) return config.memoryDir;
  if (namespace === config.defaultNamespace) {
    return resolveDefaultNamespaceRoot(config);
  }
  const legacyRoot = resolveNamespaceDir(config.memoryDir, namespace);
  const tokenizedRoot = resolveNamespaceDir(config.memoryDir, namespaceIdentityToken(namespace));
  if (
    (await exists(tokenizedRoot)) &&
    (await hasAnyNamespaceStorageMarker(tokenizedRoot, { includeRuntimeState: true }))
  ) {
    return tokenizedRoot;
  }
  return (await exists(legacyRoot)) ? legacyRoot : tokenizedRoot;
}

export class NamespaceStorageRouter {
  private readonly cache = new Map<string, StorageManager>();
  private defaultNsRootResolved: string | null = null;
  // Dedup the resolve hook (round 6, cursor Medium — NCNL2). Recall/extraction
  // call `storageFor` repeatedly; firing `onResolve` (→ catalog loadCompacted +
  // append) on every cache hit grows `namespaces.jsonl` without bound between
  // rebuilds. We fire the hook only when the (namespace, storageDir) pair is new
  // or its dir changed, so a steady-state cache hit is a no-op for the catalog.
  private readonly notifiedResolved = new Map<string, string>();

  constructor(
    private readonly config: PluginConfig,
    private readonly hooks: NamespaceStorageRouterHooks = {},
  ) {}

  private async defaultNamespaceRoot(): Promise<string> {
    this.defaultNsRootResolved = await resolveDefaultNamespaceRoot(this.config);
    return this.defaultNsRootResolved;
  }

  private async namespaceRoot(namespace: string): Promise<string> {
    // NOTE: only used after defaultNamespaceRoot() resolution.
    if (!this.config.namespacesEnabled) return this.config.memoryDir;
    if (namespace === this.config.defaultNamespace) {
      return this.defaultNsRootResolved ?? this.config.memoryDir;
    }
    return resolveNamespaceStorageRoot(this.config, namespace);
  }

  async storageFor(namespace: string): Promise<StorageManager> {
    const ns = normalizeNamespaceIdentity(namespace || this.config.defaultNamespace);
    if (ns !== this.config.defaultNamespace && !isSafeRouteNamespace(ns)) {
      throw new Error(`unsafe namespace: ${ns}`);
    }
    // Even when the default namespace is exempt from the check above, every
    // on-disk path is built through resolveNamespaceDir(), which rejects
    // traversal segments — so an unsafe configured default still cannot escape
    // <memoryDir>/namespaces (CodeQL js/path-injection).

    let root: string;
    if (ns === this.config.defaultNamespace) {
      root = await this.defaultNamespaceRoot();
      const cached = this.cache.get(ns);
      if (cached && cached.dir === root) {
        this.notifyResolved(ns, root);
        return cached;
      }
    } else {
      const cached = this.cache.get(ns);
      root = await this.namespaceRoot(ns);
      if (cached && cached.dir === root) {
        this.notifyResolved(ns, root);
        return cached;
      }
    }

    const sm = new StorageManager(root, this.config.entitySchemas);
    // Propagate the inline-attribution template so that router-created storages
    // (used by extraction and shared-promotion paths) strip citations consistently,
    // matching the behaviour of the primary this.storage instance in the orchestrator.
    sm.citationTemplate = this.config.inlineSourceAttributionFormat;
    this.cache.set(ns, sm);
    this.notifyResolved(ns, root);
    return sm;
  }

  /**
   * Fire the resolve hook defensively. A hook failure (e.g. a catalog write
   * error) MUST NOT crash storage resolution — see CLAUDE.md gotcha #13.
   */
  private notifyResolved(namespace: string, storageDir: string): void {
    const hook = this.hooks.onResolve;
    if (!hook) return;
    // Skip when we've already notified this exact (namespace, storageDir) — a
    // steady-state cache hit must not re-append to the catalog log (NCNL2). A
    // changed dir (rare: migration/realignment) still re-fires once.
    if (this.notifiedResolved.get(namespace) === storageDir) return;
    this.notifiedResolved.set(namespace, storageDir);
    try {
      // Handle BOTH synchronous throws and asynchronous rejections (round 6,
      // codex P2 — NDo8C). The hook is typed `void`, but a caller may supply an
      // `async` function; its rejected promise would bypass this try/catch and,
      // where unhandled rejections are fatal, crash storage resolution. Wrap in
      // `Promise.resolve(...).catch()` so a best-effort catalog/register failure
      // never propagates (CLAUDE.md gotcha #13).
      Promise.resolve(hook(namespace, storageDir)).catch(() => undefined);
    } catch {
      // Intentionally swallow: catalog registration is best-effort metadata.
    }
  }
}
