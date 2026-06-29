import path from "node:path";
import type { Dirent } from "node:fs";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import type { PluginConfig } from "../types.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { namespaceIdentityFromToken, namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";
import { resolveDefaultNamespaceRoot } from "./storage.js";
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
}

const CATALOG_FILE = "namespaces.jsonl";
const STATE_DIR = "state";

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
  // Serialized write chain that recovers from rejection (CLAUDE.md rule #40)
  // so a single failed append cannot permanently poison subsequent writes.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: PluginConfig) {
    this.memoryDir = config.memoryDir;
    this.stateDir = path.join(this.memoryDir, STATE_DIR);
    this.catalogPath = path.join(this.stateDir, CATALOG_FILE);
  }

  /** Whether the catalog is active (namespaces enabled and catalog not opted out). */
  get enabled(): boolean {
    return isCatalogEnabled(this.config);
  }

  // ── Public enumeration API ──────────────────────────────────────────────

  async listNamespaces(filter?: NamespaceCatalogFilter): Promise<NamespaceRecord[]> {
    if (!this.enabled) return [];
    const records = await this.loadCompacted();
    let out = [...records.values()];
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
    return records.get(ns) ?? null;
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
      await this.register(ns, { discoveredBy: "config" });
    }
  }

  /**
   * Register a namespace whose storage was just resolved by the router. Used as
   * a fire-and-forget integration hook (`discoveredBy: config`). Storage dir is
   * provided so we do not re-resolve it. Failure-tolerant.
   */
  async registerResolved(namespace: string, storageDir: string): Promise<void> {
    if (!this.enabled) return;
    await this.register(namespace, { discoveredBy: "config", storageDir });
  }

  /**
   * Generic register/touch without changing read/write timestamps unless the
   * source implies it. Validates the namespace and resolves a storage dir.
   */
  private async register(namespace: string, metadata: NamespaceTouchMetadata): Promise<void> {
    await this.touch(namespace, "register", metadata);
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
   * Whether a candidate storage dir satisfies the catalog containment contract:
   * it is either the legacy default root (`memoryDir`) or lives under
   * `<memoryDir>/namespaces/`. The router legitimately resolves a namespace to
   * EITHER the tokenized dir or a legacy raw-name dir under `namespaces/`, so we
   * accept any contained child rather than a single exact token path.
   */
  private isContainedStorageDir(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    if (resolved === path.resolve(this.memoryDir)) return true;
    const nsBase = path.resolve(path.join(this.memoryDir, "namespaces"));
    const rel = path.relative(nsBase, resolved);
    // Must be a strict descendant of namespaces/ (non-empty, no parent escape).
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /**
   * Resolve the storage dir to persist for a touch, validating any caller-
   * provided `metadata.storageDir` against the catalog containment contract
   * (round 4, codex P2). `markWrite`/`registerResolved` accept an explicit
   * storageDir, but persisting it verbatim would let a bad hook or external
   * consumer write an arbitrary path — including one outside `memoryDir` — into
   * the catalog, handing maintenance/QMD an unsafe root. We accept an explicit
   * (or previously-stored) dir ONLY when it stays contained under memoryDir;
   * otherwise we drop it and fall back to the trusted resolved dir.
   */
  private resolveTouchStorageDir(
    namespace: string,
    explicit: string | undefined,
    existingDir: string | undefined,
  ): string {
    if (explicit !== undefined && this.isContainedStorageDir(explicit)) return explicit;
    // Don't let a record poisoned by a pre-fix out-of-containment write keep an
    // unsafe dir alive across touches — only preserve a contained existing dir.
    if (existingDir !== undefined && this.isContainedStorageDir(existingDir)) return existingDir;
    return this.resolveStorageDir(namespace);
  }

  private async touch(
    namespace: string,
    kind: "read" | "write" | "maintenance" | "register",
    metadata?: NamespaceTouchMetadata,
    jobName?: string,
  ): Promise<void> {
    if (!this.enabled) return;
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
    await this.queueCritical(async () => {
      const records = await this.loadCompacted();
      const existing = records.get(ns);

      // Containment-check any explicit storageDir before persisting it (round 4,
      // codex P2). Never trust a caller-provided path verbatim.
      const storageDir = this.resolveTouchStorageDir(ns, metadata?.storageDir, existing?.storageDir);
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
      if (metadata?.parentNamespace !== undefined) record.parentNamespace = metadata.parentNamespace;
      // NOTE: discoveredBy is intentionally NOT reassigned here for existing
      // records — see the creation-only rationale above (Issue 1 fix).

      if (kind === "read") record.lastReadAt = nowIso;
      if (kind === "write") record.lastWriteAt = nowIso;
      if (kind === "maintenance" && jobName) {
        record.lastMaintenanceAt = { ...(record.lastMaintenanceAt ?? {}), [jobName]: nowIso };
      }

      await this.appendUnchained(record);
    });
  }

  // ── Rebuild from disk ────────────────────────────────────────────────────

  async rebuildFromDisk(
    options?: { dryRun?: boolean },
  ): Promise<NamespaceCatalogRebuildResult> {
    const dryRun = options?.dryRun === true;
    if (!this.enabled) {
      return { dryRun, records: [], skipped: [] };
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
    return this.queueCritical(async () => this.rebuildInsideChain(dryRun));
  }

  /**
   * Body of `rebuildFromDisk`, run inside a single `queueCritical` turn. MUST
   * only be invoked from within the serialized chain so the load and the
   * rewrite are atomic with respect to concurrent touches.
   */
  private async rebuildInsideChain(dryRun: boolean): Promise<NamespaceCatalogRebuildResult> {
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
    const defaultStorageDir = await resolveDefaultNamespaceRoot(this.config);
    const legacyDefaultHasData = defaultStorageDir === this.memoryDir;

    for (const ns of configured) {
      if (!ns) continue;
      const storageDir = ns === this.config.defaultNamespace ? defaultStorageDir : this.namespaceTokenDir(namespaceIdentityToken(ns));
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
    try {
      entries = await readdir(namespacesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

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

      // Decode the namespace from the token, falling back to the raw dir name.
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

    const records = [...rebuilt.values()].sort((a, b) => {
      const byName = a.namespace.localeCompare(b.namespace);
      if (byName !== 0) return byName;
      return a.identityToken.localeCompare(b.identityToken);
    });

    if (!dryRun) {
      await this.rewriteUnchained(records);
    }

    return { dryRun, records, skipped };
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
      records.set(record.namespace, record);
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
