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
  if (resolveNamespaceCapabilities(config).namespaces !== true) return false;
  return (config as { namespaceCatalogEnabled?: boolean }).namespaceCatalogEnabled !== false;
}

// Marker children that MUST be a regular file rather than a directory. Everything
// else in MEMORY_DATA_CHILDREN is a category/data DIRECTORY that downstream
// indexers (`scanMemoryDir`) read — and which they reject when it is a symlink or
// a non-directory. `profile.md` is the sole file marker.
const FILE_MEMORY_DATA_CHILDREN = new Set<string>(["profile.md"]);

type MemoryDataMarkerStatus =
  | { state: "absent" }
  | { state: "valid" }
  | { state: "invalid"; detail: string };

type MemoryDataRootStatus = {
  hasData: boolean;
  invalidMarker?: string;
};

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Inspect `child` under `rootDir` as a memory-data marker (NIw0F / PR #1506).
 * Existence alone is not enough: a bogus marker — e.g. `facts` as a symlink or a
 * regular file instead of a real directory — passes `lstat` but makes
 * `scanMemoryDir` throw on the symlinked/non-directory category root. Returning
 * a distinct `invalid` status lets root scans reject a namespace when ANY known
 * marker is malformed, even if a sibling marker such as `state/` is valid.
 */
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
  // Reject symlinked markers outright (scan parity — never follow them).
  if (entry.isSymbolicLink()) return { state: "invalid", detail: `${child}: symlink` };
  if (FILE_MEMORY_DATA_CHILDREN.has(child)) {
    // `profile.md` must be a regular file.
    return entry.isFile()
      ? { state: "valid" }
      : { state: "invalid", detail: `${child}: expected file` };
  }
  // Category/data markers must be real directories whose realpath stays inside
  // the namespace root (no escape via a symlinked ancestor).
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

/**
 * Validate a JSONL line parsed value as a usable NamespaceRecord.
 * Rejects null / non-object / missing-field records (CLAUDE.md rule #18).
 * Persisted enum and timestamp fields are also validated here so a syntactically
 * valid but tampered/pre-fix line cannot surface impossible record states.
 */
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
  // Compare against NORMALIZED config names (NGnek, codex P2): the catalog seeds
  // normalized namespace identities, so a configured name with surrounding
  // whitespace (e.g. `sharedNamespace: "shared "`) must still classify the
  // normalized `"shared"` as `shared`, not fall through to `explicit`.
  if (namespace === normalizeNamespaceIdentity(config.defaultNamespace)) return "default";
  if (namespace === normalizeNamespaceIdentity(config.sharedNamespace)) return "shared";
  if (config.namespacePolicies.some((p) => normalizeNamespaceIdentity(p.name) === namespace)) {
    return "explicit";
  }
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

interface CatalogFileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface CompactedCatalogCache {
  identity: CatalogFileIdentity;
  records: Map<string, NamespaceRecord>;
}

export class NamespaceCatalog {
  private readonly memoryDir: string;
  private readonly stateDir: string;
  private readonly catalogPath: string;
  private readonly rebuildLockPath: string;
  // In-process serialization for catalog mutations (issue #1524 adoption).
  // Replaces the bespoke `writeChain` field: every touch/rebuild runs through
  // this serializer so a single failed section never poisons subsequent ones
  // (CLAUDE.md rule #40 — recovery is the util's contract, not re-implemented
  // here). Cross-process identity (the lock file's owner-uuid) is now per-CALL
  // inside the shared util, which is STRONGER than the previous per-instance
  // `lockOwnerId` — two calls on the SAME instance get different ids, so
  // neither mistakes the other's lock for self-held (round 6, codex P2 — NBsGP
  // invariant preserved and tightened).
  private readonly criticalSection = new MutationSerializer();
  private compactedCache: CompactedCatalogCache | undefined;
  // Test-only seam (round 7 — NEZkA): fires inside a touch's HELD-lock critical
  // section, after the lock is acquired but BEFORE the read→merge→append. A
  // deterministic concurrency test installs a hook here to widen the (otherwise
  // microscopic) window and prove that a cross-process rebuild CANNOT run its
  // load→rename while a touch holds the lock. Never set in production code.
  protected onTouchCriticalSectionForTest?: () => Promise<void>;
  // Test-only observation seam: fires only when the JSONL file is fully read.
  // Cached loads do not invoke it.
  protected onCatalogReadForTest?: () => void;
  // Test-only seam: fires after this process appends but before it stats the
  // file to refresh the cache identity.
  protected onAfterCatalogAppendForTest?: () => Promise<void>;
  // Test-only seam (round 7 — NEZkA): fires inside a mutating rebuild's HELD-lock
  // critical section, after the final cross-process re-merge `loadCompacted()` and
  // BEFORE the atomic `rename()`. This is the EXACT window in which a check-then-
  // append touch (the old bug) would clobber its append. A deterministic test
  // installs a hook here to attempt a cross-instance touch in this window and
  // assert the held mutex blocks it. Never set in production code.
  protected onRebuildBeforeRenameForTest?: () => Promise<void>;
  // Test-only seam (NFgCT, codex P2): fires AFTER the lockless disk scan but
  // BEFORE the rebuild acquires the cross-process file lock for its final
  // load→merge→rename window. A deterministic test installs a hook here to attempt
  // a cross-instance touch DURING the scan window and assert it is NOT blocked or
  // dropped — proving the scan no longer holds the mutex. Never set in production.
  protected onRebuildAfterScanForTest?: () => Promise<void>;
  // Test-only seam (NG7Bg, codex P2): fires inside `breakStaleRebuildLock` AFTER it
  // has judged the lock stale and captured its identity, but BEFORE the final
  // re-validation+unlink. A deterministic test installs a hook here to REPLACE the
  // lock file (a fresh holder created a new lock in the race window) and assert the
  // break is skipped — the replacement's active lock is not deleted. Never set in
  // production.
  protected onBeforeBreakStaleUnlinkForTest?: () => Promise<void>;

  // Normalized (trimmed) default namespace identity (NH-FH, cursor Medium).
  // Catalog records key namespaces by their NORMALIZED identity
  // (`normalizeNamespaceIdentity`), but several default-namespace exemptions and
  // memoryDir-ownership checks compared against the RAW `config.defaultNamespace`.
  // If the configured default name carries surrounding whitespace the record key
  // is trimmed while the comparison string is not, so the default row is
  // misclassified, dropped at read time, or given the wrong storage root. Compare
  // against this normalized form everywhere instead.
  private readonly defaultNamespaceIdentity: string;

  // Issue #1903 — touch-path performance knobs, resolved with the documented
  // defaults when an externally-built PluginConfig omits them (so a partial
  // config object still yields the production behavior). `0` is a real disable
  // switch for each and is preserved by `??` (0 is not null/undefined).
  private readonly compactBytesLimit: number;
  private readonly readCoalesceMs: number;
  private readonly writeCoalesceMs: number;
  // Size after the most recent auto-compaction (0 = none yet). Hysteresis for
  // maybeAutoCompact: a folded catalog that is itself above the limit (many
  // distinct namespaces) would otherwise be re-folded + re-rewritten on every
  // touch. We only compact again once the log has grown by >= one limit-worth
  // since the last compaction (#1903, Codex).
  private lastCompactedSize = 0;

  // Issue #1903 — per-(namespace, kind) coalescing buffer. Keyed `${kind}:${ns}`.
  // Holds the latest buffered timestamp/metadata for a pure-timestamp touch on
  // an already-known record; a `.unref()`'d timer flushes it once per window so
  // the append-only log does not grow one line per repeat touch. Semantically
  // observable touches (first sight, provenance/field change) bypass this buffer
  // and flush immediately (see `coalesceTouch`).
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

  // ── Public enumeration API ──────────────────────────────────────────────

  /**
   * Sanitize a record at the enumeration boundary (round 5, cursor Medium + codex
   * P2; round 6 — NDXHe). Reads return whatever is in `namespaces.jsonl` after
   * schema checks only, so a tampered or pre-fix row could surface unsafe data to
   * maintenance/QMD until a rewrite occurs. Two distinct defenses:
   *
   *  1. UNSAFE NAMESPACE NAME (NGZqr, codex P2): an unsafe non-default namespace
   *     (e.g. `../evil`, a name with separators, or >64 chars) is REJECTED outright
   *     — return `null` so the caller drops it. The disk SCAN and the hot touch
   *     path both reject such names with the SAME default-exempt `isSafeRouteNamespace`
   *     gate, so the read boundary MUST agree, or `listNamespaces()`/`getNamespaceRecord()`
   *     would expose a namespace those paths reject (note `isStorageDirForNamespace`
   *     can still build a tokenized root even for `../evil`, so storageDir sanitation
   *     alone does not catch it). The default namespace is exempt (it may be a
   *     non-route literal), matching every other validation site.
   *
   *  2. UNSAFE storageDir: for an otherwise-valid namespace, apply the SAME contract
   *     as the write path — full containment (`isContainedStorageDir`: lexical +
   *     symlink/realpath) AND namespace ownership (`isStorageDirForNamespace`). When
   *     a record fails EITHER check we substitute the trusted resolved-and-safe root
   *     for that namespace (rule 42: read and write stay symmetric).
   */
  private async sanitizeRecordForRead(record: NamespaceRecord): Promise<NamespaceRecord | null> {
    // Defense 1: drop an unsafe non-default namespace name entirely. Compare
    // against the NORMALIZED default identity — record keys are trimmed, so a raw
    // whitespace-padded config default would never match the default row (NH-FH).
    if (record.namespace !== this.defaultNamespaceIdentity && !isSafeRouteNamespace(record.namespace)) {
      return null;
    }
    // Defense 2: keep the record but substitute a safe storageDir when needed.
    if (
      (await this.isContainedStorageDir(record.storageDir)) &&
      (await this.isStorageDirForNamespace(record.namespace, record.storageDir))
    ) {
      return record;
    }
    const safe = await this.resolveSafeStorageDir(record.namespace);
    return { ...record, storageDir: safe };
  }

  private storageRootOwnershipRank(
    record: NamespaceRecord,
    resolvedStorageDir: string,
    configured: Set<string>,
  ): number {
    if (resolvedStorageDir === path.resolve(this.memoryDir)) {
      return record.namespace === this.defaultNamespaceIdentity ? 0 : 3;
    }

    const leaf = path.basename(resolvedStorageDir);
    const tokenOwnsRoot = namespaceIdentityToken(record.namespace) === leaf;
    if (tokenOwnsRoot && configured.has(record.namespace)) {
      return 0;
    }
    if (record.namespace === leaf) return 1;
    if (tokenOwnsRoot) return 2;
    return 3;
  }

  private configuredNamespaceIdentities(): Set<string> {
    return new Set(
      [
        this.config.defaultNamespace,
        this.config.sharedNamespace,
        ...this.config.namespacePolicies.map((p) => p.name),
      ]
        .map((n) => normalizeNamespaceIdentity(n))
        .filter((n) => n.length > 0),
    );
  }

  private preferStorageRootOwner(
    current: NamespaceRecord,
    candidate: NamespaceRecord,
    resolvedStorageDir: string,
    configured: Set<string>,
  ): NamespaceRecord {
    const currentRank = this.storageRootOwnershipRank(current, resolvedStorageDir, configured);
    const candidateRank = this.storageRootOwnershipRank(candidate, resolvedStorageDir, configured);
    if (candidateRank < currentRank) return candidate;
    if (candidateRank > currentRank) return current;

    const byName = candidate.namespace.localeCompare(current.namespace);
    if (byName < 0) return candidate;
    if (byName > 0) return current;
    return candidate.identityToken.localeCompare(current.identityToken) < 0 ? candidate : current;
  }

  private dropDuplicateStorageRootAliases(records: NamespaceRecord[]): NamespaceRecord[] {
    const byStorageDir = new Map<string, NamespaceRecord>();
    const configured = this.configuredNamespaceIdentities();
    for (const record of records) {
      const resolvedStorageDir = path.resolve(record.storageDir);
      const current = byStorageDir.get(resolvedStorageDir);
      if (!current) {
        byStorageDir.set(resolvedStorageDir, record);
        continue;
      }
      const owner = this.preferStorageRootOwner(current, record, resolvedStorageDir, configured);
      const alias = owner === current ? record : current;
      byStorageDir.set(resolvedStorageDir, mergeNewerTouchFields(owner, alias));
    }
    return [...byStorageDir.values()];
  }
  private loadSanitizedRecords(): Promise<NamespaceRecord[]> {
    return this.queueCritical(async () => {
      const records = await this.loadCompacted();
      const sanitized = await Promise.all(
        [...records.values()].map((r) => this.sanitizeRecordForRead(r)),
      );
      // Drop unsafe-namespace rows (sanitizer returned null) at the read boundary.
      // Then collapse duplicate root aliases so maintenance/QMD see exactly one
      // namespace owner for a physical storage root, matching rebuild ownership,
      // while preserving touch recency from every alias row.
      return this.dropDuplicateStorageRootAliases(
        sanitized.filter((r): r is NamespaceRecord => r !== null),
      );
    });
  }

  async listNamespaces(filter?: NamespaceCatalogFilter): Promise<NamespaceRecord[]> {
    if (!this.enabled) return [];
    let out = await this.loadSanitizedRecords();
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
    return (await this.loadSanitizedRecords()).find((record) => record.namespace === ns) ?? null;
  }

  // ── Touch API (cheap, failure-tolerant) ─────────────────────────────────

  async markRead(namespace: string, metadata?: NamespaceTouchMetadata): Promise<void> {
    await this.coalesceTouch(namespace, "read", metadata);
  }

  async markWrite(namespace: string, metadata?: NamespaceTouchMetadata): Promise<void> {
    await this.coalesceTouch(namespace, "write", metadata);
  }

  /**
   * Route a read/write touch through the per-(namespace, kind) coalescing buffer
   * (issue #1903). A touch flushes IMMEDIATELY (bypassing the buffer) whenever it
   * is semantically observable to an in-process reader — first sight of the
   * namespace, a `config`→`write` provenance upgrade, the first time a touch
   * field is set (so `listNamespaces({ writtenSince })` and record presence stay
   * correct), or a change to `kind`/`principal`/`projectId`/`branch`/
   * `parentNamespace`. A pure timestamp refresh on an already-known record is
   * DEFERRED and coalesced: the newest buffered `at`/metadata wins and a single
   * `touch` runs when the window elapses (or on `flushPendingTouches`). Window
   * `0` skips the buffer entirely (the pre-#1903 immediate-append behavior).
   * Best-effort: coalescing decisions read only the warm `compactedCache`, never
   * forcing a disk parse; a cold cache flushes immediately (and re-warms it).
   */
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
    // Validate up front so an unsafe namespace rejects deterministically, exactly
    // as the immediate-append path does (touch validates too).
    const ns = this.validateNamespace(namespace);
    const cached = this.compactedCache?.records.get(ns);
    if (cached === undefined || this.touchMustFlushImmediately(kind, metadata, cached)) {
      // Semantically observable in-process → flush now (also warms the cache).
      // Any older buffered touch for this key is now redundant (this newer touch
      // updates the same field with a newer timestamp): drop it so its stale
      // timer cannot regress the timestamp after this flush.
      const stale = this.pendingTouches.get(`${kind}:${ns}`);
      if (stale) {
        clearTimeout(stale.timer);
        this.pendingTouches.delete(`${kind}:${ns}`);
      }
      await this.touch(namespace, kind, metadata);
      return;
    }
    // Pure timestamp refresh on a known record → coalesce within a FIXED window.
    const key = `${kind}:${ns}`;
    const at = metadata?.at ?? new Date();
    const existing = this.pendingTouches.get(key);
    if (existing) {
      // Keep the ORIGINAL timer and only refresh the buffered payload (#1903,
      // Codex). Re-arming on every touch would make this a debounce that never
      // flushes under continuous traffic (e.g. a sustained import), leaving
      // lastWriteAt stale and writtenSince/maintenance consumers blind to an
      // actively-written namespace. With a fixed window, each window flushes on
      // schedule carrying the newest buffered timestamp.
      existing.metadata = metadata;
      existing.at = at;
      return;
    }
    // Cap at Node's maximum setTimeout delay (2^31-1 ms ≈ 24.8 days). Values
    // above that are clamped by Node to 1ms, which would append almost every
    // touch and recreate the churn this coalescing exists to prevent (#1903, Codex).
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
    // A write upgrading a config pre-registration to "write" changes the
    // discoveredBy filter result — must be observable at once (~:1261).
    if (kind === "write" && cached.discoveredBy === "config") return true;
    // The first time a touch field is set makes the namespace newly match
    // presence/`writtenSince` reads, so it must not be deferred.
    if (kind === "write" && cached.lastWriteAt === undefined) return true;
    if (kind === "read" && cached.lastReadAt === undefined) return true;
    if (!metadata) return false;
    if (metadata.kind !== undefined && metadata.kind !== cached.kind) return true;
    // A changed storageDir repoints routing/containment for this namespace —
    // must be observable at once, not held stale by the coalesce window (#1903, Cursor).
    if (metadata.storageDir !== undefined && metadata.storageDir !== cached.storageDir) return true;
    return false;
  }

  /** Fire a single buffered touch when its coalescing window elapses. */
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
      // Skip unsafe configured names (e.g. a `sharedNamespace`/policy name like
      // `../evil`) consistently with `rebuildFromDisk` (round 6, cursor Low —
      // NBn3w). `register`→`validateNamespace` THROWS on unsafe tokens; without
      // this guard one bad name would abort registration of all the rest. The
      // default namespace is exempt (it may be a non-route literal). Each call is
      // also wrapped so a single failure never blocks the remaining names.
      // `names` carries RAW config values, so normalize before the default-exempt
      // check — a whitespace-padded default must still be recognized (NH-FH).
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
    // The configured default namespace is exempt from isSafeRouteNamespace at
    // the routing layer; honor the same exemption here, but everything still
    // resolves through the contained storage-dir helper below.
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
    // Reject a candidate beneath any SYMLINKED ancestor (codex NVuq5): even when
    // the symlink currently resolves back inside memoryDir, the disk scanner
    // rejects such a root, and a later retarget of the link would let
    // maintenance/QMD follow the persisted path outside memoryDir. Mirror the
    // scanner so touch/config seeding cannot persist a root under a symlinked
    // namespace ancestor (the leaf itself is symlink-checked below).
    if (await this.hasSymlinkedAncestor(candidate)) return false;
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) return false;
      // Reject an EXISTING non-directory root (NF21i, codex P2; CLAUDE.md rule
      // #24). A regular file (or socket/fifo) at `<memoryDir>/namespaces/<token>`
      // is lexically contained and its realpath stays inside memoryDir, so the
      // realpath check below would ACCEPT it — but a storage root must be a
      // directory. Recording a file as a namespace root yields a broken install
      // that only fails later when maintenance/QMD/mkdir treat it as a dir. The
      // disk scan already skips non-directory entries; mirror that here so every
      // containment consumer (resolve/touch/fallback/live-recheck) agrees.
      if (!stat.isDirectory()) return false;
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
   * Reject a candidate whose path crosses a SYMLINKED ancestor strictly between
   * memoryDir and the leaf (codex NVuq5). `realpath`-based containment accepts a
   * symlinked `<memoryDir>/namespaces` that currently resolves back inside
   * memoryDir, but the disk scanner rejects such a root and a later retarget would
   * escape the memory tree — so refuse it here too. The leaf itself is
   * symlink-checked by the caller; this walks only the intermediate ancestors.
   */
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

  /**
   * Walk up from a not-yet-existing candidate to the nearest ancestor that exists
   * on disk and verify its realpath stays inside `memoryReal` (round 6, codex P2
   * — NDo79). Rejects a non-existent leaf whose existing parent chain escapes
   * memoryDir via a symlink. Stops at memoryDir's resolved root.
   *
   * The nearest existing ancestor must also be a DIRECTORY (NHIdt, codex P2): if
   * an existing parent such as `<memoryDir>/namespaces` is a regular FILE (or
   * socket/fifo), `realpath(parent)` still succeeds and resolves inside memoryDir,
   * so a containment-only check would ACCEPT a leaf that can never be created — you
   * cannot mkdir a child under a file. We `lstat` the nearest existing ancestor and
   * reject when it is not a directory, mirroring the leaf non-directory rejection
   * (NF21i) and the disk scan, so every containment consumer agrees.
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
      let real: string;
      try {
        real = await realpath(parent);
      } catch {
        // Parent does not exist yet either — keep walking up.
        dir = parent;
        continue;
      }
      // The nearest EXISTING ancestor must resolve inside the memory root...
      if (!(isPathInside(memoryReal, real) || real === memoryReal)) return false;
      // ...AND be a directory: a non-directory ancestor (e.g. a file occupying
      // `namespaces`) cannot hold the not-yet-created leaf (NHIdt).
      try {
        const stat = await lstat(real);
        return stat.isDirectory();
      } catch {
        // The ancestor vanished between realpath and lstat — treat as not usable.
        return false;
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
   *     tree (which would misdirect maintenance fanout). Returned only when the
   *     token dir itself stays CONTAINED (it is not a symlink, and its realpath
   *     does not escape memoryDir — e.g. via a symlinked `namespaces/` parent).
   *  2. `memoryDir` as a LAST resort — for the default namespace, an unsafe token
   *     that cannot build a contained path, OR the irreparable case where the
   *     token dir's realpath escapes the root (so even its lexical path resolves
   *     outside). NF21m note (codex P2): we deliberately do NOT record the lexical
   *     token dir in that irreparable case — its realpath escapes memoryDir, and
   *     the NDo79 contract REQUIRES that an escaping path is never persisted (a
   *     later mkdir/maintenance/QMD op would follow it outside the root). Since no
   *     contained namespace-specific path exists, containment wins: `memoryDir` is
   *     the only safe root left. A namespace whose token dir's realpath escapes is
   *     an irreparable on-disk state; recording the contained default root is
   *     strictly safer than persisting an escaping one. The common case where the
   *     token dir IS contained is handled by branch 1, so a healthy non-default
   *     namespace never reaches `memoryDir`.
   */
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

  /**
   * Re-check, NOW, whether a namespace's storage root currently EXISTS on disk
   * with the SAME safety the directory scan uses (NFJV8, codex P2).
   *
   * The rebuild's final re-merge runs under the held lock and folds the freshly
   * re-read log (`latest`) into the scanned `rebuilt` set. A namespace present in
   * `latest` (a live touch row) but ABSENT from `rebuilt` is normally PURGED as
   * deleted (the NATqU "disk scan is authoritative" rule). But there is a TOCTOU
   * window: a dynamic namespace can be CREATED on disk AFTER `rebuildFromDisk()`
   * already enumerated `namespaces/` but BEFORE this re-merge. The scan snapshot
   * missed its new root, yet a gateway `markWrite` already appended a row for it.
   * Blindly purging that row would rewrite the catalog WITHOUT a live namespace
   * that now has data on disk, so `writtenSince`/maintenance/QMD consumers miss
   * it until another touch or rebuild.
   *
   * So before purging, we re-resolve the namespace's safe storage root (the same
   * router-aligned, containment-checked path the scan would have catalogued) and
   * confirm it is a real, contained, non-symlink directory that actually holds
   * memory data RIGHT NOW. If so the namespace was created-after-scan and is LIVE
   * — KEEP its row. This is the precise inverse of NATqU and does NOT reintroduce
   * it: a touch on a REMOVED root re-checks as ABSENT (no data on disk) and is
   * still purged; only a root that EXISTS on a fresh re-check is kept.
   *
   * Mirrors the per-entry scan checks (symlink rejection + realpath containment +
   * `hasMemoryData`) so a symlinked/escaping root is never resurrected.
   */
  private async liveStorageRootExistsForRebuild(
    namespace: string,
    memoryReal: string | null,
  ): Promise<boolean> {
    let root: string;
    try {
      // Use the SAME router-aligned, containment-enforcing resolver the catalog
      // uses everywhere else. It never returns an escaping path (falls back to a
      // namespace-specific contained root on containment failure).
      root = await this.resolveSafeStorageDir(namespace);
    } catch {
      return false;
    }
    // NH3Xy (codex P2): for a NON-default namespace, a generic fallback root is
    // NOT proof of liveness. When the namespace's own token root was skipped by
    // the scan as a symlink/escape, `resolveSafeStorageDir` can fall back to the
    // DEFAULT namespace's `memoryDir`; `hasMemoryData()` on that shared default
    // tree then returns true whenever the default namespace has any data, which
    // would wrongly KEEP a stale project row now pointing at the default tree
    // instead of purging the skipped namespace. Only the namespace's OWN root may
    // attest its liveness — so if a non-default namespace resolved to `memoryDir`,
    // it has no independent contained root and must be treated as absent (purge).
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
      // Root does not exist on disk → genuinely absent → allow the purge.
      return false;
    }
    // Reject a symlinked root rather than resurrecting it (scan parity).
    if (stat.isSymbolicLink()) return false;
    if (!stat.isDirectory()) return false;
    // Realpath must stay inside the memory root (scan parity).
    try {
      const real = await realpath(root);
      if (memoryReal && !isPathInside(memoryReal, real)) return false;
    } catch {
      return false;
    }
    // Only treat the root as a live namespace when it actually holds memory data,
    // exactly as the scan does (empty shells are not catalogued).
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

        // Update mutable fields. storageDir and kind may change over a
        // namespace's lifetime, so they upsert.
        record.storageDir = storageDir;
        if (metadata?.kind) record.kind = metadata.kind;
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
        // Size-triggered auto-compaction (issue #1903), still inside the held
        // cross-process lock + queueCritical turn so the fold→rename is atomic
        // against concurrent touches and cross-process rebuilds.
        await this.maybeAutoCompact();
        return true;
      }),
    );
  }

  /**
   * Fold-and-rewrite the JSONL log when it exceeds `compactBytesLimit`
   * (issue #1903). MUST be called only from inside `touch`'s held-lock +
   * `queueCritical` critical section — it reuses `loadCompacted` (last-record-
   * wins fold; every namespace row survives) and `rewriteUnchained` (atomic
   * temp-file + rename), so the collapse is cross-process safe and never
   * invokes the disk-scan purge in `finishRebuild`. Best-effort and fail-open
   * (rule #40): the append already succeeded and is durable, so a failed
   * compaction must not fail the touch — the next over-limit touch retries.
   */
  private async maybeAutoCompact(): Promise<void> {
    try {
      const limit = this.compactBytesLimit; // 0 => auto-compaction disabled
      if (limit <= 0) return;
      // Exact post-append size when the cache is warm; skip this touch's check
      // when the cache is cold (a cross-process append invalidated it) — the
      // next touch re-warms and re-checks.
      const size = this.compactedCache?.identity.size;
      if (size === undefined || size <= limit) return;
      // Hysteresis (issue #1903, Codex): a folded catalog whose deduped state is
      // itself above the limit (many distinct namespaces) would otherwise be
      // re-folded + re-rewritten on EVERY touch — O(catalog) per touch. Only
      // compact again once the log has grown by >= one limit-worth since the last
      // compaction; by then the new appends are duplicates the fold can collapse.
      if (this.lastCompactedSize > 0 && size - this.lastCompactedSize < limit) return;
      const folded = await this.loadCompacted();
      await this.rewriteUnchained([...folded.values()]);
      this.lastCompactedSize = this.compactedCache?.identity.size ?? size;
    } catch {
      // Fail-open: compaction is best-effort maintenance on already-durable data.
    }
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
    // no touch append can land between a rebuild's final load and its rename.
    //
    // SCOPED MUTEX (NFgCT, codex P2): the lock is acquired ONLY around the final
    // load→merge→rename window, NOT the (potentially long) disk scan. The scan does
    // not mutate, so holding the lock across it merely forces concurrent gateway
    // touches to wait — and they DROP their append after `REBUILD_LOCK_MAX_WAIT_MS`,
    // losing real `lastWriteAt`/new-namespace data the rewrite then misses. Keeping
    // the scan lockless shrinks the window in which a touch must contend with the
    // rebuild to just the final critical section, which is brief. `rebuildInsideChain`
    // acquires `withHeldCatalogLock` itself, immediately before its re-merge+rewrite.
    //
    // LOCK ORDERING (round 7 — NEZkA): the file lock is acquired INSIDE
    // `queueCritical`, identically to the touch path (`queueCritical` → file lock),
    // NOT around it. A consistent acquire order is what prevents an in-process
    // deadlock between a same-instance touch and rebuild: `queueCritical` fully
    // serializes the two turns in this process, so when one turn holds the file
    // lock the other is not even running — the OS lock is never self-contended
    // in-process and a same-instance touch never stalls/drops behind its own
    // rebuild. The file lock therefore adds ONLY the missing cross-process
    // exclusion. `rebuildInsideChain` still runs entirely inside `queueCritical`;
    // it just narrows the cross-process file lock to the final rewrite window.
    return this.queueCritical(async () => this.rebuildInsideChain(dryRun, true));
  }

  /**
   * Body of `rebuildFromDisk`, run inside a single `queueCritical` turn. MUST
   * only be invoked from within the serialized chain so the load and the
   * rewrite are atomic with respect to concurrent touches (in-process).
   *
   * `wantMutate` is true for an `--apply` (the caller intends to rewrite). The
   * cross-process file lock is acquired LATE — only around the final
   * load→merge→rename window (NFgCT, codex P2) — never across the disk scan, so a
   * long scan does not force concurrent gateway touches to wait (and drop their
   * append). Whether the rewrite actually happened is reported via the result's
   * `applied`: true only when `wantMutate` AND the lock was acquired.
   */
  private async rebuildInsideChain(
    dryRun: boolean,
    wantMutate: boolean,
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
    //
    // NORMALIZE FIRST (NGnek, codex P2): the live router normalizes every namespace
    // via `normalizeNamespaceIdentity` (a trim) in `storageFor()` before resolving
    // storage, and `isSafeRouteNamespace` also trims before validating. So a
    // configured name with harmless surrounding whitespace (e.g.
    // `sharedNamespace: "shared "` or a policy name copied with a trailing space)
    // would otherwise seed a catalog row for the RAW string and resolve a
    // `namespaces/shared ` root the live reads/writes never use — pointing
    // maintenance/QMD at the wrong directory after `rebuild --apply`. We normalize
    // configured names here so the catalog seeds the SAME identity the router uses
    // (rule #42: read/write resolve through the same normalization). The default
    // namespace is normalized too and compared via its normalized form (`defaultNs`)
    // wherever a configured/scanned name is matched against it below.
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
      // ROUTER ALIGNMENT (round 6, codex P2 — NDxiS): seed a configured
      // non-default namespace with the SAME root the runtime router resolves, not
      // a blanket tokenized dir. `resolveNamespaceStorageRoot` returns the legacy
      // RAW root when it exists and only prefers the tokenized root when that has
      // storage markers — so a configured namespace with an empty legacy raw root
      // (e.g. `namespaces/shared`) is catalogued at the runtime path, keeping
      // maintenance/QMD aligned with live reads. Falls back to the lexical token
      // dir if router resolution fails.
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
    const scannedFromTokenized = new Map<string, number>();
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
      //
      // NRcCD (round 9, codex P2 — same class as namespaceFromStorageDir/NRCve):
      // the canonical decode is WRONG when a namespace LITERALLY named like the
      // token already OWNS this root. A dynamic namespace served from a legacy raw
      // root `namespaces/ns-616c706861` (named verbatim `ns-616c706861`) records a
      // catalog row from the write path; that row is in `existing` (the prior
      // load) here. If we still decoded to `alpha`, this scan would emit an `alpha`
      // row at `fullPath`, and the final live-row remerge in `finishRebuild` would
      // re-add the literal `ns-616c706861` row (its root still has data) — leaving
      // TWO catalog rows at the SAME `storageDir`, fanning QMD/maintenance out under
      // the wrong namespace. So, mirroring `namespaceFromStorageDir`'s "config/catalog
      // match before decode" rule, prefer the LITERAL dir name when it is already a
      // KNOWN namespace — configured OR present as a live/cataloged row in `existing`
      // — and DO NOT also emit the decoded alias for that same root. A genuine
      // tokenized dir with no literal owner (no `existing` row keyed by the raw
      // token) still decodes as before.
      // Root ownership (codex r3499938974): preserving the literal must be
      // ROOT-based, not just key-based. A STALE cataloged row merely NAMED like
      // the token (but whose storageDir is NOT this `fullPath`) must NOT win — a
      // real dynamic `alpha` write served from this tokenized root would then be
      // rebuilt under the stale literal name and the fresh `alpha` row dropped by
      // the owned-by-other guard. So only prefer the literal when a CONFIGURED
      // name matches OR an existing cataloged row named `token` actually OWNS this
      // `fullPath`. A genuine tokenized root with no literal owner decodes.
      const literalRecord = existing.get(token);
      const literalOwnsRoot =
        configured.has(token) ||
        (literalRecord !== undefined &&
          path.resolve(literalRecord.storageDir) === path.resolve(fullPath));
      // Match `storageFor()`'s canonical namespace identity. A raw root whose
      // spelling trims to another namespace (for example `namespaces/shared `)
      // is not a routeable live root and must not be catalogued from disk.
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
      // Only catalog roots that actually hold memory data (skip empty shells).
      // A malformed PRESENT marker is different from an absent marker: if
      // `facts/` is a file/symlink but `state/` is valid, cataloging the root
      // would later make catalog-driven QMD scan the bad category directory and
      // throw. Reject the whole root on the first malformed known marker.
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

      // Default-root alignment (Issue C): never let a tokenized default dir
      // overwrite the configured default's storageDir with `fullPath`. The
      // default record's root is owned by `resolveDefaultNamespaceRoot` above,
      // which mirrors the router. We still keep the default record (set in
      // step 1) but skip clobbering its root here.
      if (decoded === defaultNs) {
        const def = rebuilt.get(defaultNs);
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
          // Configured-and-present namespaces keep config provenance; purely
          // discovered ones are scan.
          discoveredBy: configured.has(decoded) ? "config" : prior?.discoveredBy ?? "scan",
        }),
      );
    }

    // Mark legacy default root explicitly when applicable.
    if (legacyDefaultHasData && defaultStorageDir === this.memoryDir) {
      const def = rebuilt.get(defaultNs);
      if (def) def.kind = "default";
    }

    // ── Final critical section (SCOPED MUTEX — NFgCT, codex P2) ──────────────
    // The disk scan above ran LOCKLESS (it only reads). Now, for a mutating
    // rebuild, acquire the cross-process file lock ONLY for the
    // load→merge→rename window — the brief section a concurrent touch must be
    // excluded from. `canMutate` is true iff we ACTUALLY hold the lock: if
    // acquisition timed out (`acquired === false`) we run compute-only and never
    // re-merge+rewrite unlocked (which would race a concurrent lock holder and
    // recreate the lost-append window). A dry-run skips the lock entirely.
    if (!wantMutate) {
      return this.finishRebuild(rebuilt, skipped, dryRun, false, memoryReal, nowIso);
    }
    // Test-only seam: the SCAN is now complete but the cross-process lock has NOT
    // yet been acquired (NFgCT). A concurrency test attempts a cross-instance touch
    // here and asserts it is NOT blocked/dropped — proving the scan is lockless.
    if (this.onRebuildAfterScanForTest) {
      await this.onRebuildAfterScanForTest();
    }
    return this.withHeldCatalogLock((acquired) =>
      this.finishRebuild(rebuilt, skipped, dryRun, acquired, memoryReal, nowIso),
    );
  }

  /**
   * Final load→merge→rename window of a rebuild, factored out so the caller can
   * run it WITHIN the cross-process file lock (NFgCT, codex P2) without holding
   * that lock across the preceding disk scan. Re-reads the latest on-disk state,
   * folds concurrent touches, then (when `canMutate`) atomically rewrites the log.
   *
   * `canMutate` records that the cross-process lock was actually held. The
   * re-merge + rewrite run only when it is true — a dry-run, or an unlocked apply
   * (lock-acquisition timeout), computes records but does NOT rename, so it can
   * never clobber a concurrent lock holder's window. `applied` mirrors `canMutate`.
   */
  private async finishRebuild(
    rebuilt: Map<string, NamespaceRecord>,
    skipped: NamespaceCatalogSkippedRoot[],
    dryRun: boolean,
    canMutate: boolean,
    memoryReal: string | null,
    nowIso: string,
  ): Promise<NamespaceCatalogRebuildResult> {
    if (canMutate) {
      // CROSS-PROCESS re-merge (round 5, codex P2): under the rebuild lock,
      // re-read the on-disk log ONE more time and fold any touch fields that
      // landed AFTER our initial `loadCompacted()` (e.g. a gateway markWrite in
      // another process) into the rebuilt records — last-write-wins per touch
      // field. This recovers cross-process appends that completed during the
      // scan, which the in-process `queueCritical` alone cannot see. Only runs
      // when we hold the lock (round 6, codex P2 — NBPmY): an unlocked rebuild
      // must not re-merge then rename, or it races a concurrent lock holder.
      const latest = await this.loadCompacted(true);
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
          // would defeat the purge the rebuild is meant to perform.
          //
          // CREATED-AFTER-SCAN RE-CHECK (NFJV8, codex P2): there is a TOCTOU
          // window where a dynamic namespace is CREATED on disk AFTER the scan
          // enumerated `namespaces/` but BEFORE this re-merge. Its new root was
          // missed by the snapshot, yet a gateway `markWrite` already landed a row
          // in `latest`. Purging that row would drop a LIVE namespace that now has
          // data on disk. So before purging, re-check the namespace's storage root
          // RIGHT NOW (with the same symlink/realpath/containment + memory-data
          // safety the scan uses). If it currently EXISTS with data, the namespace
          // was created-after-scan and is live — KEEP its row. This is the precise
          // inverse of NATqU, not a regression of it: a touch on a REMOVED root
          // re-checks as absent and is still purged below; only a root that EXISTS
          // on a fresh re-check is kept.
          //
          // SAFETY REVALIDATION (NGLz5, codex P2): the `ns` key comes from the
          // UNTRUSTED log (`latest`), which may carry an unsafe namespace row from a
          // pre-fix or tampered catalog. The disk SCAN validates every decoded
          // namespace with `isSafeRouteNamespace` (default exempt) and SKIPS unsafe
          // ones — so an unsafe namespace is absent from `rebuilt` by design, NOT
          // because it was deleted. Without re-applying that exact check here, a
          // matching tokenized dir on disk would let this branch RESURRECT the
          // unsafe row, and `--apply` would rewrite the catalog with a namespace the
          // hot touch/config/scan paths all reject — leaving maintenance/QMD able to
          // enumerate an unsafe namespace after a rebuild that appeared to skip it.
          // Apply the SAME default-exempt safety gate before the live-root recheck;
          // an unsafe row is dropped (fall through to purge), never kept.
          if (ns !== this.defaultNamespaceIdentity && !isSafeRouteNamespace(ns)) {
            continue;
          }
          if (await this.liveStorageRootExistsForRebuild(ns, memoryReal)) {
            // Created-after-scan: keep the live row. Re-resolve its storageDir to
            // the safe (router-aligned, contained) root so we never persist a
            // touch's stale/escaping `storageDir`.
            const safeDir = await this.resolveSafeStorageDir(ns);
            // DUAL-ROOT GUARD (codex NR-td): if another rebuilt row already OWNS
            // this exact storageDir (e.g. the decoded/configured owner of a
            // token-shaped root that the disk scan resolved), do NOT also resurrect
            // this stale alias from the untrusted log — that leaves TWO catalog rows
            // pointing at one root and fans maintenance/QMD out over the wrong
            // namespace. Enforce at most one row per storageDir: the scan's owner
            // wins, the alias is dropped (falls through to purge) after folding
            // its touch fields into the owner so recency filters/maintenance do
            // not miss a real write.
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
          // Confirmed absent on disk. Losing a touch timestamp for a deleted root
          // is acceptable (the catalog is rebuildable best-effort metadata);
          // resurrecting a purged record is not. Drop it.
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
        // NG7Bg seam: fires inside the util's breakStaleLock after it judges the
        // lock stale and captures its identity, before the atomic rename+verify.
        onBeforeBreakStaleUnlinkForTest: this.onBeforeBreakStaleUnlinkForTest,
      },
      fn,
    );
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
    return merged;
  }
  // ── Persistence ──────────────────────────────────────────────────────────

  /** Load the JSONL log and fold it into current state (last-record-wins). */
  private async loadCompacted(forceFresh = false): Promise<Map<string, NamespaceRecord>> {
    const records = new Map<string, NamespaceRecord>();
    let handle;
    try {
      handle = await open(this.catalogPath, "r");
    } catch {
      this.compactedCache = undefined;
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
        return this.cloneCompactedRecords(this.compactedCache.records);
      }
    } catch {
      // A failed fstat cannot prove freshness. Read and parse the open file, but
      // do not cache the result without a trustworthy identity.
    }

    try {
      this.onCatalogReadForTest?.();
      // Streaming chunked parse (issue #1903): the log can reach 100+ MB in
      // production, so read it in bounded chunks and yield to the event loop
      // every ~5000 lines instead of buffering the whole file and blocking on a
      // single giant `split("\n")`. The fold is unchanged (last-record-wins with
      // field-level touch merge across cross-process full-snapshot appends).
      const CHUNK_BYTES = 1 << 16; // 64 KiB
      const YIELD_EVERY_LINES = 5000;
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      // StringDecoder buffers partial multi-byte UTF-8 sequences that straddle a
      // chunk boundary, so a namespace/principal with non-ASCII bytes never
      // corrupts at the seam.
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
          // Skip corrupt lines (CLAUDE.md rule #18 robustness).
          return;
        }
        const record = coerceRecord(parsed);
        if (!record) return;
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
    } catch {
      this.compactedCache = undefined;
      return new Map();
    } finally {
      await handle.close().catch(() => undefined);
    }

    this.compactedCache = identity ? { identity, records } : undefined;
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

  /**
   * Serialize an arbitrary read-modify-write critical section through the single
   * per-instance chain. Every catalog mutation and cached catalog read runs
   * through this queue, so cache validation and updates cannot race in-process.
   *
   * Issue #1524 adoption: delegates to the shared `MutationSerializer` (stored
   * as `criticalSection`). The util owns the rejection-recovery invariant
   * (CLAUDE.md rule #40 — one failed section never poisons subsequent ones, but
   * the failing section's error still surfaces to ITS awaited promise) and the
   * no-unbounded-growth cleanup. The key is constant: the catalog has ONE
   * logical mutation queue (touches and rebuilds mutually exclude in-process).
   */
  private queueCritical<T>(fn: () => Promise<T>): Promise<T> {
    return this.criticalSection.serialize("catalog", fn);
  }

  /**
   * Append a single record to the JSONL log WITHOUT re-serializing through the
   * write chain. MUST only be called from inside a `queueCritical(...)` section
   * (which already holds the serialized turn); calling it directly would bypass
   * the read-before-append ordering that prevents lost-field races.
   */
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
