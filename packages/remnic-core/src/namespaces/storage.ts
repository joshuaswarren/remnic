import { resolveNamespaceCapabilities } from "../capabilities.js";
import path from "node:path";
import { access, lstat, readdir } from "node:fs/promises";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";
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

  // Build the legacy default root from the NORMALIZED (trimmed) name so a
  // whitespace-padded `defaultNamespace` still finds the live `namespaces/default`
  // root (NIabe). `storageFor()` classifies the trimmed value as the default, and
  // the on-disk legacy dir is created under the trimmed name; using the raw spaced
  // name here would look for `namespaces/<spaced>` and miss the real root, falling
  // back to memoryDir/tokenized. `namespaceIdentityToken` already normalizes
  // internally, so the tokenized path is unaffected.
  const defaultIdentity = normalizeNamespaceIdentity(config.defaultNamespace);
  const legacyNsDir = resolveNamespaceDir(config.memoryDir, defaultIdentity);
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
  if (!resolveNamespaceCapabilities(config).namespaces) return config.memoryDir;
  // Compare on NORMALIZED identity so a whitespace-padded configured default name
  // still routes to the default root rather than a tokenized non-default dir
  // (NH-FH). The catalog keys records by the same normalized identity.
  if (normalizeNamespaceIdentity(namespace) === normalizeNamespaceIdentity(config.defaultNamespace)) {
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
  // Instance-scoped serializer for the resolve hook (issue #1524 adoption).
  // Replaces the bespoke `inFlightResolved` marker-then-clear pattern: the
  // serializer's per-key chain strictly orders concurrent notifications for the
  // SAME namespace, and the task re-checks `notifiedResolved` once it runs, so a
  // burst of cache hits before the first hook settles collapses to a single
  // hook invocation (the once-per-namespace intent). Recovery is preserved —
  // one rejected hook never poisons subsequent notifications for that key.
  private readonly resolveSerializer = new MutationSerializer();
  // (namespace, storageDir) pairs whose resolve hook is currently pending. Set SYNCHRONOUSLY in
  // notifyResolved (before queueing) so a burst of concurrent storageFor()
  // cache hits collapses onto the one in-flight hook instead of each enqueuing
  // its own task. Cleared when the queued hook settles. Without this, a dropped
  // hook (returns false on a rebuild-lock timeout) leaves notifiedResolved
  // unset, so every queued sibling task would re-run the hook — N serial lock
  // waits (cursor Medium 06f58a7c, codex P2).
  private readonly inFlightResolveHooks = new Set<string>();
  // Tracks every in-flight resolve-hook promise so callers can deterministically
  // await the fire-and-forget registrations that `storageFor()` kicks off (see
  // `whenResolveHooksSettled`). Entries are removed as each hook settles, so the
  // set holds at most one promise per concurrently-resolving namespace.
  private readonly pendingResolveHooks = new Set<Promise<unknown>>();
  // Pending post-write catalog touch promises (#1522). Like pendingResolveHooks,
  // lets tests await fire-and-forget write touches deterministically.
  private readonly pendingWriteTouches = new Set<Promise<unknown>>();

  // Normalized (trimmed) default namespace identity (NH-FH). `storageFor`
  // normalizes its input, so default-namespace branches must compare against the
  // normalized config default too — otherwise a whitespace-padded configured
  // default name routes the default namespace to a tokenized non-default root.
  private readonly defaultNamespaceIdentity: string;

  constructor(
    private readonly config: PluginConfig,
    private readonly hooks: NamespaceStorageRouterHooks = {},
    /** Catalog reference for post-write/read touches (issue #1522 chokepoint). */
    private readonly catalog?: NamespaceCatalog,
  ) {
    this.defaultNamespaceIdentity = normalizeNamespaceIdentity(config.defaultNamespace);
  }

  private async defaultNamespaceRoot(): Promise<string> {
    this.defaultNsRootResolved = await resolveDefaultNamespaceRoot(this.config);
    return this.defaultNsRootResolved;
  }

  private async namespaceRoot(namespace: string): Promise<string> {
    // NOTE: only used after defaultNamespaceRoot() resolution.
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
    // Even when the default namespace is exempt from the check above, every
    // on-disk path is built through resolveNamespaceDir(), which rejects
    // traversal segments — so an unsafe configured default still cannot escape
    // <memoryDir>/namespaces (CodeQL js/path-injection).

    let root: string;
    if (ns === this.defaultNamespaceIdentity) {
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

    // Pass the hot-memories cache gate explicitly (issue #1902, Codex P2): a
    // per-namespace child root is never registered in the per-dir default map,
    // so without this it would fall back to the process-wide default and ignore
    // THIS daemon's hotMemoriesCacheEnabled config. Threading it from config
    // keeps every namespace storage aligned with its owning orchestrator.
    const sm = new StorageManager(
      root,
      this.config.entitySchemas,
      this.config.hotMemoriesCacheEnabled,
    );
    // Register this child root's gate AND TTL in the per-dir maps (issue #1902,
    // Codex P2). The constructor override above fixes the child's own gate, but
    // its TTL is resolved via the per-dir map (hotCacheTtlMs); an unregistered
    // child root would fall back to the last process-wide TTL and could inherit
    // another daemon's value. Registering keyed by root keeps both per-dir.
    StorageManager.setHotMemoriesCacheDefault(
      root,
      this.config.hotMemoriesCacheEnabled,
      this.config.hotMemoriesCacheTtlMs,
    );
    const { scopedCacheInvalidationEnabled } = this.config;
    StorageManager.setScopedCacheInvalidationDefault(root, scopedCacheInvalidationEnabled);
    // Propagate the inline-attribution template so that router-created storages
    // (used by extraction and shared-promotion paths) strip citations consistently,
    // matching the behaviour of the primary this.storage instance in the orchestrator.
    sm.citationTemplate = this.config.inlineSourceAttributionFormat;
    // #1522: install the post-write catalog touch at the chokepoint — every
    // successful write on this StorageManager records the namespace touch.
    this.bindCatalogWriteHook(sm, ns);
    // #1579: apply the tombstone non-resurrection config so every namespace
    // storage enforces the invariant at its own writeMemory chokepoint.
    this.applyTombstonesConfig(sm, ns);
    this.cache.set(ns, sm);
    this.notifyResolved(ns, root);
    return sm;
  }

  /**
   * Fire the resolve hook defensively. A hook failure (e.g. a catalog write
   * error) MUST NOT crash storage resolution — see CLAUDE.md gotcha #13.
   *
   * Issue #1524 adoption: hook invocations for the SAME namespace are now
   * strictly ordered through the shared `MutationSerializer` rather than the
   * bespoke `inFlightResolved` marker-then-clear pattern. The serializer
   * guarantees one in-flight hook per namespace; a concurrent burst of
   * `storageFor()` cache hits collapses to a single hook invocation because
   * each queued task re-checks `notifiedResolved` before invoking the hook. A
   * dropped (`false`) or rejected hook leaves `notifiedResolved` unset so the
   * next `storageFor()` retries — the serializer recovers from the rejection,
   * so a failed hook never poisons later notifications.
   */
  private notifyResolved(namespace: string, storageDir: string): void {
    const hook = this.hooks.onResolve;
    if (!hook) return;
    // Permanent dedup: skip once we've SUCCESSFULLY notified this exact
    // (namespace, storageDir). A changed dir (rare: migration/realignment)
    // still re-fires once. The mark is set ONLY AFTER the hook succeeds, so a
    // dropped registration (e.g. rebuild-lock timeout) is RETRIED on the next
    // cache hit instead of being suppressed forever (round 6, cursor Medium —
    // ND3EJ).
    if (this.notifiedResolved.get(namespace) === storageDir) return;
    // In-flight dedup (cursor Medium 06f58a7c, codex P2): if a hook for THIS
    // namespace is already pending, collapse this call onto it instead of
    // enqueueing another task. The serializer strictly orders queued tasks, but
    // ordering alone is not enough — when the first hook returns `false`
    // (dropped touch, e.g. rebuild-lock timeout), `notifiedResolved` stays
    // unset, so each queued sibling task would pass its re-check and re-run the
    // hook. With the real catalog hook each retry can spend the full lock wait,
    // so N cache hits during a rebuild leave N serial background lock attempts.
    // Collapsing here means at most ONE hook runs per in-flight registration;
    // its result (set `notifiedResolved` on success, leave unset on drop)
    // decides whether a LATER `storageFor()` retries — collapsing loses
    // nothing because the drop is already retried on the next cache hit.
    // Keyed by the composite (namespace, storageDir) so a CHANGED dir
    // (migration/realignment) for the same namespace still gets its own hook —
    // it is NOT collapsed onto the old dir's pending registration (cursor
    // Medium, codex P2).
    const inFlightKey = namespace + "\u0000" + storageDir;
    if (this.inFlightResolveHooks.has(inFlightKey)) return;
    this.inFlightResolveHooks.add(inFlightKey);
    // Queue through the serializer. Concurrent calls for the same namespace
    // strictly order here; the 2nd call's task runs only after the 1st's hook
    // settles, by which point `notifiedResolved` is either set (no-op) or still
    // unset (retry). The returned promise is tracked for
    // `whenResolveHooksSettled()`. Rejections from the task body are caught so
    // they never reach the caller (best-effort hook contract); the serializer's
    // recovered tail still lets subsequent notifications run.
    const task = async (): Promise<void> => {
      // Re-check after queueing: a prior task in this same chain may have just
      // marked the pair as notified.
      if (this.notifiedResolved.get(namespace) === storageDir) return;
      try {
        // Hook may be sync or async; Promise.resolve normalizes both. A result
        // of `false` means the registration was dropped/no-op (e.g. rebuild-lock
        // timeout) — leave notifiedResolved UNSET so the next storageFor retries
        // (round 6, codex P2 — NEFoX). `void`/`undefined` is success for legacy
        // hooks. A rejection leaves notifiedResolved unset for the same reason.
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
    // Clear the in-flight marker when the hook settles so a subsequent
    // storageFor() can retry after a drop, or short-circuit via notifiedResolved
    // after a success.
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
    // Issue #1903: pure state-file writes only touch the catalog when explicitly
    // opted in. Router-created storages (storageFor) and the legacy default
    // storage both flow through here, so this is the single wiring point.
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

  /**
   * Apply the tombstone config to a router-created StorageManager. Called
   * inline in `storageFor()` so every namespace storage enforces the
   * non-resurrection invariant, namespace-scoped (rule 42).
   */
  private applyTombstonesConfig(sm: StorageManager, namespace: string): void {
    sm.setTombstonesConfig({ ...this.tombstonesGlobalConfig, namespace });
  }

  /**
   * Post-write catalog touch (issue #1522 chokepoint). Called by every
   * StorageManager's post-write hook AFTER a successful write. Best-effort
   * and failure-tolerant — a catalog error MUST NOT affect the primary write
   * (gotcha #13, rule #40). Fire-and-forget by design.
   */
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
    // Flush any coalesced (buffered) touches first so their appends join the
    // pending set below — otherwise this could resolve while a buffered touch's
    // lastWriteAt is still unwritten on disk (#1903, Cursor). No-op when
    // coalescing is disabled (window 0) or the catalog is inert.
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
}
