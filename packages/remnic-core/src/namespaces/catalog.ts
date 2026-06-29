import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { PluginConfig } from "../types.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { namespaceIdentityFromToken, namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";
import { resolveDefaultNamespaceRoot, resolveNamespaceStorageRoot } from "./storage.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";

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
  | "self"
  | "shared"
  | "project"
  | "branch"
  | "team-project"
  | "explicit"
  | "legacy";

export type NamespaceDiscoverySource = "config" | "write" | "read" | "scan" | "migration";

export interface NamespaceRecord {
  namespace: string;
  identityToken: string;
  kind: NamespaceKind;
  principal?: string;
  projectId?: string;
  branch?: string;
  parentNamespace?: string;
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

export interface NamespaceTouchMetadata {
  discoveredBy?: NamespaceDiscoverySource;
  kind?: NamespaceKind;
  principal?: string;
  projectId?: string;
  branch?: string;
  parentNamespace?: string;
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

const CATALOG_FILE = "namespaces.jsonl";
const STATE_DIR = "state";
const REBUILD_LOCK_FILE = "namespaces.rebuild.lock";
// A held lock older than this is treated as stale (a crashed rebuild) and broken.
const REBUILD_LOCK_STALE_MS = 30_000;
// Bounded acquisition: poll briefly, then proceed best-effort rather than block
// a CLI rebuild forever behind a busy gateway.
const REBUILD_LOCK_MAX_WAIT_MS = 5_000;
const REBUILD_LOCK_POLL_MS = 50;
// Heartbeat: while a rebuild holds the lock it refreshes the lock file's mtime
// on this interval so a long (>STALE_MS) scan is NOT mistaken for a crashed
// holder and broken out from under it (round 5, cursor/codex Medium/P2). Must be
// comfortably below STALE_MS so at least a couple of beats land per stale window.
const REBUILD_LOCK_HEARTBEAT_MS = 10_000;

// Children that indicate a directory holds Remnic memory data (used for legacy
// default-root detection and to skip empty/non-data roots during rebuild).
//
// `state` is included to MATCH the router's storage-presence check
// (`NamespaceStorageRouter` counts the `state` runtime child via
// `includeRuntimeState: true`). Without it (round 3, cursor Medium) a namespace
// the router actively resolves because it has only a `state/` dir would be
// treated as absent by rebuild and vanish from the catalog after `--apply`.
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
  if (config.namespacesEnabled !== true) return false;
  return (config as { namespaceCatalogEnabled?: boolean }).namespaceCatalogEnabled !== false;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasMemoryData(rootDir: string): Promise<boolean> {
  for (const child of MEMORY_DATA_CHILDREN) {
    if (await pathExists(path.join(rootDir, child))) return true;
  }
  return false;
}

/**
 * Validate a JSONL line parsed value as a usable NamespaceRecord.
 * Rejects null / non-object / missing-field records (CLAUDE.md rule #18).
 */
function coerceRecord(value: unknown): NamespaceRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.namespace !== "string" || v.namespace.length === 0) return null;
  if (typeof v.identityToken !== "string" || v.identityToken.length === 0) return null;
  if (typeof v.storageDir !== "string" || v.storageDir.length === 0) return null;
  if (typeof v.createdAt !== "string" || v.createdAt.length === 0) return null;
  const kind = typeof v.kind === "string" ? (v.kind as NamespaceKind) : "explicit";
  const discoveredBy =
    typeof v.discoveredBy === "string" ? (v.discoveredBy as NamespaceDiscoverySource) : "scan";
  const record: NamespaceRecord = {
    namespace: v.namespace,
    identityToken: v.identityToken,
    kind,
    createdAt: v.createdAt,
    storageDir: v.storageDir,
    discoveredBy,
  };
  if (typeof v.principal === "string") record.principal = v.principal;
  if (typeof v.projectId === "string") record.projectId = v.projectId;
  if (typeof v.branch === "string") record.branch = v.branch;
  if (typeof v.parentNamespace === "string") record.parentNamespace = v.parentNamespace;
  if (typeof v.lastReadAt === "string") record.lastReadAt = v.lastReadAt;
  if (typeof v.lastWriteAt === "string") record.lastWriteAt = v.lastWriteAt;
  if (v.lastMaintenanceAt && typeof v.lastMaintenanceAt === "object") {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.lastMaintenanceAt as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
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

/**
 * Fold the touch fields (lastReadAt / lastWriteAt / lastMaintenanceAt) from a
 * freshly re-read on-disk record into the rebuilt record, taking the LATER
 * timestamp per field (round 5 cross-process re-merge). Disk-derived fields
 * (storageDir, kind, discoveredBy, createdAt, principal hints) are owned by the
 * rebuilt record and left untouched — we only recover touch recency that a
 * concurrent (possibly cross-process) writer recorded after our initial load.
 */
function mergeNewerTouchFields(base: NamespaceRecord, fresh: NamespaceRecord): NamespaceRecord {
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

/**
 * Serialize a record with sorted keys (CLAUDE.md rule #38) so byte output is
 * stable across runs — required for idempotent rebuilds.
 */
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
  if (namespace === config.defaultNamespace) return "default";
  if (namespace === config.sharedNamespace) return "shared";
  if (config.namespacePolicies.some((p) => p.name === namespace)) return "explicit";
  // Branch overlays embed "-branch-" (project-<id>-branch-<name>).
  if (/-branch-|^project-[^-]+-branch-/.test(namespace) || namespace.includes("-branch-")) {
    return "branch";
  }
  // Team-project promotions are prefixed team-*-project-*.
  if (/^team-.*-project-/.test(namespace) || /^team-.*project-/.test(namespace)) {
    return "team-project";
  }
  // Project overlays are "project-*" or "<principal>-project-*".
  if (/^project-/.test(namespace) || /-project-/.test(namespace)) {
    return "project";
  }
  return "explicit";
}

export class NamespaceCatalog {
  private readonly memoryDir: string;
  private readonly stateDir: string;
  private readonly catalogPath: string;
  private readonly rebuildLockPath: string;
  // Per-INSTANCE lock owner id (round 6, codex P2 — NBsGP). The rebuild lock
  // file records this id, not just `process.pid`, so two NamespaceCatalog
  // instances in the SAME process sharing a memoryDir are NOT mistaken for each
  // other: a touch on instance B must still wait for instance A's rebuild lock
  // (different owner id, same PID) instead of skipping as "self-held".
  private readonly lockOwnerId: string = randomUUID();
  // Serialized write chain that recovers from rejection (CLAUDE.md rule #40)
  // so a single failed append cannot permanently poison subsequent writes.
  private writeChain: Promise<void> = Promise.resolve();
  // Test-only seam (round 7 — NEZkA): fires inside a touch's HELD-lock critical
  // section, after the lock is acquired but BEFORE the read→merge→append. A
  // deterministic concurrency test installs a hook here to widen the (otherwise
  // microscopic) window and prove that a cross-process rebuild CANNOT run its
  // load→rename while a touch holds the lock. Never set in production code.
  protected onTouchCriticalSectionForTest?: () => Promise<void>;
  // Test-only seam (round 7 — NEZkA): fires inside a mutating rebuild's HELD-lock
  // critical section, after the final cross-process re-merge `loadCompacted()` and
  // BEFORE the atomic `rename()`. This is the EXACT window in which a check-then-
  // append touch (the old bug) would clobber its append. A deterministic test
  // installs a hook here to attempt a cross-instance touch in this window and
  // assert the held mutex blocks it. Never set in production code.
  protected onRebuildBeforeRenameForTest?: () => Promise<void>;

  constructor(private readonly config: PluginConfig) {
    this.memoryDir = config.memoryDir;
    this.stateDir = path.join(this.memoryDir, STATE_DIR);
    this.catalogPath = path.join(this.stateDir, CATALOG_FILE);
    this.rebuildLockPath = path.join(this.stateDir, REBUILD_LOCK_FILE);
  }

  /** Whether the catalog is active (namespaces enabled and catalog not opted out). */
  get enabled(): boolean {
    return isCatalogEnabled(this.config);
  }

  // ── Public enumeration API ──────────────────────────────────────────────

  /**
   * Sanitize a record's `storageDir` at the enumeration boundary (round 5,
   * cursor Medium + codex P2; round 6 — NDXHe). Reads return whatever is in
   * `namespaces.jsonl` after schema checks only, so a tampered or pre-fix
   * out-of-root path — whether a lexical escape, a lexically-contained SYMLINK
   * escaping via realpath, OR a contained-but-CROSS-NAMESPACE root (another
   * namespace's tree / memoryDir for a non-default namespace) — could be surfaced
   * to maintenance/QMD until a rewrite occurs. We apply the SAME contract as the
   * write path: full containment (`isContainedStorageDir`: lexical +
   * symlink/realpath) AND namespace ownership (`isStorageDirForNamespace`). When a
   * record fails EITHER check we substitute the trusted resolved-and-safe root for
   * that namespace before returning it (rule 42: read and write stay symmetric).
   */
  private async sanitizeRecordForRead(record: NamespaceRecord): Promise<NamespaceRecord> {
    if (
      (await this.isContainedStorageDir(record.storageDir)) &&
      (await this.isStorageDirForNamespace(record.namespace, record.storageDir))
    ) {
      return record;
    }
    const safe = await this.resolveSafeStorageDir(record.namespace);
    return { ...record, storageDir: safe };
  }

  async listNamespaces(filter?: NamespaceCatalogFilter): Promise<NamespaceRecord[]> {
    if (!this.enabled) return [];
    const records = await this.loadCompacted();
    let out = await Promise.all([...records.values()].map((r) => this.sanitizeRecordForRead(r)));
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
    // Stable sort: namespace asc, identityToken as deterministic tiebreaker
    // (CLAUDE.md rule #19 — comparator returns 0 only for truly-equal items).
    return out.sort((a, b) => {
      const byName = a.namespace.localeCompare(b.namespace);
      if (byName !== 0) return byName;
      return a.identityToken.localeCompare(b.identityToken);
    });
  }

  async getNamespaceRecord(namespace: string): Promise<NamespaceRecord | null> {
    if (!this.enabled) return null;
    const ns = normalizeNamespaceIdentity(namespace);
    const records = await this.loadCompacted();
    const record = records.get(ns);
    return record ? await this.sanitizeRecordForRead(record) : null;
  }

  // ── Touch API (cheap, failure-tolerant) ─────────────────────────────────

  async markRead(namespace: string, metadata?: NamespaceTouchMetadata): Promise<void> {
    await this.touch(namespace, "read", metadata);
  }

  async markWrite(namespace: string, metadata?: NamespaceTouchMetadata): Promise<void> {
    await this.touch(namespace, "write", metadata);
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
      // Skip unsafe configured names (e.g. a `sharedNamespace`/policy name like
      // `../evil`) consistently with `rebuildFromDisk` (round 6, cursor Low —
      // NBn3w). `register`→`validateNamespace` THROWS on unsafe tokens; without
      // this guard one bad name would abort registration of all the rest. The
      // default namespace is exempt (it may be a non-route literal). Each call is
      // also wrapped so a single failure never blocks the remaining names.
      if (ns !== this.config.defaultNamespace && !isSafeRouteNamespace(ns)) continue;
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
    // The configured default namespace is exempt from isSafeRouteNamespace at
    // the routing layer; honor the same exemption here, but everything still
    // resolves through the contained storage-dir helper below.
    if (ns !== this.config.defaultNamespace && !isSafeRouteNamespace(ns)) {
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
    if (namespace === this.config.defaultNamespace) {
      // Default may resolve to the legacy memoryDir root OR a tokenized dir; we
      // report memoryDir here as the canonical default root for the catalog.
      // rebuildFromDisk refines this when a tokenized default dir holds data.
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

  /**
   * Whether a candidate storage dir is LEXICALLY contained: it is either the
   * legacy default root (`memoryDir`) or a strict descendant of
   * `<memoryDir>/namespaces/`. The router legitimately resolves a namespace to
   * EITHER the tokenized dir or a legacy raw-name dir under `namespaces/`, so we
   * accept any contained child rather than a single exact token path. This is a
   * pure string check — symlink escape is checked separately via realpath.
   */
  private isLexicallyContained(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    if (resolved === path.resolve(this.memoryDir)) return true;
    const nsBase = path.resolve(path.join(this.memoryDir, "namespaces"));
    const rel = path.relative(nsBase, resolved);
    // Must be a strict descendant of namespaces/ (non-empty, no parent escape).
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /**
   * Whether a candidate storage dir satisfies the catalog containment contract,
   * including SYMLINK-escape rejection (round 5, codex P2). A lexically-contained
   * path that is actually a symlink to an outside directory would let maintenance
   * or QMD follow it outside `memoryDir`. We mirror `rebuildFromDisk`'s posture:
   * the path must be lexically contained AND, if it exists on disk, neither the
   * path itself a symlink nor its realpath escaping the memory root. Non-existent
   * paths pass the realpath stage (nothing to follow yet) but still must be
   * lexically contained.
   */
  private async isContainedStorageDir(candidate: string): Promise<boolean> {
    if (!this.isLexicallyContained(candidate)) return false;
    // The default/legacy memoryDir root is trusted as-is.
    if (path.resolve(candidate) === path.resolve(this.memoryDir)) return true;
    let memoryReal: string;
    try {
      memoryReal = await realpath(this.memoryDir);
    } catch {
      memoryReal = path.resolve(this.memoryDir);
    }
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) return false;
    } catch {
      // The leaf does not exist yet. Lexical containment is NOT sufficient: an
      // EXISTING ancestor (e.g. `<memoryDir>/namespaces`) could be a symlink to
      // outside memoryDir, so a future mkdir/maintenance/QMD op would follow the
      // persisted root outside the root (round 6, codex P2 — NDo79). Verify the
      // nearest EXISTING ancestor's realpath still resolves inside memoryDir.
      return this.isNearestExistingAncestorContained(candidate, memoryReal);
    }
    try {
      const real = await realpath(candidate);
      return isPathInside(memoryReal, real);
    } catch {
      return false;
    }
  }

  /**
   * Walk up from a not-yet-existing candidate to the nearest ancestor that exists
   * on disk and verify its realpath stays inside `memoryReal` (round 6, codex P2
   * — NDo79). Rejects a non-existent leaf whose existing parent chain escapes
   * memoryDir via a symlink. Stops at memoryDir's resolved root.
   */
  private async isNearestExistingAncestorContained(
    candidate: string,
    memoryReal: string,
  ): Promise<boolean> {
    let dir = path.resolve(candidate);
    const root = path.parse(dir).root;
    for (;;) {
      const parent = path.dirname(dir);
      // Reached the filesystem root without finding an existing ancestor.
      if (parent === dir || dir === root) return false;
      try {
        const real = await realpath(parent);
        // The nearest existing ancestor must resolve inside the memory root.
        return isPathInside(memoryReal, real) || real === memoryReal;
      } catch {
        // Parent does not exist yet either — keep walking up.
        dir = parent;
      }
    }
  }

  /**
   * Resolve the storage dir to persist for a touch, validating any caller-
   * provided `metadata.storageDir` against the catalog containment contract
   * (round 4 + round 5, codex P2). `markWrite`/`registerResolved` accept an
   * explicit storageDir, but persisting it verbatim would let a bad hook or
   * external consumer write an arbitrary path — including one outside `memoryDir`
   * or a symlink that escapes it — into the catalog, handing maintenance/QMD an
   * unsafe root. We accept an explicit (or previously-stored) dir ONLY when it
   * stays contained under memoryDir (lexically AND via realpath); otherwise we
   * drop it and fall back to the trusted resolved dir.
   */
  private async resolveTouchStorageDir(
    namespace: string,
    explicit: string | undefined,
    existingDir: string | undefined,
  ): Promise<string> {
    // An explicit storageDir is accepted ONLY when it is both contained AND
    // actually belongs to THIS namespace (round 6, codex P2 — NDATT). Containment
    // alone let a caller pass another namespace's tree (e.g.
    // `markWrite("project-a", { storageDir: ".../namespaces/<project-b-token>" })`)
    // or `memoryDir` for a non-default namespace; `listNamespaces()` would then
    // tell maintenance/QMD that `project-a` lives in another namespace's (or the
    // default) tree — a cross-namespace root confusion. We reject a mismatched
    // explicit root and fall back to the namespace's own resolved root.
    if (
      explicit !== undefined &&
      (await this.isContainedStorageDir(explicit)) &&
      (await this.isStorageDirForNamespace(namespace, explicit))
    ) {
      return explicit;
    }
    // Don't let a record poisoned by a pre-fix out-of-containment write keep an
    // unsafe dir alive across touches — only preserve a contained existing dir
    // that also belongs to this namespace.
    if (
      existingDir !== undefined &&
      (await this.isContainedStorageDir(existingDir)) &&
      (await this.isStorageDirForNamespace(namespace, existingDir))
    ) {
      return existingDir;
    }
    return this.resolveSafeStorageDir(namespace);
  }

  /**
   * Whether `candidate` is a legitimate storage root FOR `namespace` (round 6,
   * codex P2 — NDATT). Accepts the namespace's router-resolved root, its canonical
   * lexical tokenized dir, and (for the default namespace only) memoryDir. This
   * prevents a contained-but-CROSS-NAMESPACE path — another namespace's tree, or
   * memoryDir for a non-default namespace — from being persisted as this
   * namespace's root. Compared on resolved (absolute) paths.
   */
  private async isStorageDirForNamespace(namespace: string, candidate: string): Promise<boolean> {
    const resolvedCandidate = path.resolve(candidate);
    const valid = new Set<string>();
    // The namespace's canonical lexical TOKENIZED dir is always a valid root.
    try {
      valid.add(path.resolve(this.namespaceTokenDir(namespaceIdentityToken(namespace))));
    } catch {
      // Unsafe token cannot build a lexical dir; fall through to other roots.
    }
    // The namespace's legacy RAW-NAME dir (`namespaces/<rawname>`) is also a
    // valid root — the router serves data from it when present, even before any
    // dir exists on disk. Both forms belong to THIS namespace, never another's.
    try {
      valid.add(path.resolve(this.namespaceTokenDir(namespace)));
    } catch {
      // Unsafe raw name cannot build a lexical dir; rely on the other roots.
    }
    // The router-resolved root (whichever of the above it currently serves, a
    // migrated default, etc.).
    try {
      valid.add(path.resolve(await resolveNamespaceStorageRoot(this.config, namespace)));
    } catch {
      // Router resolution failed; rely on the lexical/default roots below.
    }
    // memoryDir is a valid root ONLY for the default namespace.
    if (namespace === this.config.defaultNamespace) {
      valid.add(path.resolve(this.memoryDir));
      try {
        valid.add(path.resolve(await resolveDefaultNamespaceRoot(this.config)));
      } catch {
        // ignore; memoryDir already covers the common default case.
      }
    }
    return valid.has(resolvedCandidate);
  }

  /**
   * Resolve the canonical storage dir for a namespace as the LIVE ROUTER would,
   * but NEVER return a path that escapes the memory root.
   *
   * Router alignment (round 4, cursor Medium): a read/register touch with no
   * explicit storageDir previously used the lexical `resolveStorageDir`, which
   * always picks `<memoryDir>/namespaces/<token>` (or `memoryDir` for the
   * default). That diverges from `NamespaceStorageRouter`, which can route to a
   * legacy raw-name dir or a migrated default root — so a recall touch could
   * record a contained-but-WRONG root that maintenance/rebuild then targets. We
   * now delegate to the shared `resolveNamespaceStorageRoot` (the very helper the
   * router uses) so the catalog records the same on-disk root the router serves.
   *
   * Containment (round 5, codex P2): the resolved path can still be a symlink
   * escaping memoryDir, so we run the full (lexical + realpath) containment
   * contract. When it FAILS we fall back to a NAMESPACE-SPECIFIC safe root, NOT
   * a blanket `memoryDir`. Recording `memoryDir` for a non-default namespace
   * would point enumeration/maintenance at the DEFAULT namespace's tree (round 5,
   * cursor/codex Medium/P2) — a cross-namespace fanout error. The correct safe
   * root is the namespace's own lexical tokenized dir
   * (`<memoryDir>/namespaces/<token>`), which is always contained and is that
   * namespace's canonical location (we record the lexical PATH as metadata; we do
   * not follow the escaping symlink). Only the default namespace — or a token so
   * unsafe even the lexical dir cannot be built — falls back to `memoryDir`.
   */
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

  /**
   * The namespace-specific contained fallback root, used when the router-resolved
   * root fails containment (round 5, cursor/codex Medium/P2).
   *
   * Preference order:
   *  1. The namespace's OWN lexical tokenized dir (`namespaces/<token>`) — so a
   *     non-default namespace is NOT pointed at the DEFAULT namespace's `memoryDir`
   *     tree (which would misdirect maintenance fanout). This is returned only
   *     when the token dir itself stays contained (it is not a symlink escaping
   *     memoryDir).
   *  2. `memoryDir` as a LAST resort — for the default namespace, an unsafe token
   *     that cannot build a contained path, OR the irreparable case where the
   *     token dir IS a symlink escaping the root (so even its lexical path
   *     resolves outside). Containment must win over tree-precision here: an
   *     escaping path is strictly worse than the (contained) default root.
   */
  private async safeFallbackStorageDir(namespace: string): Promise<string> {
    if (namespace === this.config.defaultNamespace) return this.memoryDir;
    let tokenDir: string;
    try {
      tokenDir = this.namespaceTokenDir(namespaceIdentityToken(namespace));
    } catch {
      return this.memoryDir;
    }
    if (await this.isContainedStorageDir(tokenDir)) return tokenDir;
    return this.memoryDir;
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
    // Validate up front (outside the chain) so caller-facing rejections — e.g.
    // an unsafe namespace token — surface immediately and deterministically,
    // not interleaved with serialized I/O.
    const ns = this.validateNamespace(namespace);
    const nowIso = (metadata?.at ?? new Date()).toISOString();

    // Run the read → merge → append as a single serialized critical section so
    // two concurrent touches for the same namespace cannot both observe the same
    // stale record and then have the later append win compaction while dropping
    // the earlier touch's fields (CLAUDE.md rule #40 — the chain also recovers
    // from rejection). Reading inside the chain guarantees each touch sees the
    // most recent appended state, including any concurrent read/write/register.
    // Cross-process serialization (round 7, codex P2 — NEZkA: HELD MUTEX). A CLI
    // `rebuild --apply` holds the rebuild lock across its final `loadCompacted()`
    // → atomic `rename`. Previously a touch only POLLED (`waitForRebuildLockClear`)
    // for the lock before reading/appending WITHOUT holding it — a check-then-act
    // gap: a touch could see no lock, a rebuild could then acquire the lock + run
    // its final `loadCompacted()`, and the touch's later append would be clobbered
    // by the rebuild's `rename()`. We now make the touch HOLD the SAME advisory
    // lock for the WHOLE read → merge → append window. While the touch holds the
    // lock, a rebuild in another process blocks on it (and vice-versa), so no
    // append can land between a rebuild's final load and its rename. `queueCritical`
    // serializes this within ONE process (so the OS lock is never self-contended in
    // process); the file lock adds the missing CROSS-process exclusion. If the touch
    // cannot ACQUIRE the lock within the bounded wait (another process's rebuild is
    // mid-flight), it DROPS the append: the catalog is rebuildable best-effort
    // metadata, so skipping one touch is acceptable; it NEVER blocks forever, NEVER
    // appends without the lock, and NEVER crashes the primary memory op.
    return this.queueCritical(async () =>
      this.withHeldCatalogLock(async (acquired) => {
        // Could not hold the lock (a cross-process rebuild is in its load→rename
        // window). DROP rather than append into that window (the lost-append race
        // this lock exists to prevent). Returning false also lets the router's
        // resolve-hook dedup retry a dropped registration later.
        if (!acquired) return false;

        // Test-only seam: widen the held-lock window so a concurrency test can
        // attempt a cross-process rebuild here and assert it is BLOCKED by this
        // held lock (no-op in production).
        if (this.onTouchCriticalSectionForTest) {
          await this.onTouchCriticalSectionForTest();
        }

        const records = await this.loadCompacted();
        const existing = records.get(ns);

        // Containment-check any explicit storageDir before persisting it (round 4
        // + round 5, codex P2). Never trust a caller-provided path verbatim;
        // reject lexical escapes AND symlinks that escape via realpath.
        const storageDir = await this.resolveTouchStorageDir(
          ns,
          metadata?.storageDir,
          existing?.storageDir,
        );
        // Provenance (discoveredBy) and createdAt are CREATION-ONLY fields. Once a
        // record exists they are preserved, so a routine routing/recall touch (or
        // the router's `config` register hook firing on a cache hit) can never
        // clobber the original discovery source — e.g. a `write`-discovered record
        // is not reset to `config` by a later resolve. Touch fields (lastReadAt /
        // lastWriteAt / lastMaintenanceAt) still update on every touch below.
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

        // Update mutable fields. storageDir, kind, and the principal/project hints
        // may legitimately change over a namespace's lifetime, so they upsert.
        record.storageDir = storageDir;
        if (metadata?.kind) record.kind = metadata.kind;
        if (metadata?.principal !== undefined) record.principal = metadata.principal;
        if (metadata?.projectId !== undefined) record.projectId = metadata.projectId;
        if (metadata?.branch !== undefined) record.branch = metadata.branch;
        if (metadata?.parentNamespace !== undefined)
          record.parentNamespace = metadata.parentNamespace;
        // PROVENANCE (creation-only, with one upgrade — round 6, codex P2 NBPmT):
        // `discoveredBy` is otherwise preserved for existing records (a routine
        // read/register/resolve never relabels it). The single exception is a real
        // WRITE upgrading a record that was only PRE-REGISTERED by the router's
        // `onResolve` hook (`discoveredBy: "config"`) before any data was written.
        // Without this upgrade, `listNamespaces({ discoveredBy: "write" })` misses
        // namespaces that were genuinely written, because `storageFor()` fires
        // `registerResolved()` (config) before `recordCatalogWrite()` runs. We
        // upgrade ONLY config→write — never downgrade write/read, never relabel a
        // read-discovered record — so the authoritative "this namespace has been
        // written" signal is recorded.
        if (kind === "write" && existing && record.discoveredBy === "config") {
          record.discoveredBy = "write";
        }

        if (kind === "read") record.lastReadAt = nowIso;
        if (kind === "write") record.lastWriteAt = nowIso;
        if (kind === "maintenance" && jobName) {
          record.lastMaintenanceAt = { ...(record.lastMaintenanceAt ?? {}), [jobName]: nowIso };
        }

        await this.appendUnchained(record);
        return true;
      }),
    );
  }

  // ── Rebuild from disk ────────────────────────────────────────────────────

  async rebuildFromDisk(
    options?: { dryRun?: boolean },
  ): Promise<NamespaceCatalogRebuildResult> {
    const dryRun = options?.dryRun === true;
    if (!this.enabled) {
      return { dryRun, records: [], skipped: [], applied: false };
    }

    // CONCURRENCY (Issue A — round 2): the entire scan → merge → rewrite runs
    // inside ONE serialized critical section on the shared write chain. This
    // closes the round-1 residual risk where a hot-path markRead/markWrite/
    // registerResolved append could land AFTER the snapshot but BEFORE the
    // atomic rewrite and then be discarded by the rewrite. Because touches also
    // run through `queueCritical`, no append can interleave between the load
    // (which now reads the latest persisted state, including touches that
    // landed before this section started) and the rewrite. A `--dry-run` still
    // takes the section for a consistent read but performs no mutation.
    //
    // Deadlock note: the rewrite inside this section uses the unchained
    // `rewriteUnchained` helper (mirroring `appendUnchained`) rather than a
    // helper that re-enters `queueCritical` — re-entering the chain from inside
    // a held turn would await the very entry this section holds.
    //
    // CROSS-PROCESS (round 5, codex P2): `queueCritical` only serializes this
    // process's instance. A CLI `rebuild --apply` and the live gateway are
    // SEPARATE processes with independent write chains, so a gateway append can
    // still land between the CLI's load and its atomic rename. For the mutating
    // path we additionally take a cross-process file lock AND re-merge the latest
    // on-disk touches under that lock immediately before the rewrite (see
    // `rebuildInsideChain`). A dry-run never mutates, so it skips the lock.
    if (dryRun) {
      return this.queueCritical(async () => this.rebuildInsideChain(dryRun, false));
    }
    // A mutating rebuild HOLDS the same advisory lock that touches now hold (round
    // 7, codex P2 — NEZkA). Because the touch path acquires this lock across its
    // read→append window and the rebuild holds it across its final
    // `loadCompacted()` → `rename()`, the two are mutually exclusive cross-process:
    // no touch append can land between a rebuild's final load and its rename. The
    // disk scan itself can stay lockless (it does not mutate); only the final
    // read-merge-rename critical section requires the lock — `rebuildInsideChain`
    // does that whole section while we hold it.
    //
    // LOCK ORDERING (round 7 — NEZkA): the file lock is acquired INSIDE
    // `queueCritical`, identically to the touch path (`queueCritical` → file lock),
    // NOT around it. A consistent acquire order is what prevents an in-process
    // deadlock between a same-instance touch and rebuild: `queueCritical` fully
    // serializes the two turns in this process, so when one turn holds the file
    // lock the other is not even running — the OS lock is never self-contended
    // in-process and a same-instance touch never stalls/drops behind its own
    // rebuild. The file lock therefore adds ONLY the missing cross-process
    // exclusion.
    return this.queueCritical(async () =>
      // canMutate iff we actually hold the cross-process lock (round 6, codex P2
      // — NBPmY). If acquisition timed out, run compute-only: never perform the
      // load/rename window unlocked, or a second unlocked rename could clobber a
      // concurrent gateway touch and recreate the lost-append race.
      this.withHeldCatalogLock((acquired) => this.rebuildInsideChain(dryRun, acquired)),
    );
  }

  /**
   * Body of `rebuildFromDisk`, run inside a single `queueCritical` turn. MUST
   * only be invoked from within the serialized chain so the load and the
   * rewrite are atomic with respect to concurrent touches.
   */
  private async rebuildInsideChain(
    dryRun: boolean,
    canMutate: boolean,
  ): Promise<NamespaceCatalogRebuildResult> {
    // Read the LATEST persisted state inside the chain so any touch that landed
    // before this turn is folded in (and re-merged into the rewrite below).
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

    // 1) Configured namespaces always belong in the catalog.
    const configured = new Set<string>([
      this.config.defaultNamespace,
      this.config.sharedNamespace,
      ...this.config.namespacePolicies.map((p) => p.name),
    ]);

    // 2) Default-root alignment (Issue C — round 2): the catalog's default
    //    record MUST point at the SAME root the runtime router resolves, or
    //    maintenance/QMD consumers would read a different default root than
    //    live reads. We delegate to the shared `resolveDefaultNamespaceRoot`
    //    (the very helper the router uses) instead of reimplementing divergent
    //    "prefer tokenized dir if it has data" logic — while legacy data lives
    //    directly under memoryDir, this returns memoryDir, matching runtime.
    const resolvedDefaultRoot = await resolveDefaultNamespaceRoot(this.config);
    // CONTAINMENT (round 6, codex P2 — NEOFS): `resolveDefaultNamespaceRoot()` can
    // return a `namespaces/<default-token>` symlink escaping memoryDir when the
    // legacy default root is empty. The default record must never carry an
    // escaping `storageDir`; fall back to the trusted `memoryDir` root when the
    // resolved one fails containment. Computed ONCE so every later use (the
    // configured-seeding step and the scan's default-dir re-apply) stays safe.
    const defaultStorageDir = (await this.isContainedStorageDir(resolvedDefaultRoot))
      ? resolvedDefaultRoot
      : this.memoryDir;
    const legacyDefaultHasData = defaultStorageDir === this.memoryDir;

    for (const ns of configured) {
      if (!ns) continue;
      // SAFETY (round 6, codex P2 — NBPmO): `parseConfig` intentionally preserves
      // unsafe namespace strings (e.g. a `sharedNamespace`/`namespacePolicies[]`
      // name like `../evil`) so sinks reject them. The hot touch/scan paths
      // already reject via `isSafeRouteNamespace`; rebuild must NOT be the path
      // that admits an unsafe configured namespace into the catalog. The default
      // namespace is exempt (it may be a non-route literal), matching the scan
      // loop's exemption below.
      if (ns !== this.config.defaultNamespace && !isSafeRouteNamespace(ns)) {
        let token: string;
        try {
          token = namespaceIdentityToken(ns);
        } catch {
          token = ns;
        }
        skipped.push({ token, reason: "unsafe", detail: ns });
        continue;
      }
      // ROUTER ALIGNMENT (round 6, codex P2 — NDxiS): seed a configured
      // non-default namespace with the SAME root the runtime router resolves, not
      // a blanket tokenized dir. `resolveNamespaceStorageRoot` returns the legacy
      // RAW root when it exists and only prefers the tokenized root when that has
      // storage markers — so a configured namespace with an empty legacy raw root
      // (e.g. `namespaces/shared`) is catalogued at the runtime path, keeping
      // maintenance/QMD aligned with live reads. Falls back to the lexical token
      // dir if router resolution fails.
      let storageDir: string;
      if (ns === this.config.defaultNamespace) {
        storageDir = defaultStorageDir;
      } else {
        try {
          storageDir = await resolveNamespaceStorageRoot(this.config, ns);
        } catch {
          storageDir = this.namespaceTokenDir(namespaceIdentityToken(ns));
        }
      }
      // CONTAINMENT (round 6, codex P2 — NCzT4/NEOFS): verify the seeded path does
      // not ESCAPE memoryDir before recording it. The scan below rejects
      // escaping/symlinked roots, but this seeding runs FIRST, so without this
      // check rebuild would persist an escaping `storageDir`. `isContainedStorageDir`
      // enforces the full lexical + symlink + realpath contract and allows a
      // not-yet-created path (a brand-new configured namespace seeds its canonical
      // root). The DEFAULT namespace is also checked (NEOFS): if
      // `resolveDefaultNamespaceRoot()` returns a `namespaces/<default-token>`
      // symlink escaping memoryDir, we must NOT persist it. The default cannot be
      // "skipped" (it must always exist), so it falls back to the trusted
      // `memoryDir` root; a non-default namespace is skipped (escape).
      if (!(await this.isContainedStorageDir(storageDir))) {
        if (ns === this.config.defaultNamespace) {
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

    // 3) Scan the namespaces/ directory for tokenized roots.
    const namespacesDir = path.join(this.memoryDir, "namespaces");
    let entries: Dirent[] = [];
    // CONTAINMENT (round 8, codex P2 — NE9K_): check the `namespaces` ROOT itself
    // BEFORE `readdir` follows it. If `<memoryDir>/namespaces` is a symlink (or its
    // realpath escapes memoryDir), `readdir()` would enumerate an arbitrary outside
    // tree — leaking names or spending time on a huge directory — even though the
    // catalog rejects symlinked/escaping per-entry roots. The per-entry lstat/realpath
    // checks below run AFTER the readdir, so they cannot prevent following an
    // escaping ROOT. We lstat the root: if it is a symlink, OR its realpath escapes
    // memoryDir, we DO NOT read it and report it as a single unsafe scan root.
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
      // The `namespaces` dir does not exist yet (or lstat failed): nothing to scan,
      // and there is no symlink to follow. Treat as an empty, safe scan.
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

    // Dual-root alignment (round 5, cursor Medium): when both a legacy raw-name
    // dir and a tokenized dir hold data for the SAME namespace, the router
    // prefers the tokenized root. Track which scanned namespaces were already
    // sourced from their tokenized dir so a later legacy-named `readdir` entry
    // cannot overwrite the tokenized record (and vice-versa: a tokenized entry
    // always wins over a previously-set legacy one).
    const scannedFromTokenized = new Set<string>();

    for (const entry of entries) {
      const token = entry.name;
      const fullPath = path.join(namespacesDir, token);
      // Reject symlinks / escaping roots rather than trusting them.
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
      // Containment: realpath must stay inside the memory root.
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

      // Decode the namespace from the dir name. A configured dir name is used
      // verbatim. Otherwise decode a genuine tokenized dir back to its identity,
      // falling back to the raw dir name when it is not a decodable token.
      //
      // NDATN note (round 6, codex P2): a raw dir literally named like a CANONICAL
      // token (e.g. `namespaces/ns-616c706861`, the canonical token of `alpha`) is
      // inherently ambiguous from disk alone — the bytes are identical whether the
      // namespace is `alpha` (in its tokenized dir) or the literal `ns-616c706861`
      // (in a raw dir). Decoding a canonical token is the correct default. The
      // unambiguous fix lives on the WRITE path, where the caller knows the true
      // namespace and records it verbatim (NCQI0); the scanner cannot recover a
      // name the encoding cannot distinguish, so we keep the canonical decode.
      const decoded = configured.has(token) ? token : namespaceIdentityFromToken(token) ?? token;
      if (decoded !== this.config.defaultNamespace && !isSafeRouteNamespace(decoded)) {
        skipped.push({ token, reason: "unsafe", detail: decoded });
        continue;
      }
      // Only catalog roots that actually hold memory data (skip empty shells).
      if (!(await hasMemoryData(fullPath))) continue;

      // Default-root alignment (Issue C): never let a tokenized default dir
      // overwrite the configured default's storageDir with `fullPath`. The
      // default record's root is owned by `resolveDefaultNamespaceRoot` above,
      // which mirrors the router. We still keep the default record (set in
      // step 1) but skip clobbering its root here.
      if (decoded === this.config.defaultNamespace) {
        const def = rebuilt.get(this.config.defaultNamespace);
        if (def) {
          def.storageDir = defaultStorageDir;
          def.kind = "default";
        }
        continue;
      }

      // Dual-root preference: mirror the router, which uses the tokenized root
      // over a legacy raw-name root when the tokenized one has data. `entry.name`
      // is the on-disk dir name; it is the tokenized dir iff it equals the
      // namespace's identity token. If we already recorded this namespace from
      // its tokenized dir, a later legacy-named entry must not clobber it.
      const isTokenizedEntry = token === namespaceIdentityToken(decoded);
      if (rebuilt.has(decoded) && scannedFromTokenized.has(decoded) && !isTokenizedEntry) {
        continue;
      }
      if (isTokenizedEntry) scannedFromTokenized.add(decoded);

      const prior = existing.get(decoded);
      rebuilt.set(
        decoded,
        this.mergeForRebuild(prior, {
          namespace: decoded,
          identityToken: namespaceIdentityToken(decoded),
          kind: inferKind(decoded, this.config),
          createdAt: prior?.createdAt ?? nowIso,
          storageDir: fullPath,
          // Configured-and-present namespaces keep config provenance; purely
          // discovered ones are scan.
          discoveredBy: configured.has(decoded) ? "config" : prior?.discoveredBy ?? "scan",
        }),
      );
    }

    // Mark legacy default root explicitly when applicable.
    if (legacyDefaultHasData && defaultStorageDir === this.memoryDir) {
      const def = rebuilt.get(this.config.defaultNamespace);
      if (def) def.kind = "default";
    }

    if (canMutate) {
      // CROSS-PROCESS re-merge (round 5, codex P2): under the rebuild lock,
      // re-read the on-disk log ONE more time and fold any touch fields that
      // landed AFTER our initial `loadCompacted()` (e.g. a gateway markWrite in
      // another process) into the rebuilt records — last-write-wins per touch
      // field. This recovers cross-process appends that completed during the
      // scan, which the in-process `queueCritical` alone cannot see. Only runs
      // when we hold the lock (round 6, codex P2 — NBPmY): an unlocked rebuild
      // must not re-merge then rename, or it races a concurrent lock holder.
      const latest = await this.loadCompacted();
      for (const [ns, fresh] of latest) {
        const current = rebuilt.get(ns);
        if (!current) {
          // AUTHORITATIVE PURGE (round 6, cursor Medium — NATqU): the disk scan
          // is the single source of truth for which namespaces EXIST. A namespace
          // absent from `rebuilt` was NOT discovered on disk (its root is
          // empty/deleted) and is NOT configured, so the rebuild is purging it.
          // We must NOT resurrect it from the log — not even when a CONCURRENT
          // best-effort `markRead`/`markWrite` touched it after our snapshot. A
          // touch on a dynamic namespace whose on-disk root was removed only
          // bumps a timestamp; re-inserting that row (with its stale `storageDir`)
          // would defeat the purge the rebuild is meant to perform. Losing a touch
          // timestamp for a deleted root is acceptable (the catalog is rebuildable
          // best-effort metadata); resurrecting a purged record is not. Drop it.
          continue;
        }
        // SURVIVING namespace (still present in the authoritative disk scan):
        // fold in any newer touch fields that landed cross-process after our
        // initial snapshot so a concurrent gateway markWrite is not lost.
        rebuilt.set(ns, mergeNewerTouchFields(current, fresh));
      }
    }

    const records = [...rebuilt.values()].sort((a, b) => {
      const byName = a.namespace.localeCompare(b.namespace);
      if (byName !== 0) return byName;
      return a.identityToken.localeCompare(b.identityToken);
    });

    // Only rewrite when we actually hold the cross-process lock (round 6, codex
    // P2 — NBPmY). A dry-run never mutates; an unlocked rebuild (acquisition
    // timed out) returns the computed records WITHOUT renaming over the log, so
    // it can never clobber a concurrent lock holder's window.
    if (canMutate) {
      // Test-only seam: the load→rename window where the old check-then-append
      // touch could be clobbered. A concurrency test attempts a cross-instance
      // touch here and asserts the held lock blocks it (no-op in production).
      if (this.onRebuildBeforeRenameForTest) {
        await this.onRebuildBeforeRenameForTest();
      }
      await this.rewriteUnchained(records);
    }

    // `applied` is true only when we actually rewrote the log: never for a
    // dry-run, and never for an `--apply` that ran compute-only because it could
    // not acquire the lock (canMutate=false). Surfaces the real mutation state so
    // the CLI does not report success on a skipped rewrite (NBn3n/NBsGG).
    return { dryRun, records, skipped, applied: canMutate };
  }

  // ── Cross-process catalog write lock (held mutex) ────────────────────────

  /**
   * Run `fn` while HOLDING the shared cross-process advisory lock (round 5, codex
   * P2; generalized round 7 — NEZkA). This is the SINGLE mutex shared by BOTH the
   * touch read→merge→append window AND the rebuild final load→merge→rename window,
   * so a touch and a rebuild in different processes are mutually exclusive over
   * their respective critical sections — closing the check-then-append gap where a
   * polled-only touch could append into a rebuild's load→rename window.
   *
   * Acquisition is atomic via `open(..., "wx")`. A lock older than
   * `REBUILD_LOCK_STALE_MS` is treated as a crashed holder and broken. After
   * `REBUILD_LOCK_MAX_WAIT_MS` of contention we proceed best-effort WITHOUT the
   * lock rather than block forever. The lock is always released in `finally`.
   *
   * IN-PROCESS SAFETY: every caller invokes this from inside (or wrapping) the
   * per-process `queueCritical` chain, which serializes all catalog mutations in
   * THIS process. So within one process only one logical holder attempts OS-lock
   * acquisition at a time — the file lock is never self-contended in-process, and
   * the lock is acquired and released within a single in-process turn. The file
   * lock adds only the missing CROSS-process exclusion.
   *
   * HEARTBEAT (round 5, cursor/codex Medium/P2): while WE hold the lock a timer
   * refreshes its mtime every `REBUILD_LOCK_HEARTBEAT_MS`, so a legitimately long
   * holder (> `REBUILD_LOCK_STALE_MS`) is not treated as a crashed holder and
   * unlinked by another process — which would let overlapping windows lose
   * appends. Heartbeat failures are swallowed; the timer is always cleared in
   * `finally`.
   *
   * ACQUISITION RESULT (round 6, codex P2 — NBPmY): `fn` receives whether WE
   * actually hold the lock. When acquisition TIMED OUT (another holder is active),
   * a MUTATING rebuild must NOT perform its load/rename window unlocked, and a
   * touch must NOT append unlocked — both would recreate the lost-append race. The
   * caller uses `acquired` to run compute-only (rebuild) or DROP the append
   * (touch) when unlocked.
   */
  private async withHeldCatalogLock<T>(fn: (acquired: boolean) => Promise<T>): Promise<T> {
    const acquired = await this.acquireRebuildLock();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (acquired) {
      heartbeat = setInterval(() => {
        const now = new Date();
        // Refresh mtime so age-based stale detection sees an active holder.
        utimes(this.rebuildLockPath, now, now).catch(() => undefined);
      }, REBUILD_LOCK_HEARTBEAT_MS);
      // Don't keep the event loop alive solely for the heartbeat.
      heartbeat.unref?.();
    }
    try {
      return await fn(acquired);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (acquired) {
        try {
          // Release ONLY the lock still owned by THIS instance (round 6, codex
          // P2 — NCzT6). If this rebuild paused long enough that another process
          // treated our lock as stale, unlinked it, and acquired a REPLACEMENT,
          // an unconditional unlink here would delete that other holder's active
          // lock — letting writers/another rebuild proceed during its load/rename
          // window and recreating the lost-append race. Verify ownership first.
          if (await this.rebuildLockHeldBySelf()) {
            await unlink(this.rebuildLockPath);
          }
        } catch {
          // Best-effort release; a stale lock will be broken on next rebuild.
        }
      }
    }
  }

  /** Try to acquire the rebuild lock; returns true if WE created it. */
  private async acquireRebuildLock(): Promise<boolean> {
    const deadline = Date.now() + REBUILD_LOCK_MAX_WAIT_MS;
    await mkdir(this.stateDir, { recursive: true });
    for (;;) {
      try {
        const handle = await open(this.rebuildLockPath, "wx");
        try {
          // Record PID, this instance's owner id, and a timestamp. The owner id
          // distinguishes same-process instances (NBsGP).
          await handle.writeFile(
            `${process.pid} ${this.lockOwnerId} ${new Date().toISOString()}\n`,
            "utf8",
          );
        } catch {
          // Ignore write failures — the exclusive create already gave us the lock.
        } finally {
          await handle.close();
        }
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
          // Unexpected FS error — proceed best-effort without the lock.
          return false;
        }
        // Lock exists: break it if stale, otherwise wait briefly.
        await this.breakStaleRebuildLock();
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, REBUILD_LOCK_POLL_MS));
      }
    }
  }

  /** Remove the lock file if its mtime is older than the stale threshold. */
  private async breakStaleRebuildLock(): Promise<void> {
    try {
      const info = await stat(this.rebuildLockPath);
      if (Date.now() - info.mtimeMs > REBUILD_LOCK_STALE_MS) {
        await unlink(this.rebuildLockPath).catch(() => undefined);
      }
    } catch {
      // Lock vanished (released by holder) or stat failed — nothing to do.
    }
  }

  /**
   * Whether the rebuild lock file was written by THIS instance (round 6, codex
   * P2 — NBsGP). Matches the per-instance owner id, NOT just `process.pid`: two
   * NamespaceCatalog instances in the same process share a PID, so a PID-only
   * check would wrongly treat instance A's lock as self-held by instance B and
   * let B's touch skip the wait and append into A's rebuild window. Falls back to
   * the legacy PID-only form for lock files written before owner ids existed.
   */
  private async rebuildLockHeldBySelf(): Promise<boolean> {
    try {
      const body = await readFile(this.rebuildLockPath, "utf8");
      const parts = body.trim().split(/\s+/);
      const pid = Number.parseInt(parts[0] ?? "", 10);
      const ownerId = parts[1];
      // New format: "<pid> <uuid> <iso>". A UUID at parts[1] uniquely identifies
      // the writing INSTANCE; only the same instance is self. The strict UUID
      // shape avoids mistaking a legacy "<pid> <iso>" timestamp (also hyphenated)
      // for an owner id.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (ownerId && UUID_RE.test(ownerId)) {
        return ownerId === this.lockOwnerId;
      }
      // Legacy format: "<pid> <iso>" (no owner id). Best-effort PID match.
      return Number.isFinite(pid) && pid === process.pid;
    } catch {
      return false;
    }
  }

  /**
   * Merge a prior record's preserved metadata (timestamps, principal hints)
   * onto a freshly-discovered record. Disk-derived fields (storageDir, kind)
   * take precedence from the new record.
   *
   * PROVENANCE (round 3, cursor Low): `discoveredBy` and `createdAt` are
   * CREATION-ONLY — identical to the touch path's invariant. A rebuild must NOT
   * reset a namespace first seen via a `write`/`read` touch back to `config`
   * just because it is also listed in policies. So when a prior record exists we
   * carry its `discoveredBy` forward; only brand-new records keep the fresh
   * (config/scan) provenance.
   */
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
    if (prior.principal !== undefined) merged.principal = prior.principal;
    if (prior.projectId !== undefined) merged.projectId = prior.projectId;
    if (prior.branch !== undefined) merged.branch = prior.branch;
    if (prior.parentNamespace !== undefined) merged.parentNamespace = prior.parentNamespace;
    return merged;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Load the JSONL log and fold it into current state (last-record-wins). */
  private async loadCompacted(): Promise<Map<string, NamespaceRecord>> {
    const records = new Map<string, NamespaceRecord>();
    let raw: string;
    try {
      raw = await readFile(this.catalogPath, "utf8");
    } catch {
      return records;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Skip corrupt lines (CLAUDE.md rule #18 robustness).
        continue;
      }
      const record = coerceRecord(parsed);
      if (!record) continue;
      // Field-level touch merge during compaction (round 6, codex P2 — ND6Cz).
      // Touches run on PER-PROCESS write chains, so two processes (a gateway write
      // racing a CLI/second-server read or maintenance touch) can each load the
      // same prior record and append a full snapshot. Plain last-record-wins
      // compaction would then discard the earlier snapshot's `lastReadAt` /
      // `lastWriteAt` / `lastMaintenanceAt`, erasing a real touch and skewing
      // `writtenSince`. We instead take the LATER record as the base (most recent
      // identity/disk-derived state) and fold in the MAX of each touch field from
      // both, so no cross-process touch recency is lost without locking the hot
      // touch path. A destructive overwrite of real memory is never at stake here
      // — only best-effort recency metadata.
      const prior = records.get(record.namespace);
      records.set(record.namespace, prior ? mergeNewerTouchFields(record, prior) : record);
    }
    return records;
  }

  /**
   * Serialize an arbitrary read-modify-write critical section through the single
   * write chain. Every catalog mutation (touch read+merge+append, full rewrite)
   * runs through this so they are mutually exclusive: a touch always reads the
   * latest persisted state before appending, and a rebuild rewrite cannot
   * interleave with a touch's append. The chain recovers from rejection
   * (CLAUDE.md rule #40) — one failed section never poisons subsequent ones —
   * while still surfacing the error to that section's awaited promise.
   */
  private queueCritical<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn);
    // Keep the chain alive after a rejection so later sections still run.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Append a single record to the JSONL log WITHOUT re-serializing through the
   * write chain. MUST only be called from inside a `queueCritical(...)` section
   * (which already holds the serialized turn); calling it directly would bypass
   * the read-before-append ordering that prevents lost-field races.
   */
  private async appendUnchained(record: NamespaceRecord): Promise<void> {
    const line = serializeRecord(record) + "\n";
    await mkdir(this.stateDir, { recursive: true });
    await appendFile(this.catalogPath, line, "utf8");
  }

  /**
   * Atomic temp-file + rename rewrite (CLAUDE.md rule #54: write temp, then
   * rename — never delete-before-write) WITHOUT re-entering the write chain.
   * MUST only be called from inside a `queueCritical(...)` turn (e.g. the
   * rebuild critical section, which already holds the serialized turn so its
   * load and rewrite are atomic against concurrent touches). Re-entering the
   * chain from within a held turn would deadlock.
   */
  private async rewriteUnchained(records: NamespaceRecord[]): Promise<void> {
    const body = records.map((r) => serializeRecord(r)).join("\n") + (records.length > 0 ? "\n" : "");
    await mkdir(this.stateDir, { recursive: true });
    const tmp = `${this.catalogPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.catalogPath);
  }
}

function isPathInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
