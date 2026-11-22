import { resolveNamespaceCapabilities, resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import path from "node:path";
import { access, lstat, readdir } from "node:fs/promises";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { StorageManager } from "../storage.js";
import { keyring, secureStoreDir } from "../secure-store/index.js";
import type { PluginConfig } from "../types.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import { isMacOsReplicationJunkBasename } from "../utils/macos-replication-junk.js";
import {
  namespaceIdentityLegacyToken,
  namespaceIdentityToken,
  normalizeNamespaceIdentity,
} from "./identity.js";
import type { NamespaceCatalog } from "./catalog.js";
import { MutationSerializer } from "../utils/serialize-mutations.js";

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
      if (isMacOsReplicationJunkBasename(child.name)) continue;
      const childPath = path.join(p, child.name);
      if (child.isSymbolicLink() || child.isFile()) return true;
      if (child.isDirectory() && (await hasStoredEntries(childPath))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function resolveNamespaceDir(memoryDir: string, segment: string): string {
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
 * Optional hooks for the storage router. `onResolve` fires whenever a namespace's
 * storage is resolved/created, so a downstream consumer (e.g. the namespace
 * catalog, issue #1499) can register the namespace. The hook MUST NOT throw into
 * the router; the router invokes it defensively and a hook failure never affects
 * storage resolution.
 *
 * The hook MAY return (or resolve to) a boolean indicating whether the
 * registration actually PERSISTED (round 6, codex P2 — NEFoX). When it resolves
 * to `false` (a dropped/no-op registration), the router does NOT mark the
 * (namespace, storageDir) pair as notified, so the next resolve RETRIES it
 * instead of suppressing it forever. A `void`/`undefined` result is treated as
 * success (legacy hooks).
 */
export interface NamespaceStorageRouterHooks {
  onResolve?: (
    namespace: string,
    storageDir: string,
  ) => void | boolean | Promise<void | boolean>;
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
  if (!resolveNamespaceCapabilities(config).namespaces) {
    return config.memoryDir;
  }

  const defaultIdentity = normalizeNamespaceIdentity(config.defaultNamespace);
  const defaultNfdIdentity = defaultIdentity.normalize("NFD");
  const legacyNsDir = resolveNamespaceDir(config.memoryDir, defaultIdentity);
  const legacyNfdNsDir = resolveNamespaceDir(config.memoryDir, defaultNfdIdentity);
  const tokenizedNsDir = resolveNamespaceDir(
    config.memoryDir,
    namespaceIdentityToken(defaultIdentity),
  );
  const legacyTokenNsDir = resolveNamespaceDir(
    config.memoryDir,
    namespaceIdentityLegacyToken(defaultNfdIdentity),
  );
  const tokenizedHasData =
    (await exists(tokenizedNsDir)) &&
    (await hasAnyNamespaceStorageMarker(tokenizedNsDir, { includeRuntimeState: true }));
  const legacyTokenHasData =
    (await exists(legacyTokenNsDir)) &&
    (await hasAnyNamespaceStorageMarker(legacyTokenNsDir, { includeRuntimeState: true }));
  const legacyHasData =
    (await exists(legacyNsDir)) &&
    (await hasAnyNamespaceStorageMarker(legacyNsDir, { includeRuntimeState: true }));
  const legacyNfdHasData =
    legacyNfdNsDir !== legacyNsDir &&
    (await exists(legacyNfdNsDir)) &&
    (await hasAnyNamespaceStorageMarker(legacyNfdNsDir, { includeRuntimeState: true }));
  const nsDir = tokenizedHasData
    ? tokenizedNsDir
    : legacyTokenHasData
      ? legacyTokenNsDir
      : legacyHasData
        ? legacyNsDir
        : legacyNfdHasData
          ? legacyNfdNsDir
          : (await exists(legacyNsDir))
            ? legacyNsDir
            : legacyNfdNsDir !== legacyNsDir && (await exists(legacyNfdNsDir))
              ? legacyNfdNsDir
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
  if (!resolveNamespaceCapabilities(config).namespaces) return config.memoryDir;
  if (normalizeNamespaceIdentity(namespace) === normalizeNamespaceIdentity(config.defaultNamespace)) {
    return resolveDefaultNamespaceRoot(config);
  }
  const normalized = normalizeNamespaceIdentity(namespace);
  const legacyExactNamespace = namespace.trim();
  const legacyNfdNamespace = normalized.normalize("NFD");
  const legacyRoot = resolveNamespaceDir(config.memoryDir, normalized);
  const legacyExactRoot =
    legacyExactNamespace !== normalized && isSafeRouteNamespace(legacyExactNamespace)
      ? resolveNamespaceDir(config.memoryDir, legacyExactNamespace)
      : null;
  const legacyNfdRoot =
    legacyNfdNamespace !== normalized
      ? resolveNamespaceDir(config.memoryDir, legacyNfdNamespace)
      : null;
  const tokenizedRoot = resolveNamespaceDir(config.memoryDir, namespaceIdentityToken(normalized));
  const legacyTokenRoots = [
    namespaceIdentityLegacyToken(legacyExactNamespace),
    namespaceIdentityLegacyToken(legacyNfdNamespace),
  ]
    .filter((token, index, tokens) => tokens.indexOf(token) === index)
    .map((token) => resolveNamespaceDir(config.memoryDir, token));
  for (const candidate of [tokenizedRoot, ...legacyTokenRoots]) {
    if (
      (await exists(candidate)) &&
      (await hasAnyNamespaceStorageMarker(candidate, { includeRuntimeState: true }))
    ) {
      return candidate;
    }
  }
  for (const candidate of [legacyRoot, legacyExactRoot, legacyNfdRoot]) {
    if (candidate && (await exists(candidate))) return candidate;
  }
  return tokenizedRoot;
}

export class NamespaceStorageRouter {
  private readonly cache = new Map<string, StorageManager>();
  private defaultNsRootResolved: string | null = null;
  private readonly notifiedResolved = new Map<string, string>();
  private readonly resolveSerializer = new MutationSerializer();
  private readonly inFlightResolveHooks = new Set<string>();
  private readonly pendingResolveHooks = new Set<Promise<unknown>>();
  private readonly pendingWriteTouches = new Set<Promise<unknown>>();

  private readonly defaultNamespaceIdentity: string;

  /** #2019: hook fired when a new namespace storage is created via storageFor. */
  onStorageCreated?: (storage: StorageManager, namespace: string) => void;

  constructor(
    private readonly config: PluginConfig,
    private readonly hooks: NamespaceStorageRouterHooks = {},
    private readonly catalog?: NamespaceCatalog,
  ) {
    this.defaultNamespaceIdentity = normalizeNamespaceIdentity(config.defaultNamespace);
  }

  private async defaultNamespaceRoot(): Promise<string> {
    this.defaultNsRootResolved = await resolveDefaultNamespaceRoot(this.config);
    return this.defaultNsRootResolved;
  }

  private async namespaceRoot(namespace: string): Promise<string> {
    if (!resolveNamespaceCapabilities(this.config).namespaces) return this.config.memoryDir;
    if (normalizeNamespaceIdentity(namespace) === this.defaultNamespaceIdentity) {
      return this.defaultNsRootResolved ?? this.config.memoryDir;
    }
    return resolveNamespaceStorageRoot(this.config, namespace);
  }

  async storageFor(namespace: string): Promise<StorageManager> {
    const ns = normalizeNamespaceIdentity(namespace || this.config.defaultNamespace);
    if (ns !== this.defaultNamespaceIdentity && !isSafeRouteNamespace(ns)) {
      throw new Error(`unsafe namespace: ${ns}`);
    }

    let root: string;
    if (ns === this.defaultNamespaceIdentity) {
      root = await this.defaultNamespaceRoot();
      const cached = this.cache.get(ns);
      if (cached && cached.dir === root) {
        await this.applySecureStoreConfig(cached);
        this.notifyResolved(ns, root);
        return cached;
      }
    } else {
      const cached = this.cache.get(ns);
      root = await this.namespaceRoot(ns);
      if (cached && cached.dir === root) {
        await this.applySecureStoreConfig(cached);
        this.notifyResolved(ns, root);
        return cached;
      }
    }

    const sm = new StorageManager(
      root,
      this.config.entitySchemas,
      this.config.hotMemoriesCacheEnabled,
    );
    StorageManager.setHotMemoriesCacheDefault(
      root,
      this.config.hotMemoriesCacheEnabled,
      this.config.hotMemoriesCacheTtlMs,
    );
    const { scopedCacheInvalidationEnabled } = this.config;
    StorageManager.setScopedCacheInvalidationDefault(root, scopedCacheInvalidationEnabled);
    sm.citationTemplate = this.config.inlineSourceAttributionFormat;
    sm.citationTemplateHistory = this.config.inlineSourceAttributionFormatHistory;
    this.bindCatalogWriteHook(sm, ns);
    this.applyTombstonesConfig(sm, ns);
    await this.applySecureStoreConfig(sm);
    this.cache.set(ns, sm);
    this.onStorageCreated?.(sm, ns);
    this.notifyResolved(ns, root);
    return sm;
  }

  private notifyResolved(namespace: string, storageDir: string): void {
    const hook = this.hooks.onResolve;
    if (!hook) return;
    if (this.notifiedResolved.get(namespace) === storageDir) return;
    const inFlightKey = namespace + "\u0000" + storageDir;
    if (this.inFlightResolveHooks.has(inFlightKey)) return;
    this.inFlightResolveHooks.add(inFlightKey);
    const task = async (): Promise<void> => {
      if (this.notifiedResolved.get(namespace) === storageDir) return;
      try {
        const persisted = await Promise.resolve(hook(namespace, storageDir));
        if (persisted !== false) {
          this.notifiedResolved.set(namespace, storageDir);
        }
      } catch {
        // Best-effort: a hook failure MUST NOT crash storage resolution. Leave
        // notifiedResolved unset so a later storageFor retries the registration.
      }
    };
    const queued = this.resolveSerializer.serialize(namespace, task);
    this.pendingResolveHooks.add(queued);
    const cleanup = (): void => {
      this.inFlightResolveHooks.delete(inFlightKey);
      this.pendingResolveHooks.delete(queued);
    };
    void queued.then(cleanup, cleanup);
  }

  /**
   * Install the post-write catalog touch hook on an externally-constructed
   * StorageManager (issue #1522). Used by the orchestrator for the legacy
   * default-namespace storage (`this.storage`) that bypasses the router.
   */
  bindCatalogWriteHook(sm: StorageManager, namespace: string): void {
    sm.touchStateWrites = this.config.namespacesCatalogTouchStateWrites === true;
    sm.onCatalogWrite = () => this.touchCatalogWrite(namespace, sm.dir);
  }

  /**
   * Install the tombstone config on an externally-constructed StorageManager
   * (issue #1579). Mirrors `bindCatalogWriteHook` — used for the legacy
   * default-namespace storage that bypasses the router. Router-created
   * storages are wired inline in `storageFor()` via `applyTombstonesConfig`.
   */
  bindTombstonesConfig(
    sm: StorageManager,
    namespace: string,
    config: { enabled: boolean; semanticMatch: boolean; semanticThreshold: number },
  ): void {
    this.tombstonesGlobalConfig = { ...config };
    sm.setTombstonesConfig({ ...config, namespace });
  }

  private tombstonesGlobalConfig: {
    enabled: boolean;
    semanticMatch: boolean;
    semanticThreshold: number;
  } = { enabled: false, semanticMatch: false, semanticThreshold: 0.9 };

  private applyTombstonesConfig(sm: StorageManager, namespace: string): void {
    sm.setTombstonesConfig({ ...this.tombstonesGlobalConfig, namespace });
  }

  private async applySecureStoreConfig(sm: StorageManager): Promise<void> {
    if (!resolveRecallAuxiliaryCapabilities(this.config).secureStore) return;
    sm.setSecureStoreRequired(true);
    const existingKey = keyring.getKey(secureStoreDir(this.config.memoryDir));
    if (existingKey) {
      await sm.setSecureStoreKeyAndWait(existingKey, this.config.secureStoreEncryptOnWrite);
    }
  }

  private touchCatalogWrite(namespace: string, storageDir: string): void {
    if (!this.catalog) return;
    const touch = this.catalog
      .markWrite(namespace, { discoveredBy: "write", storageDir })
      .catch(() => undefined);
    this.pendingWriteTouches.add(touch);
    void touch.then(
      () => { this.pendingWriteTouches.delete(touch); },
      () => { this.pendingWriteTouches.delete(touch); },
    );
  }

  /**
   * Record a namespace read in the catalog (issue #1522 chokepoint move).
   * Best-effort and failure-tolerant. Used by recall paths so the read touch
   * lives in the storage layer, not at the caller.
   */
  recordRead(namespace: string, storageDir?: string): void {
    if (!this.catalog) return;
    const ns = normalizeNamespaceIdentity(namespace || this.config.defaultNamespace);
    void this.catalog
      .markRead(ns, { discoveredBy: "read", storageDir })
      .catch(() => undefined);
  }
  /**
   * Record a namespace write touch in the catalog (issue #1522). Best-effort
   * and failure-tolerant. Used by consolidation/cleanup passes that may mutate
   * the store via delete-only paths (e.g. entity-file merges, TTL cleanup) so
   * the namespace's lastWriteAt stays fresh even when no explicit write went
   * through the storage chokepoint. This is NOT a substitute for the chokepoint
   * — it's a belt-and-suspenders for paths the chokepoint doesn't cover.
   */
  recordWrite(namespace: string, storageDir?: string): void {
    if (!this.catalog) return;
    const ns = normalizeNamespaceIdentity(namespace || this.config.defaultNamespace);
    const touch = this.catalog
      .markWrite(ns, { discoveredBy: "write", storageDir })
      .catch(() => undefined);
    this.pendingWriteTouches.add(touch);
    void touch.then(
      () => { this.pendingWriteTouches.delete(touch); },
      () => { this.pendingWriteTouches.delete(touch); },
    );
  }

  /**
   * Resolve once every in-flight post-write catalog touch has settled (#1522).
   * Mirrors `whenResolveHooksSettled()`: the StorageManager's post-write hook
   * fires the catalog touch fire-and-forget, so tests asserting lastWriteAt
   * moved should await this instead of racing a timer.
   */
  async whenWriteTouchesSettled(): Promise<void> {
    await this.catalog?.flushPendingTouches().catch(() => undefined);
    while (this.pendingWriteTouches.size > 0) {
      await Promise.allSettled([...this.pendingWriteTouches]);
    }
  }

  /**
   * Resolve once every in-flight `onResolve` registration has settled.
   *
   * `storageFor()` fires the resolve hook fire-and-forget, so its catalog side
   * effect (e.g. `registerResolved(...)`) is not observable the moment
   * `storageFor()` returns. Callers that must act on that side effect — notably
   * tests asserting the catalog was updated — should await this instead of
   * racing a timer. Resolves immediately when no hook is registered or nothing
   * is in flight. The loop re-checks because a settling hook could, in
   * principle, trigger a follow-on resolution.
   */
  async whenResolveHooksSettled(): Promise<void> {
    while (this.pendingResolveHooks.size > 0) {
      await Promise.allSettled([...this.pendingResolveHooks]);
    }
  }

  /**
   * #2019: iterate the currently cached router storages with their namespace so
   * callers can wire hooks on stores resolved before the hook was installed.
   */
  forEachCachedStorage(fn: (storage: StorageManager, namespace: string) => void): void {
    for (const [namespace, storage] of this.cache) fn(storage, namespace);
  }
}
