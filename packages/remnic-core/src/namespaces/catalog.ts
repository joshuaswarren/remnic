import { resolveNamespaceCapabilities } from "../capabilities.js";
import path from "node:path";
import type { Dirent } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { PluginConfig } from "../types.js";
import {
  MutationSerializer,
  withHeldFileLock,
} from "../utils/serialize-mutations.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { namespaceIdentityFromToken, namespaceIdentityLegacyToken, namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";
import { resolveDefaultNamespaceRoot, resolveNamespaceStorageRoot } from "./storage.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import { isNotFoundError } from "../utils/errno.js";
import {
  dropDuplicateStorageRootAliases,
  sanitizeRecordForRead,
  type CatalogReadBoundaryPort,
} from "./catalog-read-boundary.js";
import { MalformedCatalogRepairGate, malformedSidecarPath } from "./catalog-repair.js";

/**
 * Rebuildable namespace catalog (issue #1499).
 *
 * Purpose: a downstream, rebuildable metadata index that lets Remnic ENUMERATE
 * the configured and dynamically-created namespaces that exist or should be
 * maintained. Filesystem memory remains the single source of truth; the catalog
 * is derived metadata and can always be reconstructed from disk.
 *
 * Storage format: `<memoryDir>/state/namespaces.jsonl` — an append-and-compact
 * JSON-lines log. We chose this over per-namespace sidecar files because:
 *   - touches (markRead/markWrite/markMaintenance) are cheap single appends;
 *   - it is naturally audit-friendly (the raw log preserves touch history);
 *   - a single file makes enumeration trivial (no directory walk per call);
 *   - last-record-wins compaction folds the log into the current state on read,
 *     and `rebuildFromDisk` rewrites it atomically (temp file + rename).
 *
 * SECURITY:
 *   - The catalog stores ONLY metadata (namespace names, kinds, timestamps,
 *     resolved storage dirs). It NEVER holds raw memory content or secrets.
 *   - Catalog presence grants NO authorization. Read/write access still flows
 *     through the namespace policies in `principal.ts`; this module never makes
 *     an access decision.
 *   - All namespace tokens are validated with `isSafeRouteNamespace` (except the
 *     configured default namespace, which is exempt at the routing layer) and
 *     every storage dir is contained under `<memoryDir>/namespaces`.
 *   - `rebuildFromDisk` rejects/reports symlinked roots that escape the memory
 *     root rather than trusting them.
 *
 * LIFECYCLE: catalog write failures must NEVER crash a primary memory op.
 * Callers should wrap touch calls in try/catch (or rely on the internal
 * failure-tolerant append). The internal serialized write chain recovers from
 * rejection so one failed append cannot poison subsequent writes.
 */

export type NamespaceKind =
  | "default"
  | "shared"
  | "project"
  | "branch"
  | "team-project"
  | "explicit";

export type NamespaceDiscoverySource = "config" | "write" | "read" | "scan" | "migration";

export interface NamespaceRecord {
  namespace: string;
  identityToken: string;
  kind: NamespaceKind;
  createdAt: string;
  lastReadAt?: string;
  lastWriteAt?: string;
  lastMaintenanceAt?: Record<string, string>;
  storageDir: string;
  discoveredBy: NamespaceDiscoverySource;
}

export interface NamespaceCatalogFilter {
  kind?: NamespaceKind;
  discoveredBy?: NamespaceDiscoverySource;
  /** Only include namespaces written since this instant (inclusive lower bound). */
  writtenSince?: Date;
}

/** Out-parameter a catalog read fills in when it could not see the whole catalog. */
interface CatalogReadHealth {
  incomplete?: string;
  /**
   * Set ONLY when the file was read to the end and malformed rows were skipped. An unreadable
   * catalog also sets `incomplete` but never `malformed`: its empty result is not the catalog's
   * content, so nothing may be rewritten from it.
   */
  malformed?: boolean;
  /**
   * The raw malformed lines the read skipped, in file order. Only filled when `malformed` is
   * set; the repair quarantines exactly these into its sidecar before rewriting.
   */
  malformedLines?: string[];
}

export interface NamespaceCatalogReadOptions {
  /**
   * Called when the read could not see the whole catalog (an unreadable file, or malformed rows
   * that were skipped). The records that were readable are still returned. A catalog that was
   * never written is normal and does not call this.
   */
  onIncomplete?: (reason: string) => void;
}

export interface NamespaceTouchMetadata {
  discoveredBy?: NamespaceDiscoverySource;
  kind?: NamespaceKind;
  /** Explicit storage dir (when the caller already resolved it). */
  storageDir?: string;
  /** Override the touch timestamp (mainly for tests / migration replay). */
  at?: Date;
}

export interface NamespaceCatalogSkippedRoot {
  token: string;
  reason: "symlink" | "escape" | "unsafe" | "error";
  detail?: string;
}

export interface NamespaceCatalogRebuildResult {
  dryRun: boolean;
  records: NamespaceRecord[];
  /** Roots reported as ambiguous/unsafe rather than silently misclassified. */
  skipped: NamespaceCatalogSkippedRoot[];
  /**
   * Whether the rebuild actually rewrote the on-disk catalog (round 6, codex P2
   * / cursor Medium — NBn3n/NBsGG). `false` for a dry-run, AND for an `--apply`
   * that could NOT acquire the cross-process rebuild lock within the bounded wait
   * (it ran compute-only to avoid clobbering a concurrent lock holder). Callers
   * (CLI) must NOT report unqualified success when `applied` is false for a
   * non-dry-run — the catalog was left unchanged and a retry is needed.
   */
  applied: boolean;
}

const NAMESPACE_KINDS: readonly NamespaceKind[] = [
  "default",
  "shared",
  "project",
  "branch",
  "team-project",
  "explicit",
];

const NAMESPACE_DISCOVERY_SOURCES: readonly NamespaceDiscoverySource[] = [
  "config",
  "write",
  "read",
  "scan",
  "migration",
];

const CATALOG_FILE = "namespaces.jsonl";
const STATE_DIR = "state";
const REBUILD_LOCK_FILE = "namespaces.rebuild.lock";
const REBUILD_LOCK_STALE_MS = 30_000;
const REBUILD_LOCK_MAX_WAIT_MS = 5_000;
const REBUILD_LOCK_POLL_MS = 50;
const REBUILD_LOCK_HEARTBEAT_MS = 10_000;

const MEMORY_DATA_CHILDREN = [
  ...ALL_CATEGORY_DIRS,
  "entities",
  "artifacts",
  "identity",
  "config",
  "summaries",
  "profile.md",
  "state",
] as const;

function isCatalogEnabled(config: PluginConfig): boolean {
  // Inert unless namespaces are enabled. namespaceCatalogEnabled defaults to
  // true (undefined => enabled) but is only honored when namespacesEnabled.
  if (resolveNamespaceCapabilities(config).namespaces !== true) return false;
  return (config as { namespaceCatalogEnabled?: boolean }).namespaceCatalogEnabled !== false;
}

const FILE_MEMORY_DATA_CHILDREN = new Set<string>(["profile.md"]);

type MemoryDataMarkerStatus =
  | { state: "absent" }
  | { state: "valid" }
  | { state: "invalid"; detail: string };

type MemoryDataRootStatus = {
  hasData: boolean;
  invalidMarker?: string;
};

async function inspectMemoryDataMarker(rootDir: string, child: string): Promise<MemoryDataMarkerStatus> {
  const childPath = path.join(rootDir, child);
  let entry;
  try {
    entry = await lstat(childPath);
  } catch (err) {
    return isNotFoundError(err)
      ? { state: "absent" }
      : { state: "invalid", detail: `${child}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (entry.isSymbolicLink()) return { state: "invalid", detail: `${child}: symlink` };
  if (FILE_MEMORY_DATA_CHILDREN.has(child)) {
    return entry.isFile()
      ? { state: "valid" }
      : { state: "invalid", detail: `${child}: expected file` };
  }
  if (!entry.isDirectory()) return { state: "invalid", detail: `${child}: expected directory` };
  try {
    const rootReal = await realpath(rootDir);
    const childReal = await realpath(childPath);
    return isPathInside(rootReal, childReal)
      ? { state: "valid" }
      : { state: "invalid", detail: `${child}: escapes namespace root` };
  } catch (err) {
    return { state: "invalid", detail: `${child}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function inspectMemoryDataRoot(rootDir: string): Promise<MemoryDataRootStatus> {
  let hasData = false;
  for (const child of MEMORY_DATA_CHILDREN) {
    const marker = await inspectMemoryDataMarker(rootDir, child);
    if (marker.state === "invalid") {
      return { hasData: false, invalidMarker: marker.detail };
    }
    if (marker.state === "valid") {
      hasData = true;
    }
  }
  return { hasData };
}

export async function hasMemoryData(rootDir: string): Promise<boolean> {
  return (await inspectMemoryDataRoot(rootDir)).hasData;
}

function isValidIsoTimestamp(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function isNamespaceKind(value: unknown): value is NamespaceKind {
  return typeof value === "string" && (NAMESPACE_KINDS as readonly string[]).includes(value);
}

function isNamespaceDiscoverySource(value: unknown): value is NamespaceDiscoverySource {
  return typeof value === "string" && (NAMESPACE_DISCOVERY_SOURCES as readonly string[]).includes(value);
}

function coerceRecord(value: unknown): NamespaceRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.namespace !== "string") return null;
  const namespace = normalizeNamespaceIdentity(v.namespace);
  if (namespace.length === 0) return null;
  if (typeof v.identityToken !== "string" || v.identityToken.length === 0) return null;
  const expectedIdentityToken = namespaceIdentityToken(namespace);
  if (v.identityToken !== expectedIdentityToken) return null;
  if (typeof v.storageDir !== "string" || v.storageDir.length === 0) return null;
  if (typeof v.createdAt !== "string" || v.createdAt.length === 0) return null;
  if (!isValidIsoTimestamp(v.createdAt)) return null;
  const kind = isNamespaceKind(v.kind) ? v.kind : "explicit";
  const discoveredBy =
    v.discoveredBy === undefined
      ? "scan"
      : isNamespaceDiscoverySource(v.discoveredBy)
        ? v.discoveredBy
        : null;
  if (!discoveredBy) return null;
  const record: NamespaceRecord = {
    namespace,
    identityToken: expectedIdentityToken,
    kind,
    createdAt: v.createdAt,
    storageDir: v.storageDir,
    discoveredBy,
  };
  if (typeof v.lastReadAt === "string" && isValidIsoTimestamp(v.lastReadAt)) {
    record.lastReadAt = v.lastReadAt;
  }
  if (typeof v.lastWriteAt === "string" && isValidIsoTimestamp(v.lastWriteAt)) {
    record.lastWriteAt = v.lastWriteAt;
  }
  if (v.lastMaintenanceAt && typeof v.lastMaintenanceAt === "object") {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.lastMaintenanceAt as Record<string, unknown>)) {
      if (typeof val === "string" && isValidIsoTimestamp(val)) out[k] = val;
    }
    if (Object.keys(out).length > 0) record.lastMaintenanceAt = out;
  }
  return record;
}

/** Later of two optional ISO timestamps (undefined-safe). */
function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const am = Date.parse(a);
  const bm = Date.parse(b);
  if (!Number.isFinite(am)) return b;
  if (!Number.isFinite(bm)) return a;
  return bm > am ? b : a;
}

export function mergeNewerTouchFields(base: NamespaceRecord, fresh: NamespaceRecord): NamespaceRecord {
  const merged: NamespaceRecord = { ...base };
  const lr = laterIso(base.lastReadAt, fresh.lastReadAt);
  if (lr) merged.lastReadAt = lr;
  const lw = laterIso(base.lastWriteAt, fresh.lastWriteAt);
  if (lw) merged.lastWriteAt = lw;
  if (base.lastMaintenanceAt || fresh.lastMaintenanceAt) {
    const jobs: Record<string, string> = { ...(base.lastMaintenanceAt ?? {}) };
    for (const [job, ts] of Object.entries(fresh.lastMaintenanceAt ?? {})) {
      const latest = laterIso(jobs[job], ts);
      if (latest) jobs[job] = latest;
    }
    if (Object.keys(jobs).length > 0) merged.lastMaintenanceAt = jobs;
  }
  return merged;
}

function serializeRecord(record: NamespaceRecord): string {
  const ordered: Record<string, unknown> = {};
  const source = record as unknown as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === "lastMaintenanceAt" && value && typeof value === "object") {
      const sortedJobs: Record<string, string> = {};
      for (const jobKey of Object.keys(value as Record<string, string>).sort()) {
        sortedJobs[jobKey] = (value as Record<string, string>)[jobKey]!;
      }
      ordered[key] = sortedJobs;
      continue;
    }
    ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/**
 * Infer the namespace kind from its name/structure using the same conventions
 * as `coding-namespace.ts` (project-*, *-branch-*, team-*-project-*). Returns
 * `explicit` when no structural signal is present. The caller can override.
 */
function inferKind(namespace: string, config: PluginConfig): NamespaceKind {
  if (namespace === normalizeNamespaceIdentity(config.defaultNamespace)) return "default";
  if (namespace === normalizeNamespaceIdentity(config.sharedNamespace)) return "shared";
  if (config.namespacePolicies.some((p) => normalizeNamespaceIdentity(p.name) === namespace)) {
    return "explicit";
  }
  if (/-branch-|^project-[^-]+-branch-/.test(namespace) || namespace.includes("-branch-")) {
    return "branch";
  }
  if (/^team-.*-project-/.test(namespace) || /^team-.*project-/.test(namespace)) {
    return "team-project";
  }
  if (/^project-/.test(namespace) || /-project-/.test(namespace)) {
    return "project";
  }
  return "explicit";
}

interface CatalogFileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface CompactedCatalogCache {
  identity: CatalogFileIdentity;
  records: Map<string, NamespaceRecord>;
  /** Why the read was incomplete (malformed rows), kept so a cache hit reports it too. */
  incomplete?: string;
}

export class NamespaceCatalog {
  private readonly memoryDir: string;
  private readonly stateDir: string;
  private readonly catalogPath: string;
  private readonly rebuildLockPath: string;
  private readonly criticalSection = new MutationSerializer();
  private compactedCache: CompactedCatalogCache | undefined;
  protected onTouchCriticalSectionForTest?: () => Promise<void>;
  protected onCatalogReadForTest?: () => void;
  protected onAfterCatalogAppendForTest?: () => Promise<void>;
  protected onRebuildBeforeRenameForTest?: () => Promise<void>;
  protected onRebuildAfterScanForTest?: () => Promise<void>;
  protected onBeforeBreakStaleUnlinkForTest?: () => Promise<void>;

  private readonly defaultNamespaceIdentity: string;

  private readonly compactBytesLimit: number;
  private readonly readCoalesceMs: number;
  private readonly writeCoalesceMs: number;
  private readonly malformedRepairGate = new MalformedCatalogRepairGate();

  /** Test-only observability: how many repair attempts actually entered the gate. */
  get malformedRepairAttemptsForTest(): number {
    return this.malformedRepairGate.attemptCount;
  }

  private lastCompactedSize = 0;

  private readonly pendingTouches = new Map<
    string,
    {
      namespace: string;
      kind: "read" | "write";
      metadata?: NamespaceTouchMetadata;
      at: Date;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly config: PluginConfig) {
    this.memoryDir = config.memoryDir;
    this.stateDir = path.join(this.memoryDir, STATE_DIR);
    this.catalogPath = path.join(this.stateDir, CATALOG_FILE);
    this.rebuildLockPath = path.join(this.stateDir, REBUILD_LOCK_FILE);
    this.defaultNamespaceIdentity = normalizeNamespaceIdentity(config.defaultNamespace);
    this.compactBytesLimit = config.namespacesCatalogCompactBytes ?? 16 * 1024 * 1024;
    this.readCoalesceMs = config.namespacesCatalogReadTouchCoalesceMs ?? 60_000;
    this.writeCoalesceMs = config.namespacesCatalogWriteTouchCoalesceMs ?? 1_000;
  }

  /** Whether the catalog is active (namespaces enabled and catalog not opted out). */
  get enabled(): boolean {
    return isCatalogEnabled(this.config);
  }


  private catalogReadBoundaryPort(): CatalogReadBoundaryPort {
    return {
      defaultNamespaceIdentity: this.defaultNamespaceIdentity,
      memoryDir: this.memoryDir,
      isContainedStorageDir: (candidate) => this.isContainedStorageDir(candidate),
      isStorageDirForNamespace: (namespace, candidate) => this.isStorageDirForNamespace(namespace, candidate),
      resolveSafeStorageDir: (namespace) => this.resolveSafeStorageDir(namespace),
    };
  }

  private loadSanitizedRecords(health?: CatalogReadHealth): Promise<NamespaceRecord[]> {
    return this.queueCritical(async () => {
      const records = await this.loadCompacted(false, health);
      const port = this.catalogReadBoundaryPort();
      const sanitized = await Promise.all(
        [...records.values()].map((r) => sanitizeRecordForRead(port, r)),
      );
      return dropDuplicateStorageRootAliases(
        port,
        sanitized.filter((r): r is NamespaceRecord => r !== null),
        this.config,
      );
    });
  }

  async listNamespaces(
    filter?: NamespaceCatalogFilter,
    options?: NamespaceCatalogReadOptions,
  ): Promise<NamespaceRecord[]> {
    if (!this.enabled) return [];
    const health: CatalogReadHealth = {};
    let out = await this.loadSanitizedRecords(health);
    if (health.incomplete !== undefined) {
      options?.onIncomplete?.(health.incomplete);
    }
    if (health.malformed === true) {
      void this.malformedRepairGate.run(() => this.rewriteAfterIncompleteRead()).catch(() => undefined);
    }
    if (filter?.kind) out = out.filter((r) => r.kind === filter.kind);
    if (filter?.discoveredBy) out = out.filter((r) => r.discoveredBy === filter.discoveredBy);
    if (filter?.writtenSince) {
      const sinceMs = filter.writtenSince.getTime();
      out = out.filter((r) => {
        if (!r.lastWriteAt) return false;
        const ms = Date.parse(r.lastWriteAt);
        return Number.isFinite(ms) && ms >= sinceMs;
      });
    }
    return out.sort((a, b) => {
      const byName = a.namespace.localeCompare(b.namespace);
      if (byName !== 0) return byName;
      return a.identityToken.localeCompare(b.identityToken);
    });
  }

  async getNamespaceRecord(namespace: string): Promise<NamespaceRecord | null> {
    if (!this.enabled) return null;
    const ns = normalizeNamespaceIdentity(namespace);
    return (await this.loadSanitizedRecords()).find((record) => record.namespace === ns) ?? null;
  }


  async markRead(namespace: string, metadata?: NamespaceTouchMetadata): Promise<void> {
    await this.coalesceTouch(namespace, "read", metadata);
  }

  async markWrite(namespace: string, metadata?: NamespaceTouchMetadata): Promise<void> {
    await this.coalesceTouch(namespace, "write", metadata);
  }

  private async coalesceTouch(
    namespace: string,
    kind: "read" | "write",
    metadata?: NamespaceTouchMetadata,
  ): Promise<void> {
    if (!this.enabled) return;
    const window = kind === "read" ? this.readCoalesceMs : this.writeCoalesceMs;
    if (window <= 0) {
      await this.touch(namespace, kind, metadata);
      return;
    }
    const ns = this.validateNamespace(namespace);
    const cached = this.compactedCache?.records.get(ns);
    if (cached === undefined || this.touchMustFlushImmediately(kind, metadata, cached)) {
      const stale = this.pendingTouches.get(`${kind}:${ns}`);
      if (stale) {
        clearTimeout(stale.timer);
        this.pendingTouches.delete(`${kind}:${ns}`);
      }
      await this.touch(namespace, kind, metadata);
      return;
    }
    const key = `${kind}:${ns}`;
    const at = metadata?.at ?? new Date();
    const existing = this.pendingTouches.get(key);
    if (existing) {
      existing.metadata = metadata;
      existing.at = at;
      return;
    }
    const safeWindow = Math.min(window, 2_147_483_647);
    const timer = setTimeout(() => {
      void this.flushPendingTouch(key);
    }, safeWindow);
    timer.unref();
    this.pendingTouches.set(key, { namespace: ns, kind, metadata, at, timer });
  }

  /**
   * Whether a read/write touch on an EXISTING cached record must flush
   * immediately rather than coalesce. Only pure timestamp refreshes (the value
   * returns false) are safe to defer.
   */
  private touchMustFlushImmediately(
    kind: "read" | "write",
    metadata: NamespaceTouchMetadata | undefined,
    cached: NamespaceRecord,
  ): boolean {
    if (kind === "write" && cached.discoveredBy === "config") return true;
    if (kind === "write" && cached.lastWriteAt === undefined) return true;
    if (kind === "read" && cached.lastReadAt === undefined) return true;
    if (!metadata) return false;
    if (metadata.kind !== undefined && metadata.kind !== cached.kind) return true;
    if (metadata.storageDir !== undefined && metadata.storageDir !== cached.storageDir) return true;
    return false;
  }

  private async flushPendingTouch(key: string): Promise<void> {
    const pending = this.pendingTouches.get(key);
    if (!pending) return;
    this.pendingTouches.delete(key);
    clearTimeout(pending.timer);
    await this.touch(pending.namespace, pending.kind, { ...pending.metadata, at: pending.at }).catch(
      () => undefined,
    );
  }

  /**
   * Flush every buffered coalesced touch now (issue #1903). Called from the
   * router/orchestrator shutdown hook so a long-lived host does not drop
   * buffered read/write timestamps on teardown, and by tests to make coalesced
   * touches deterministically observable. Best-effort: a failed flush never
   * throws (each touch is `.catch()`-guarded).
   */
  async flushPendingTouches(): Promise<void> {
    const pending = [...this.pendingTouches.values()];
    this.pendingTouches.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      await this.touch(p.namespace, p.kind, { ...p.metadata, at: p.at }).catch(() => undefined);
    }
  }

  async markMaintenance(namespace: string, jobName: string, at?: Date): Promise<void> {
    if (typeof jobName !== "string" || jobName.trim().length === 0) {
      throw new Error("markMaintenance requires a non-empty jobName");
    }
    await this.touch(namespace, "maintenance", { at }, jobName.trim());
  }

  /**
   * Register namespaces known purely from config (default, shared, explicit
   * policies). Source `config`. Cheap and idempotent.
   */
  async registerConfiguredNamespaces(): Promise<void> {
    if (!this.enabled) return;
    const names = new Set<string>([
      this.config.defaultNamespace,
      this.config.sharedNamespace,
      ...this.config.namespacePolicies.map((p) => p.name),
    ]);
    for (const ns of names) {
      if (!ns) continue;
      if (normalizeNamespaceIdentity(ns) !== this.defaultNamespaceIdentity && !isSafeRouteNamespace(ns)) {
        continue;
      }
      try {
        await this.register(ns, { discoveredBy: "config" });
      } catch {
        // Best-effort: a single bad/unsafe name must not abort the batch.
      }
    }
  }

  /**
   * Register a namespace whose storage was just resolved by the router. Used as
   * the router's integration hook (`discoveredBy: config`). Storage dir is
   * provided so we do not re-resolve it. Failure-tolerant. Returns whether the
   * registration actually APPENDED (round 6, codex P2 — NEFoX), so the router's
   * resolve-hook dedup only marks a namespace notified when it truly persisted —
   * a dropped append (disabled catalog or rebuild-lock-timeout drop) returns
   * `false` and is retried on the next resolve.
   */
  async registerResolved(namespace: string, storageDir: string): Promise<boolean> {
    if (!this.enabled) return false;
    return this.register(namespace, { discoveredBy: "config", storageDir });
  }

  /**
   * Generic register/touch without changing read/write timestamps unless the
   * source implies it. Validates the namespace and resolves a storage dir.
   * Returns whether the touch actually appended.
   */
  private async register(namespace: string, metadata: NamespaceTouchMetadata): Promise<boolean> {
    return this.touch(namespace, "register", metadata);
  }

  private validateNamespace(namespace: string): string {
    const ns = normalizeNamespaceIdentity(namespace);
    if (ns.length === 0) throw new Error("empty namespace");
    if (ns !== this.defaultNamespaceIdentity && !isSafeRouteNamespace(ns)) {
      throw new Error(`unsafe namespace: ${ns}`);
    }
    return ns;
  }

  /**
   * Resolve the on-disk storage dir for a namespace WITHOUT trusting caller
   * input. The default namespace may use the legacy memoryDir root; everything
   * else lives under `<memoryDir>/namespaces/<token>`. Containment is enforced
   * by rejecting separators/parent-refs in the token.
   */
  private resolveStorageDir(namespace: string): string {
    if (normalizeNamespaceIdentity(namespace) === this.defaultNamespaceIdentity) {
      return this.memoryDir;
    }
    const token = namespaceIdentityToken(namespace);
    return this.namespaceTokenDir(token);
  }

  private namespaceTokenDir(token: string): string {
    if (
      token.length === 0 ||
      token.includes("/") ||
      token.includes("\\") ||
      token.includes("..") ||
      path.isAbsolute(token)
    ) {
      throw new Error(`unsafe namespace token: ${token}`);
    }
    return path.join(this.memoryDir, "namespaces", token);
  }

  private isLexicallyContained(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    if (resolved === path.resolve(this.memoryDir)) return true;
    const nsBase = path.resolve(path.join(this.memoryDir, "namespaces"));
    const rel = path.relative(nsBase, resolved);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  private async isContainedStorageDir(candidate: string): Promise<boolean> {
    if (!this.isLexicallyContained(candidate)) return false;
    if (path.resolve(candidate) === path.resolve(this.memoryDir)) return true;
    let memoryReal: string;
    try {
      memoryReal = await realpath(this.memoryDir);
    } catch {
      memoryReal = path.resolve(this.memoryDir);
    }
    if (await this.hasSymlinkedAncestor(candidate)) return false;
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) return false;
      if (!stat.isDirectory()) return false;
    } catch {
      return this.isNearestExistingAncestorContained(candidate, memoryReal);
    }
    try {
      const real = await realpath(candidate);
      return isPathInside(memoryReal, real);
    } catch {
      return false;
    }
  }

  private async hasSymlinkedAncestor(candidate: string): Promise<boolean> {
    const stopAt = path.resolve(this.memoryDir);
    let dir = path.dirname(path.resolve(candidate));
    const root = path.parse(dir).root;
    while (dir !== stopAt && dir !== root && dir !== path.dirname(dir)) {
      try {
        if ((await lstat(dir)).isSymbolicLink()) return true;
      } catch {
        // Ancestor does not exist yet — it cannot be a symlink; keep walking up.
      }
      dir = path.dirname(dir);
    }
    return false;
  }

  private async isNearestExistingAncestorContained(
    candidate: string,
    memoryReal: string,
  ): Promise<boolean> {
    let dir = path.resolve(candidate);
    const root = path.parse(dir).root;
    for (;;) {
      const parent = path.dirname(dir);
      if (parent === dir || dir === root) return false;
      let real: string;
      try {
        real = await realpath(parent);
      } catch {
        dir = parent;
        continue;
      }
      if (!(isPathInside(memoryReal, real) || real === memoryReal)) return false;
      try {
        const stat = await lstat(real);
        return stat.isDirectory();
      } catch {
        return false;
      }
    }
  }

  private async resolveTouchStorageDir(
    namespace: string,
    explicit: string | undefined,
    existingDir: string | undefined,
  ): Promise<string> {
    if (
      explicit !== undefined &&
      (await this.isContainedStorageDir(explicit)) &&
      (await this.isStorageDirForNamespace(namespace, explicit))
    ) {
      return explicit;
    }
    if (
      existingDir !== undefined &&
      (await this.isContainedStorageDir(existingDir)) &&
      (await this.isStorageDirForNamespace(namespace, existingDir))
    ) {
      return existingDir;
    }
    return this.resolveSafeStorageDir(namespace);
  }

  private async isStorageDirForNamespace(namespace: string, candidate: string): Promise<boolean> {
    const resolvedCandidate = path.resolve(candidate);
    const valid = new Set<string>();
    try {
      valid.add(path.resolve(this.namespaceTokenDir(namespaceIdentityToken(namespace))));
    } catch {
      // Unsafe token cannot build a lexical dir; fall through to other roots.
    }
    try {
      valid.add(path.resolve(this.namespaceTokenDir(namespace)));
    } catch {
      // Unsafe raw name cannot build a lexical dir; rely on the other roots.
    }
    try {
      valid.add(path.resolve(await resolveNamespaceStorageRoot(this.config, namespace)));
    } catch {
      // Router resolution failed; rely on the lexical/default roots below.
    }
    if (normalizeNamespaceIdentity(namespace) === this.defaultNamespaceIdentity) {
      valid.add(path.resolve(this.memoryDir));
      try {
        valid.add(path.resolve(await resolveDefaultNamespaceRoot(this.config)));
      } catch {
        // ignore; memoryDir already covers the common default case.
      }
    }
    return valid.has(resolvedCandidate);
  }

  private async resolveSafeStorageDir(namespace: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await resolveNamespaceStorageRoot(this.config, namespace);
    } catch {
      return this.safeFallbackStorageDir(namespace);
    }
    if (await this.isContainedStorageDir(resolved)) return resolved;
    return this.safeFallbackStorageDir(namespace);
  }

  private async safeFallbackStorageDir(namespace: string): Promise<string> {
    if (normalizeNamespaceIdentity(namespace) === this.defaultNamespaceIdentity) return this.memoryDir;
    let tokenDir: string;
    try {
      tokenDir = this.namespaceTokenDir(namespaceIdentityToken(namespace));
    } catch {
      return this.memoryDir;
    }
    if (await this.isContainedStorageDir(tokenDir)) return tokenDir;
    return this.memoryDir;
  }

  private async liveStorageRootExistsForRebuild(
    namespace: string,
    memoryReal: string | null,
  ): Promise<boolean> {
    let root: string;
    try {
      root = await this.resolveSafeStorageDir(namespace);
    } catch {
      return false;
    }
    if (
      normalizeNamespaceIdentity(namespace) !== this.defaultNamespaceIdentity &&
      path.resolve(root) === path.resolve(this.memoryDir)
    ) {
      return false;
    }
    let stat;
    try {
      stat = await lstat(root);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    if (!stat.isDirectory()) return false;
    try {
      const real = await realpath(root);
      if (memoryReal && !isPathInside(memoryReal, real)) return false;
    } catch {
      return false;
    }
    return hasMemoryData(root);
  }

  /**
   * Record a namespace touch. Returns whether the touch actually APPENDED to the
   * log (round 6, codex P2 — NEFoX): a disabled catalog or a dropped append (the
   * NAUf7 rebuild-lock-timeout drop) returns `false`, so callers (e.g. the router
   * resolve-hook dedup) can avoid marking a dropped registration as completed and
   * suppressing its retry.
   */
  private async touch(
    namespace: string,
    kind: "read" | "write" | "maintenance" | "register",
    metadata?: NamespaceTouchMetadata,
    jobName?: string,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    const ns = this.validateNamespace(namespace);
    const nowIso = (metadata?.at ?? new Date()).toISOString();

    return this.queueCritical(async () =>
      this.withHeldCatalogLock(async (acquired) => {
        if (!acquired) return false;

        if (this.onTouchCriticalSectionForTest) {
          await this.onTouchCriticalSectionForTest();
        }

        const records = await this.loadCompacted();
        const existing = records.get(ns);

        const storageDir = await this.resolveTouchStorageDir(
          ns,
          metadata?.storageDir,
          existing?.storageDir,
        );
        const record: NamespaceRecord = existing
          ? { ...existing }
          : {
              namespace: ns,
              identityToken: namespaceIdentityToken(ns),
              kind: metadata?.kind ?? inferKind(ns, this.config),
              createdAt: nowIso,
              storageDir,
              discoveredBy:
                metadata?.discoveredBy ??
                (kind === "register" ? "config" : kind === "maintenance" ? "scan" : kind),
            };

        record.storageDir = storageDir;
        if (metadata?.kind) record.kind = metadata.kind;
        if (kind === "write" && existing && record.discoveredBy === "config") {
          record.discoveredBy = "write";
        }

        if (kind === "read") record.lastReadAt = nowIso;
        if (kind === "write") record.lastWriteAt = nowIso;
        if (kind === "maintenance" && jobName) {
          record.lastMaintenanceAt = { ...(record.lastMaintenanceAt ?? {}), [jobName]: nowIso };
        }

        await this.appendUnchained(record);
        await this.maybeAutoCompact();
        return true;
      }),
    );
  }

  private async rewriteAfterIncompleteRead(): Promise<"repaired" | "dropped" | "failed"> {
    return this.queueCritical(async () =>
      this.withHeldCatalogLock(async (acquired) => {
        if (!acquired) return "dropped";
        const health: CatalogReadHealth = { malformedLines: [] };
        const folded = await this.loadCompacted(true, health);
        if (health.malformed !== true || folded.size === 0) return "failed";
        const dropped = health.malformedLines ?? [];
        if (dropped.length > 0) {
          const sidecar = malformedSidecarPath(this.catalogPath, dropped);
          await writeFile(sidecar, dropped.join("\n") + "\n", "utf8").catch(() => undefined);
        }
        await this.rewriteUnchained([...folded.values()]);
        return "repaired";
      }),
    );
  }


  private async maybeAutoCompact(): Promise<void> {
    try {
      const limit = this.compactBytesLimit; // 0 => auto-compaction disabled
      if (limit <= 0) return;
      const size = this.compactedCache?.identity.size;
      if (size === undefined || size <= limit) return;
      if (this.lastCompactedSize > 0 && size - this.lastCompactedSize < limit) return;
      const folded = await this.loadCompacted();
      await this.rewriteUnchained([...folded.values()]);
      this.lastCompactedSize = this.compactedCache?.identity.size ?? size;
    } catch {
      // Fail-open: compaction is best-effort maintenance on already-durable data.
    }
  }


  async rebuildFromDisk(
    options?: { dryRun?: boolean },
  ): Promise<NamespaceCatalogRebuildResult> {
    const dryRun = options?.dryRun === true;
    if (!this.enabled) {
      return { dryRun, records: [], skipped: [], applied: false };
    }

    //
    if (dryRun) {
      return this.queueCritical(async () => this.rebuildInsideChain(dryRun, false));
    }
    //
    //
    return this.queueCritical(async () => this.rebuildInsideChain(dryRun, true));
  }

  private async rebuildInsideChain(
    dryRun: boolean,
    wantMutate: boolean,
  ): Promise<NamespaceCatalogRebuildResult> {
    const existing = await this.loadCompacted();
    const skipped: NamespaceCatalogSkippedRoot[] = [];
    const rebuilt = new Map<string, NamespaceRecord>();
    const nowIso = new Date().toISOString();

    let memoryReal: string | null = null;
    try {
      memoryReal = await realpath(this.memoryDir);
    } catch {
      memoryReal = this.memoryDir;
    }

    //
    const defaultNs = normalizeNamespaceIdentity(this.config.defaultNamespace);
    const configured = new Set<string>(
      [
        this.config.defaultNamespace,
        this.config.sharedNamespace,
        ...this.config.namespacePolicies.map((p) => p.name),
      ]
        .map((n) => normalizeNamespaceIdentity(n))
        .filter((n) => n.length > 0),
    );

    const resolvedDefaultRoot = await resolveDefaultNamespaceRoot(this.config);
    const defaultStorageDir = (await this.isContainedStorageDir(resolvedDefaultRoot))
      ? resolvedDefaultRoot
      : this.memoryDir;
    const legacyDefaultHasData = defaultStorageDir === this.memoryDir;

    for (const ns of configured) {
      if (!ns) continue;
      if (ns !== defaultNs && !isSafeRouteNamespace(ns)) {
        let token: string;
        try {
          token = namespaceIdentityToken(ns);
        } catch {
          token = ns;
        }
        skipped.push({ token, reason: "unsafe", detail: ns });
        continue;
      }
      let storageDir: string;
      if (ns === defaultNs) {
        storageDir = defaultStorageDir;
      } else {
        try {
          storageDir = await resolveNamespaceStorageRoot(this.config, ns);
        } catch {
          storageDir = this.namespaceTokenDir(namespaceIdentityToken(ns));
        }
      }
      if (!(await this.isContainedStorageDir(storageDir))) {
        if (ns === defaultNs) {
          storageDir = this.memoryDir;
        } else {
          skipped.push({ token: namespaceIdentityToken(ns), reason: "escape", detail: storageDir });
          continue;
        }
      }
      rebuilt.set(
        ns,
        this.mergeForRebuild(existing.get(ns), {
          namespace: ns,
          identityToken: namespaceIdentityToken(ns),
          kind: inferKind(ns, this.config),
          createdAt: existing.get(ns)?.createdAt ?? nowIso,
          storageDir,
          discoveredBy: "config",
        }),
      );
    }

    const namespacesDir = path.join(this.memoryDir, "namespaces");
    let entries: Dirent[] = [];
    let namespacesDirSafe = true;
    try {
      const rootStat = await lstat(namespacesDir);
      if (rootStat.isSymbolicLink()) {
        namespacesDirSafe = false;
      } else {
        const realNamespacesDir = await realpath(namespacesDir);
        if (memoryReal && !isPathInside(memoryReal, realNamespacesDir)) {
          namespacesDirSafe = false;
        }
      }
    } catch {
      namespacesDirSafe = true;
    }
    if (!namespacesDirSafe) {
      skipped.push({ token: "namespaces", reason: "symlink", detail: namespacesDir });
    } else {
      try {
        entries = await readdir(namespacesDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
    }

    const scannedFromTokenized = new Map<string, number>();
    for (const entry of entries) {
      const token = entry.name;
      const fullPath = path.join(namespacesDir, token);
      let stat;
      try {
        stat = await lstat(fullPath);
      } catch (err) {
        skipped.push({ token, reason: "error", detail: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipped.push({ token, reason: "symlink", detail: fullPath });
        continue;
      }
      if (!stat.isDirectory()) continue;
      try {
        const real = await realpath(fullPath);
        if (memoryReal && !isPathInside(memoryReal, real)) {
          skipped.push({ token, reason: "escape", detail: real });
          continue;
        }
      } catch (err) {
        skipped.push({ token, reason: "error", detail: err instanceof Error ? err.message : String(err) });
        continue;
      }

      //
      //
      const literalRecord = existing.get(token);
      const literalOwnsRoot =
        configured.has(token) ||
        (literalRecord !== undefined &&
          path.resolve(literalRecord.storageDir) === path.resolve(fullPath));
      const tokenDecoded = literalOwnsRoot ? null : namespaceIdentityFromToken(token);
      const rawDecoded = tokenDecoded && tokenDecoded.length > 0 ? tokenDecoded : token;
      const decoded = normalizeNamespaceIdentity(rawDecoded);
      if (decoded.length === 0 || (rawDecoded !== decoded && rawDecoded.normalize("NFC") !== decoded)) {
        skipped.push({ token, reason: "unsafe", detail: rawDecoded });
        continue;
      }
      if (decoded !== defaultNs && !isSafeRouteNamespace(decoded)) {
        skipped.push({ token, reason: "unsafe", detail: decoded });
        continue;
      }
      const memoryData = await inspectMemoryDataRoot(fullPath);
      if (memoryData.invalidMarker) {
        skipped.push({
          token,
          reason: "unsafe",
          detail: `invalid memory marker: ${memoryData.invalidMarker}`,
        });
        continue;
      }
      if (!memoryData.hasData) continue;

      if (decoded === defaultNs) {
        const def = rebuilt.get(defaultNs);
        if (def) {
          def.storageDir = defaultStorageDir;
          def.kind = "default";
        }
        continue;
      }

      const canonicalToken = namespaceIdentityToken(decoded);
      const legacyToken = namespaceIdentityLegacyToken(decoded.normalize("NFD"));
      const tokenKind = token === canonicalToken ? 2 : token === legacyToken ? 1 : 0;
      const priorTokenKind = scannedFromTokenized.get(decoded) ?? 0;
      if (rebuilt.has(decoded) && priorTokenKind > tokenKind) continue;
      if (tokenKind > 0) scannedFromTokenized.set(decoded, tokenKind);

      const prior = existing.get(decoded);
      rebuilt.set(
        decoded,
        this.mergeForRebuild(prior, {
          namespace: decoded,
          identityToken: namespaceIdentityToken(decoded),
          kind: inferKind(decoded, this.config),
          createdAt: prior?.createdAt ?? nowIso,
          storageDir: fullPath,
          discoveredBy: configured.has(decoded) ? "config" : prior?.discoveredBy ?? "scan",
        }),
      );
    }

    if (legacyDefaultHasData && defaultStorageDir === this.memoryDir) {
      const def = rebuilt.get(defaultNs);
      if (def) def.kind = "default";
    }

    if (!wantMutate) {
      return this.finishRebuild(rebuilt, skipped, dryRun, false, memoryReal, nowIso);
    }
    if (this.onRebuildAfterScanForTest) {
      await this.onRebuildAfterScanForTest();
    }
    return this.withHeldCatalogLock((acquired) =>
      this.finishRebuild(rebuilt, skipped, dryRun, acquired, memoryReal, nowIso),
    );
  }

  private async finishRebuild(
    rebuilt: Map<string, NamespaceRecord>,
    skipped: NamespaceCatalogSkippedRoot[],
    dryRun: boolean,
    canMutate: boolean,
    memoryReal: string | null,
    nowIso: string,
  ): Promise<NamespaceCatalogRebuildResult> {
    if (canMutate) {
      const latest = await this.loadCompacted(true);
      for (const [ns, fresh] of latest) {
        const current = rebuilt.get(ns);
        if (!current) {
          //
          //
          if (ns !== this.defaultNamespaceIdentity && !isSafeRouteNamespace(ns)) {
            continue;
          }
          if (await this.liveStorageRootExistsForRebuild(ns, memoryReal)) {
            const safeDir = await this.resolveSafeStorageDir(ns);
            const resolvedSafe = path.resolve(safeDir);
            let owningNamespace: string | null = null;
            for (const [otherNs, otherRec] of rebuilt) {
              if (otherNs !== ns && path.resolve(otherRec.storageDir) === resolvedSafe) {
                owningNamespace = otherNs;
                break;
              }
            }
            if (owningNamespace) {
              const owner = rebuilt.get(owningNamespace);
              if (owner) rebuilt.set(owningNamespace, mergeNewerTouchFields(owner, fresh));
              continue;
            }
            rebuilt.set(ns, {
              ...fresh,
              storageDir: safeDir,
              identityToken: namespaceIdentityToken(ns),
              kind: fresh.kind ?? inferKind(ns, this.config),
              createdAt: fresh.createdAt ?? nowIso,
            });
            continue;
          }
          continue;
        }
        rebuilt.set(ns, mergeNewerTouchFields(current, fresh));
      }
    }

    const records = [...rebuilt.values()].sort((a, b) => {
      const byName = a.namespace.localeCompare(b.namespace);
      if (byName !== 0) return byName;
      return a.identityToken.localeCompare(b.identityToken);
    });

    if (canMutate) {
      if (this.onRebuildBeforeRenameForTest) {
        await this.onRebuildBeforeRenameForTest();
      }
      await this.rewriteUnchained(records);
    }

    return { dryRun, records, skipped, applied: canMutate };
  }

  /**
   * Run `fn` while HOLDING the shared cross-process advisory lock (round 5, codex
   * P2; generalized round 7 — NEZkA). This is the SINGLE mutex shared by BOTH the
   * touch read→merge→append window AND the rebuild final load→merge→rename window,
   * so a touch and a rebuild in different processes are mutually exclusive over
   * their respective critical sections — closing the check-then-append gap where a
   * polled-only touch could append into a rebuild's load→rename window.
   *
   * Issue #1524 adoption: this is now a thin delegation to the shared
   * `withHeldFileLock` utility. The acquire loop, mtime heartbeat, stale-break
   * (NG7Bg replacement-safe), and ownership-checked release (NCzT6) all live in
   * ONE place — the util — so this module no longer re-implements them. The
   * catalog's `REBUILD_LOCK_*` constants and the `onBeforeBreakStaleUnlinkForTest`
   * seam flow straight through. The util generates a per-CALL owner uuid, which
   * is stricter than the previous per-instance `lockOwnerId` (two calls on the
   * same instance get different ids, so neither mistakes the other's lock as
   * self-held — the NBsGP invariant, preserved and tightened).
   *
   * IN-PROCESS SAFETY: every caller invokes this from inside (or wrapping) the
   * per-process `queueCritical` chain, which serializes all catalog mutations in
   * THIS process (now via `MutationSerializer`). So within one process only one
   * logical holder attempts OS-lock acquisition at a time — the file lock is never
   * self-contended in-process, and the lock is acquired and released within a
   * single in-process turn. The file lock adds only the missing CROSS-process
   * exclusion.
   *
   * ACQUISITION RESULT (round 6, codex P2 — NBPmY): `fn` receives whether WE
   * actually hold the lock. When acquisition TIMED OUT (another holder is active),
   * a MUTATING rebuild must NOT perform its load/rename window unlocked, and a
   * touch must NOT append unlocked — both would recreate the lost-append race. The
   * caller uses `acquired` to run compute-only (rebuild) or DROP the append
   * (touch) when unlocked.
   */

  private withHeldCatalogLock<T>(fn: (acquired: boolean) => Promise<T>): Promise<T> {
    return withHeldFileLock(
      this.rebuildLockPath,
      {
        staleMs: REBUILD_LOCK_STALE_MS,
        maxWaitMs: REBUILD_LOCK_MAX_WAIT_MS,
        pollMs: REBUILD_LOCK_POLL_MS,
        heartbeatMs: REBUILD_LOCK_HEARTBEAT_MS,
        onBeforeBreakStaleUnlinkForTest: this.onBeforeBreakStaleUnlinkForTest,
      },
      fn,
    );
  }

  private mergeForRebuild(prior: NamespaceRecord | undefined, fresh: NamespaceRecord): NamespaceRecord {
    if (!prior) return fresh;
    const merged: NamespaceRecord = {
      ...fresh,
      createdAt: prior.createdAt ?? fresh.createdAt,
      discoveredBy: prior.discoveredBy ?? fresh.discoveredBy,
    };
    if (prior.lastReadAt) merged.lastReadAt = prior.lastReadAt;
    if (prior.lastWriteAt) merged.lastWriteAt = prior.lastWriteAt;
    if (prior.lastMaintenanceAt) merged.lastMaintenanceAt = { ...prior.lastMaintenanceAt };
    return merged;
  }

  /** Load the JSONL log and fold it into current state (last-record-wins). */
  private async loadCompacted(
    forceFresh = false,
    health?: CatalogReadHealth,
  ): Promise<Map<string, NamespaceRecord>> {
    const records = new Map<string, NamespaceRecord>();
    let handle;
    try {
      handle = await open(this.catalogPath, "r");
    } catch (error) {
      this.compactedCache = undefined;
      if (health && !isNotFoundError(error)) health.incomplete = `catalog unreadable: ${String(error)}`;
      return records;
    }

    let identity: CatalogFileIdentity | undefined;
    try {
      const fileStat = await handle.stat();
      identity = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ctimeMs: fileStat.ctimeMs,
        ino: fileStat.ino,
      };
      if (
        !forceFresh &&
        this.compactedCache &&
        this.compactedCache.identity.size === identity.size &&
        this.compactedCache.identity.mtimeMs === identity.mtimeMs &&
        this.compactedCache.identity.ctimeMs === identity.ctimeMs &&
        this.compactedCache.identity.ino === identity.ino
      ) {
        await handle.close().catch(() => undefined);
        if (health && this.compactedCache.incomplete) {
          health.incomplete = this.compactedCache.incomplete;
          health.malformed = true;
        }
        return this.cloneCompactedRecords(this.compactedCache.records);
      }
    } catch {
      // A failed fstat cannot prove freshness. Read and parse the open file, but
      // do not cache the result without a trustworthy identity.
    }

    let malformed = 0;
    try {
      this.onCatalogReadForTest?.();
      const CHUNK_BYTES = 1 << 16; // 64 KiB
      const YIELD_EVERY_LINES = 5000;
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const decoder = new StringDecoder("utf8");
      let leftover = "";
      let linesSinceYield = 0;
      const foldLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          malformed += 1;
          health?.malformedLines?.push(trimmed);
          return;
        }
        const record = coerceRecord(parsed);
        if (!record) {
          malformed += 1;
          health?.malformedLines?.push(trimmed);
          return;
        }
        const prior = records.get(record.namespace);
        records.set(record.namespace, prior ? mergeNewerTouchFields(record, prior) : record);
      };
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        leftover += decoder.write(chunk.subarray(0, bytesRead));
        let newlineIndex = leftover.indexOf("\n");
        while (newlineIndex !== -1) {
          foldLine(leftover.slice(0, newlineIndex));
          leftover = leftover.slice(newlineIndex + 1);
          if (++linesSinceYield >= YIELD_EVERY_LINES) {
            linesSinceYield = 0;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          newlineIndex = leftover.indexOf("\n");
        }
      }
      leftover += decoder.end();
      foldLine(leftover);
    } catch (error) {
      this.compactedCache = undefined;
      if (health) health.incomplete = `catalog unreadable: ${String(error)}`;
      return new Map();
    } finally {
      await handle.close().catch(() => undefined);
    }

    const incomplete = malformed > 0 ? `${malformed} malformed catalog line(s) skipped` : undefined;
    if (health && incomplete) {
      health.incomplete = incomplete;
      health.malformed = true;
    }
    this.compactedCache = identity ? { identity, records, incomplete } : undefined;
    return this.cloneCompactedRecords(records);
  }

  private cloneCompactedRecords(
    records: Map<string, NamespaceRecord>,
  ): Map<string, NamespaceRecord> {
    return new Map(
      [...records].map(([namespace, record]) => [
        namespace,
        {
          ...record,
          lastMaintenanceAt: record.lastMaintenanceAt
            ? { ...record.lastMaintenanceAt }
            : undefined,
        },
      ]),
    );
  }

  private queueCritical<T>(fn: () => Promise<T>): Promise<T> {
    return this.criticalSection.serialize("catalog", fn);
  }

  private async appendUnchained(record: NamespaceRecord): Promise<void> {
    const line = serializeRecord(record) + "\n";
    const lineByteLength = Buffer.byteLength(line, "utf8");
    await mkdir(this.stateDir, { recursive: true });
    await appendFile(this.catalogPath, line, "utf8");
    if (this.onAfterCatalogAppendForTest) {
      await this.onAfterCatalogAppendForTest();
    }
    await this.refreshCacheAfterAppend(record, lineByteLength);
  }

  private async rewriteUnchained(records: NamespaceRecord[]): Promise<void> {
    const body = records.map((r) => serializeRecord(r)).join("\n") + (records.length > 0 ? "\n" : "");
    await mkdir(this.stateDir, { recursive: true });
    const tmp = `${this.catalogPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.catalogPath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.refreshCacheIdentity(new Map(records.map((record) => [record.namespace, record])));
  }

  private async refreshCacheAfterAppend(
    record: NamespaceRecord,
    lineByteLength: number,
  ): Promise<void> {
    const cached = this.compactedCache;
    if (!cached) return;
    const expectedSize = cached.identity.size + lineByteLength;
    try {
      const fileStat = await stat(this.catalogPath);
      if (fileStat.size !== expectedSize || fileStat.ino !== cached.identity.ino) {
        this.compactedCache = undefined;
        return;
      }
      const prior = cached.records.get(record.namespace);
      cached.records.set(record.namespace, prior ? mergeNewerTouchFields(record, prior) : record);
      this.compactedCache = {
        identity: {
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ctimeMs: fileStat.ctimeMs,
          ino: fileStat.ino,
        },
        records: cached.records,
      };
    } catch {
      this.compactedCache = undefined;
    }
  }

  private async refreshCacheIdentity(records: Map<string, NamespaceRecord>): Promise<void> {
    try {
      const fileStat = await stat(this.catalogPath);
      this.compactedCache = {
        identity: {
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ctimeMs: fileStat.ctimeMs,
          ino: fileStat.ino,
        },
        records,
      };
    } catch {
      this.compactedCache = undefined;
    }
  }
}

function isPathInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
