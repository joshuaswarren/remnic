import path from "node:path";
import fs from "node:fs";
import type {
  MemoryGovernanceAppliedAction,
  MemoryGovernanceMetrics,
  MemoryGovernanceReviewQueueEntry,
  MemoryGovernanceSummary,
} from "./maintenance/memory-governance.js";
import type {
  MemoryCategory,
  MemoryLifecycleEvent,
  MemoryProjectionCurrentState,
  MemoryStatus,
} from "./types.js";
import { log } from "./logger.js";
import {
  displayErrorDetail,
  isLikelyBetterSqlite3NativeBindingError,
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "./runtime/better-sqlite.js";

export const MEMORY_PROJECTION_SCHEMA_VERSION = 3;

export interface ProjectedMemoryBrowseOptions {
  query?: string;
  status?: string;
  category?: string;
  excludeTags?: readonly string[];
  sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
  limit: number;
  offset: number;
}

export interface ProjectedMemoryBrowseRow {
  id: string;
  path: string;
  category: MemoryCategory;
  status: MemoryStatus;
  created?: string;
  updated?: string;
  tags: string[];
  entityRef?: string;
  preview: string;
}

export interface ProjectedMemoryBrowsePage {
  total: number;
  memories: ProjectedMemoryBrowseRow[];
}

export interface ProjectedEntityMentionRow {
  memoryId: string;
  entityRef: string;
  mentionSource: string;
  created: string;
  updated: string;
}

export interface ProjectedNativeKnowledgeChunkRow {
  chunkId: string;
  sourcePath: string;
  title: string;
  sourceKind: string;
  startLine: number;
  endLine: number;
  derivedDate?: string;
  sessionKey?: string;
  workflowKey?: string;
  author?: string;
  agent?: string;
  namespace?: string;
  privacyClass?: string;
  sourceHash?: string;
  preview: string;
}

export interface MemoryProjectionGovernanceReviewQueueRow {
  runId: string;
  entryId: string;
  memoryId: string;
  path: string;
  reasonCode: MemoryGovernanceReviewQueueEntry["reasonCode"];
  severity: MemoryGovernanceReviewQueueEntry["severity"];
  suggestedAction: MemoryGovernanceReviewQueueEntry["suggestedAction"];
  suggestedStatus?: MemoryGovernanceReviewQueueEntry["suggestedStatus"];
  relatedMemoryIds: string[];
}

export interface MemoryProjectionGovernanceAppliedActionRow {
  runId: string;
  rowKey: string;
  action: MemoryGovernanceAppliedAction["action"];
  memoryId: string;
  reasonCode: MemoryGovernanceAppliedAction["reasonCode"];
  beforeStatus: MemoryGovernanceAppliedAction["beforeStatus"];
  afterStatus?: MemoryGovernanceAppliedAction["afterStatus"];
  originalPath: string;
  currentPath: string;
}

export interface ProjectedReviewQueueSnapshot {
  found: boolean;
  runId?: string;
  summary?: MemoryGovernanceSummary;
  metrics?: MemoryGovernanceMetrics;
  reviewQueue?: MemoryGovernanceReviewQueueEntry[];
  appliedActions?: MemoryGovernanceAppliedAction[];
  report?: string;
}

export function getMemoryProjectionPath(memoryDir: string): string {
  return path.join(memoryDir, "state", "memory-projection.sqlite");
}

function listTableColumns(db: BetterSqlite3Database, tableName: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
    return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
  } catch {
    return new Set<string>();
  }
}

function migrateMemoryCurrentTable(db: BetterSqlite3Database): void {
  const columns = listTableColumns(db, "memory_current");
  if (columns.size === 0) return;

  if (!columns.has("tags_json")) {
    db.exec(`ALTER TABLE memory_current ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!columns.has("preview_text")) {
    db.exec(`ALTER TABLE memory_current ADD COLUMN preview_text TEXT NOT NULL DEFAULT ''`);
  }
}

function memoryCurrentRequiresMigration(db: BetterSqlite3Database): boolean {
  const columns = listTableColumns(db, "memory_current");
  return columns.size > 0 && (!columns.has("tags_json") || !columns.has("preview_text"));
}

function migrateProjectionSchemaIfNeeded(memoryDir: string): void {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    const db = openBetterSqlite3(dbPath, { fileMustExist: true });
    try {
      if (!memoryCurrentRequiresMigration(db)) return;
      initializeMemoryProjectionDb(db);
    } finally {
      db.close();
    }
  } catch {
    // Fail open on migration attempts so readonly consumers can still use legacy rows.
  }
}

export function memoryCurrentSelectExpressions(db: BetterSqlite3Database): {
  tagsJson: string;
  previewText: string;
  hasPathValid: boolean;
} {
  const columns = listTableColumns(db, "memory_current");
  return {
    tagsJson: columns.has("tags_json") ? "tags_json" : `'[]' AS tags_json`,
    previewText: columns.has("preview_text") ? "preview_text" : `'' AS preview_text`,
    hasPathValid: columns.has("path_valid"),
  };
}

export function initializeMemoryProjectionDb(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_current (
      memory_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      lifecycle_state TEXT,
      path_rel TEXT NOT NULL,
      path_valid INTEGER NOT NULL DEFAULT 0 CHECK (path_valid IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      superseded_at TEXT,
      entity_ref TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      confidence_tier TEXT NOT NULL,
      memory_kind TEXT,
      access_count INTEGER,
      last_accessed TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      preview_text TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_memory_current_status
      ON memory_current(status);

    CREATE INDEX IF NOT EXISTS idx_memory_current_category
      ON memory_current(category);


    CREATE TABLE IF NOT EXISTS memory_timeline (
      event_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_order INTEGER NOT NULL,
      actor TEXT NOT NULL,
      reason_code TEXT,
      rule_version TEXT NOT NULL,
      related_memory_ids_json TEXT,
      before_json TEXT,
      after_json TEXT,
      correlation_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_timeline_memory_ts
      ON memory_timeline(memory_id, timestamp, event_order);

    CREATE TABLE IF NOT EXISTS memory_entity_mentions (
      memory_id TEXT NOT NULL,
      entity_ref TEXT NOT NULL,
      mention_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, entity_ref, mention_source)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity
      ON memory_entity_mentions(entity_ref, updated_at DESC);

    CREATE TABLE IF NOT EXISTS native_knowledge_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      derived_date TEXT,
      session_key TEXT,
      workflow_key TEXT,
      author TEXT,
      agent TEXT,
      namespace TEXT,
      privacy_class TEXT,
      source_hash TEXT,
      preview_text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_native_knowledge_source_kind
      ON native_knowledge_chunks(source_kind);

    CREATE INDEX IF NOT EXISTS idx_native_knowledge_namespace
      ON native_knowledge_chunks(namespace);

    CREATE TABLE IF NOT EXISTS memory_review_runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      applied_actions_json TEXT NOT NULL,
      report_markdown TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_review_runs_created
      ON memory_review_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_review_queue (
      entry_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      path TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      severity TEXT NOT NULL,
      suggested_action TEXT NOT NULL,
      suggested_status TEXT,
      related_memory_ids_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_review_queue_run
      ON memory_review_queue(run_id, reason_code, memory_id);

    CREATE TABLE IF NOT EXISTS memory_review_actions (
      row_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      action TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      before_status TEXT NOT NULL,
      after_status TEXT,
      original_path TEXT NOT NULL,
      current_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_review_actions_run
      ON memory_review_actions(run_id, memory_id);
  `);

  migrateMemoryCurrentTable(db);
  if (listTableColumns(db, "memory_current").has("path_valid")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_current_browse_updated_desc
        ON memory_current(path_valid, updated_at DESC, created_at DESC, memory_id ASC);
      CREATE INDEX IF NOT EXISTS idx_memory_current_browse_updated_asc
        ON memory_current(path_valid, updated_at ASC, created_at ASC, memory_id ASC);
      CREATE INDEX IF NOT EXISTS idx_memory_current_browse_created_desc
        ON memory_current(path_valid, created_at DESC, updated_at DESC, memory_id ASC);
      CREATE INDEX IF NOT EXISTS idx_memory_current_browse_created_asc
        ON memory_current(path_valid, created_at ASC, updated_at ASC, memory_id ASC);
    `);
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
    .run("schemaVersion", String(MEMORY_PROJECTION_SCHEMA_VERSION));
}

// Test seam (issue #1829): the readonly projection opener is overridable so
// tests can inject an ABI-style throw against a PRESENT file without faking a
// corrupt native binding. Default delegates to the shared opener.
type ProjectionReadonlyOpener = typeof openBetterSqlite3;
let projectionReadonlyOpener: ProjectionReadonlyOpener = openBetterSqlite3;

/** @internal Test seam: override the readonly projection opener; returns a restore fn. */
export function __setProjectionReadonlyOpenerForTest(
  opener: ProjectionReadonlyOpener | null,
): () => void {
  const previous = projectionReadonlyOpener;
  projectionReadonlyOpener = opener ?? openBetterSqlite3;
  return () => {
    projectionReadonlyOpener = previous;
  };
}

// Rate-limited suppression for open failures — mirrors warnProjectionFallback
// in storage-guards.ts (5-min dedup per memoryDir). A present-but-unopenable
// projection is a real failure that must surface, but it repeats on every
// browse, so the log is throttled to keep output actionable (issue #1829).
const PROJECTION_OPEN_FAILURE_LOG_INTERVAL_MS = 5 * 60_000;
const projectionOpenFailureLoggedAt = new Map<string, number>();

/** @internal Test seam: clear the rate-limit dedup map. */
export function __resetProjectionOpenFailureSuppressionForTest(): void {
  projectionOpenFailureLoggedAt.clear();
}

function logProjectionOpenFailure(memoryDir: string, error: unknown): void {
  const now = Date.now();
  const warnedAt = projectionOpenFailureLoggedAt.get(memoryDir) ?? 0;
  if (now - warnedAt < PROJECTION_OPEN_FAILURE_LOG_INTERVAL_MS) return;
  projectionOpenFailureLoggedAt.set(memoryDir, now);
  // Path-free detail only (rule 11 / CodeQL js/stack-trace-exposure): the raw
  // message can embed absolute loader paths; displayErrorDetail returns class +
  // code. This is the DISTINCT signal that was missing before #1829, when a
  // wrong-ABI build collapsed into the same silent null as a missing file.
  const detail = displayErrorDetail(error);
  const nativeMismatch = isLikelyBetterSqlite3NativeBindingError(error);
  const detailSuffix = detail ? ` (${detail})` : "";
  const abiSuffix = nativeMismatch
    ? " — native binding built for the wrong Node.js ABI; rebuild better-sqlite3 for this process"
    : "";
  log.warn(
    `storage.memory-projection: index present but could not be opened${detailSuffix}${abiSuffix}; falling back to full-corpus scan`,
  );
}

export function openProjectionReadonly(memoryDir: string): BetterSqlite3Database | null {
  const dbPath = getMemoryProjectionPath(memoryDir);
  // A MISSING file is a normal fallback (cold install, never built). A file
  // that EXISTS but cannot open (wrong ABI / corrupt / bad perms) is a real
  // failure that must surface (issue #1829): previously both collapsed into
  // the same silent null, hiding native-binding mismatches behind 17-27s
  // full-corpus scans on every memory list.
  if (!fs.existsSync(dbPath)) return null;
  try {
    return projectionReadonlyOpener(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    logProjectionOpenFailure(memoryDir, error);
    return null;
  }
}

export type ProjectionHealthState = "absent" | "openable" | "present-but-invalid" | "unopenable";

export interface ProjectionHealthProbe {
  state: ProjectionHealthState;
  /** Path-free detail (class + code) when state !== "absent"/"openable"; "" otherwise. */
  detail: string;
  /** true when the open failure is classified as a native-binding ABI mismatch. */
  nativeBindingMismatch: boolean;
}

/**
 * Confirm the projection schema is present and queryable, not just that the
 * sqlite file opens (issue #1848 round 2). A file that opens but has the
 * projection tables missing — or is corrupt and only fails on first statement
 * — previously reported `openable`/ok, so `remnic doctor` said healthy while
 * browse silently fell back to full-corpus scans. `memory_current` is the
 * core browse table; if it is absent or unreadable the projection cannot
 * serve any query. Throws so the probe can report a distinct state.
 */
// Named so displayErrorDetail surfaces a clear, path-free identifier in the
// doctor report rather than a generic "Error".
class ProjectionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionSchemaError";
  }
}

/**
 * Columns `readProjectedMemoryBrowse` SELECTs from `memory_current` with no
 * graceful fallback. `tags_json`/`preview_text` fall back via
 * memoryCurrentSelectExpressions and `path_valid` falls back via the legacy
 * full-scan branch — none of those make a browse query throw. A projection
 * whose `memory_current` lacks any of these columns cannot serve browse
 * queries: the SELECT throws and browse silently falls back to a full-corpus
 * scan. Enumerated directly from readProjectedMemoryBrowse's SELECT list +
 * ORDER BY references (issue #1848 round 3).
 */
const REQUIRED_MEMORY_CURRENT_COLUMNS = [
  "memory_id",
  "path_rel",
  "category",
  "status",
  "created_at",
  "updated_at",
  "entity_ref",
] as const;

function assertProjectionSchemaReadable(db: BetterSqlite3Database): void {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_current'",
    )
    .get() as { name: string } | undefined;
  if (!row?.name) {
    throw new ProjectionSchemaError(
      "projection schema is missing or was not initialized (memory_current table not found)",
    );
  }
  // Round 3 (issue #1848): verify the columns readProjectedMemoryBrowse
  // actually SELECT are present, not just that the table exists. A file like
  // `CREATE TABLE memory_current (x INTEGER)` passed the round-2 table-existence
  // + SELECT-1 check but cannot serve browse queries, so browse silently fell
  // back to full-corpus scans while `remnic doctor` reported healthy. Classify
  // such a stale/half-built table as present-but-invalid so the operator gets a
  // rebuild hint instead of a false-clean bill of health.
  const columns = listTableColumns(db, "memory_current");
  const missing = REQUIRED_MEMORY_CURRENT_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length > 0) {
    throw new ProjectionSchemaError(
      `projection memory_current table is missing required column(s): ${missing.join(", ")}`,
    );
  }
  // Also confirm the table is queryable — catches physical corruption that
  // only surfaces on first read (the file opens but statements fail).
  db.prepare("SELECT 1 FROM memory_current LIMIT 1").get();
}

/**
 * Stat + attempt-open + schema-validate the memory projection WITHOUT keeping
 * a handle, for the `remnic doctor` health check (issue #1829 / #1848).
 * Distinguishes four states so operators can tell "not built yet" (normal) from
 * "exists but broken" (needs a rebuild / native-binding rebuild). Never throws.
 */
export function probeProjectionHealth(memoryDir: string): ProjectionHealthProbe {
  const dbPath = getMemoryProjectionPath(memoryDir);
  if (!fs.existsSync(dbPath)) {
    return { state: "absent", detail: "", nativeBindingMismatch: false };
  }
  let db: BetterSqlite3Database | null = null;
  try {
    db = projectionReadonlyOpener(dbPath, { readonly: true, fileMustExist: true });
    // Validate the projection is actually USABLE, not just that the file
    // opens (issue #1848 round 2): a file that opens but has the schema
    // missing/corrupt previously reported ok, so doctor said healthy while
    // browse silently fell back to full-corpus scans.
    assertProjectionSchemaReadable(db);
    return { state: "openable", detail: "", nativeBindingMismatch: false };
  } catch (error) {
    // If the file OPENED (db assigned) but the schema query failed, the
    // native binding is fine — the projection itself is stale/corrupt.
    if (db) {
      return {
        state: "present-but-invalid",
        detail: displayErrorDetail(error),
        nativeBindingMismatch: false,
      };
    }
    return {
      state: "unopenable",
      detail: displayErrorDetail(error),
      nativeBindingMismatch: isLikelyBetterSqlite3NativeBindingError(error),
    };
  } finally {
    db?.close();
  }
}
function updateProjectionBestEffort(
  memoryDir: string,
  sql: string,
  params: unknown[],
): void {
  let db: BetterSqlite3Database | null = null;
  try {
    db = openBetterSqlite3(getMemoryProjectionPath(memoryDir), { fileMustExist: true });
    db.prepare(sql).run(...params);
  } catch {
    // Projection updates must never block the canonical filesystem mutation.
  } finally {
    db?.close();
  }
}

export function markProjectedMemoryPathInvalid(memoryDir: string, memoryId: string): void {
  updateProjectionBestEffort(
    memoryDir,
    "UPDATE memory_current SET path_valid = 0 WHERE memory_id = ?",
    [memoryId],
  );
}

export function updateProjectedMemoryPath(
  memoryDir: string,
  memoryId: string,
  pathRel: string,
): void {
  const pathValid = isProjectedMemoryPathValid(memoryDir, pathRel) ? 1 : 0;
  updateProjectionBestEffort(
    memoryDir,
    "UPDATE memory_current SET path_rel = ?, path_valid = ? WHERE memory_id = ?",
    [pathRel, pathValid, memoryId],
  );
}

function withProjectionReadonly<T>(
  memoryDir: string,
  reader: (db: BetterSqlite3Database) => T,
): T | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  let needsMigration = false;
  try {
    needsMigration = memoryCurrentRequiresMigration(db);
    return reader(db);
  } catch {
    return null;
  } finally {
    db.close();
    if (needsMigration) {
      migrateProjectionSchemaIfNeeded(memoryDir);
    }
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function resolveMemoryDirRoot(memoryDir: string): string {
  try {
    return fs.realpathSync(memoryDir);
  } catch {
    return path.resolve(memoryDir);
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveProjectedMemoryPath(
  memoryDir: string,
  pathRel: string,
  requireExisting = false,
): string | null {
  if (path.isAbsolute(pathRel)) return null;
  const root = resolveMemoryDirRoot(memoryDir);
  const candidate = path.resolve(root, pathRel);
  if (!isPathInsideRoot(candidate, root)) return null;
  try {
    const realCandidate = fs.realpathSync(candidate);
    if (!isPathInsideRoot(realCandidate, root)) return null;
  } catch {
    if (requireExisting) return null;
    // Missing files are handled by callers. Still keep the lexical guard above.
  }
  return candidate;
}

export function isProjectedMemoryPathValid(memoryDir: string, pathRel: string): boolean {
  return resolveProjectedMemoryPath(memoryDir, pathRel) !== null;
}

function projectedBrowseRowFromCurrentRow(
  memoryDir: string,
  row: Record<string, unknown>,
  resolvedFilePath?: string,
  requireExisting = false,
): ProjectedMemoryBrowseRow | null {
  if (
    typeof row.memory_id !== "string" ||
    typeof row.path_rel !== "string" ||
    typeof row.category !== "string" ||
    typeof row.status !== "string"
  ) {
    return null;
  }
  const filePath = resolvedFilePath ?? resolveProjectedMemoryPath(memoryDir, row.path_rel, requireExisting);
  if (!filePath) return null;
  return {
    id: row.memory_id,
    path: filePath,
    category: row.category as MemoryCategory,
    status: row.status as MemoryStatus,
    created: typeof row.created_at === "string" ? row.created_at : undefined,
    updated: typeof row.updated_at === "string" ? row.updated_at : undefined,
    tags: parseStringArray(row.tags_json),
    entityRef: typeof row.entity_ref === "string" ? row.entity_ref : undefined,
    preview: typeof row.preview_text === "string" ? row.preview_text : "",
  };
}

function projectedBrowsePathSqlClauses(): string[] {
  return [
    "path_rel <> ''",
    "path_rel NOT LIKE '/%'",
    "path_rel <> '..'",
    "path_rel NOT LIKE '../%'",
    "path_rel NOT LIKE '%/../%'",
  ];
}

export function parseCurrentRow(
  memoryDir: string,
  row: Record<string, unknown> | undefined,
): MemoryProjectionCurrentState | null {
  if (!row) return null;
  if (
    typeof row.memory_id !== "string" ||
    typeof row.category !== "string" ||
    typeof row.status !== "string" ||
    typeof row.path_rel !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.source !== "string" ||
    typeof row.confidence !== "number" ||
    typeof row.confidence_tier !== "string"
  ) {
    return null;
  }
  const filePath = resolveProjectedMemoryPath(memoryDir, row.path_rel);
  if (!filePath) return null;

  return {
    memoryId: row.memory_id,
    category: row.category as MemoryProjectionCurrentState["category"],
    status: row.status as MemoryStatus,
    lifecycleState:
      typeof row.lifecycle_state === "string"
        ? (row.lifecycle_state as MemoryProjectionCurrentState["lifecycleState"])
        : undefined,
    path: filePath,
    pathRel: row.path_rel,
    created: row.created_at,
    updated: row.updated_at,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : undefined,
    supersededAt: typeof row.superseded_at === "string" ? row.superseded_at : undefined,
    entityRef: typeof row.entity_ref === "string" ? row.entity_ref : undefined,
    source: row.source,
    confidence: row.confidence,
    confidenceTier: row.confidence_tier as MemoryProjectionCurrentState["confidenceTier"],
    memoryKind:
      typeof row.memory_kind === "string"
        ? (row.memory_kind as MemoryProjectionCurrentState["memoryKind"])
        : undefined,
    accessCount: typeof row.access_count === "number" ? row.access_count : undefined,
    lastAccessed: typeof row.last_accessed === "string" ? row.last_accessed : undefined,
    tags: parseStringArray(row.tags_json),
    preview: typeof row.preview_text === "string" ? row.preview_text : "",
  };
}

export function parseTimelineRows(rows: Array<Record<string, unknown>>): MemoryLifecycleEvent[] {
  const out: MemoryLifecycleEvent[] = [];
  for (const row of rows) {
    if (
      typeof row.event_id !== "string" ||
      typeof row.memory_id !== "string" ||
      typeof row.event_type !== "string" ||
      typeof row.timestamp !== "string" ||
      typeof row.actor !== "string" ||
      typeof row.rule_version !== "string"
    ) {
      continue;
    }

    out.push({
      eventId: row.event_id,
      memoryId: row.memory_id,
      eventType: row.event_type as MemoryLifecycleEvent["eventType"],
      timestamp: row.timestamp,
      actor: row.actor,
      reasonCode: typeof row.reason_code === "string" ? row.reason_code : undefined,
      ruleVersion: row.rule_version,
      relatedMemoryIds: parseStringArray(row.related_memory_ids_json),
      before: parseJsonObject<MemoryLifecycleEvent["before"]>(row.before_json),
      after: parseJsonObject<MemoryLifecycleEvent["after"]>(row.after_json),
      correlationId: typeof row.correlation_id === "string" ? row.correlation_id : undefined,
    });
  }

  return out;
}

export function readProjectedMemoryState(
  memoryDir: string,
  memoryId: string,
): MemoryProjectionCurrentState | null {
  return withProjectionReadonly(memoryDir, (db) => {
    const currentSelect = memoryCurrentSelectExpressions(db);
    const row = db
      .prepare(
        `
          SELECT
            memory_id,
            category,
            status,
            lifecycle_state,
            path_rel,
            created_at,
            updated_at,
            archived_at,
            superseded_at,
            entity_ref,
            source,
            confidence,
            confidence_tier,
            memory_kind,
            access_count,
            last_accessed,
            ${currentSelect.tagsJson},
            ${currentSelect.previewText}
          FROM memory_current
          WHERE memory_id = ?
        `,
      )
      .get(memoryId) as Record<string, unknown> | undefined;
    return parseCurrentRow(memoryDir, row);
  });
}

export function readProjectedMemoryTimeline(
  memoryDir: string,
  memoryId: string,
  limit: number,
): MemoryLifecycleEvent[] | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  try {
    const rows = db
      .prepare(
        `
          SELECT * FROM (
            SELECT
              event_id,
              memory_id,
              event_type,
              timestamp,
              event_order,
              actor,
              reason_code,
              rule_version,
              related_memory_ids_json,
              before_json,
              after_json,
              correlation_id
            FROM memory_timeline
            WHERE memory_id = ?
            ORDER BY timestamp DESC, event_order DESC
            LIMIT ?
          )
          ORDER BY timestamp ASC, event_order ASC
        `,
      )
      .all(memoryId, limit) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return parseTimelineRows(rows);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readProjectedMemoryBrowse(
  memoryDir: string,
  options: ProjectedMemoryBrowseOptions,
): ProjectedMemoryBrowsePage | null {
  return withProjectionReadonly(memoryDir, (db) => {
    const normalizedQuery = options.query?.trim().toLowerCase() ?? "";
    const currentSelect = memoryCurrentSelectExpressions(db);
    if ((options.excludeTags?.length ?? 0) > 0 && currentSelect.tagsJson.startsWith("'[]'")) throw new Error("tag exclusions require tags_json");
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      whereClauses.push("status = ?");
      params.push(options.status);
    }
    if (options.category) {
      whereClauses.push("category = ?");
      params.push(options.category);
    }
    for (const tag of options.excludeTags ?? []) {
      whereClauses.push(
        "NOT EXISTS (SELECT 1 FROM json_each(memory_current.tags_json) AS excluded_tag WHERE excluded_tag.value = ?)",
      );
      params.push(tag);
    }
    const sort = options.sort ?? "updated_desc";
    const orderBySql = (() => {
      switch (sort) {
        case "updated_asc":
          return "updated_at ASC, created_at ASC, memory_id ASC";
        case "created_desc":
          return "created_at DESC, updated_at DESC, memory_id ASC";
        case "created_asc":
          return "created_at ASC, updated_at ASC, memory_id ASC";
        case "updated_desc":
        default:
          return "updated_at DESC, created_at DESC, memory_id ASC";
      }
    })();
    if (normalizedQuery) {
      // Full-content search still examines every eligible row so totals and
      // matches stay exact, but iteration keeps memory use proportional to the page.
      const queryWhereClauses = currentSelect.hasPathValid
        ? [...whereClauses, ...projectedBrowsePathSqlClauses(), "path_valid = 1"]
        : whereClauses;
      const queryWhereSql = queryWhereClauses.length > 0
        ? `WHERE ${queryWhereClauses.join(" AND ")}`
        : "";
      const rows = db
        .prepare(`
          SELECT
            memory_id,
            path_rel,
            category,
            status,
            created_at,
            updated_at,
            entity_ref,
            ${currentSelect.tagsJson},
            ${currentSelect.previewText}
          FROM memory_current
          ${queryWhereSql}
          ORDER BY ${orderBySql}
        `)
        .iterate(...params) as Iterable<Record<string, unknown>>;
      const pageRows: ProjectedMemoryBrowseRow[] = [];
      let total = 0;

      for (const row of rows) {
        if (typeof row.memory_id !== "string" || typeof row.path_rel !== "string") continue;
        const filePath = resolveProjectedMemoryPath(
          memoryDir,
          row.path_rel,
          currentSelect.hasPathValid,
        );
        if (!filePath) continue;
        const preview = typeof row.preview_text === "string" ? row.preview_text.toLowerCase() : "";
        const category = typeof row.category === "string" ? row.category.toLowerCase() : "";
        const entityRef = typeof row.entity_ref === "string" ? row.entity_ref.toLowerCase() : "";
        const tags = typeof row.tags_json === "string" ? row.tags_json.toLowerCase() : "";
        let matches = preview.includes(normalizedQuery) || category.includes(normalizedQuery) ||
          entityRef.includes(normalizedQuery) || tags.includes(normalizedQuery);
        if (!matches) {
          try {
            matches = fs.readFileSync(filePath, "utf-8").toLowerCase().includes(normalizedQuery);
          } catch {
            matches = false;
          }
        }
        if (!matches) continue;
        if (total >= options.offset && pageRows.length < options.limit) {
          const browseRow = projectedBrowseRowFromCurrentRow(memoryDir, row, filePath);
          if (browseRow) pageRows.push(browseRow);
        }
        total += 1;
      }

      return { total, memories: pageRows };
    }

    const browseWhereClauses = [...whereClauses, ...projectedBrowsePathSqlClauses()];
    if (currentSelect.hasPathValid) {
      browseWhereClauses.push("path_valid = 1");
    }
    const browseWhereSql = `WHERE ${browseWhereClauses.join(" AND ")}`;

    if (currentSelect.hasPathValid) {
      const rows = db
        .prepare(`
          SELECT
            memory_id,
            path_rel,
            category,
            status,
            created_at,
            updated_at,
            entity_ref,
            ${currentSelect.tagsJson},
            ${currentSelect.previewText}
          FROM memory_current
          ${browseWhereSql}
          ORDER BY ${orderBySql}
        `)
        .iterate(...params) as Iterable<Record<string, unknown>>;
      const pageRows: ProjectedMemoryBrowseRow[] = [];
      let validRowsSeen = 0;
      for (const row of rows) {
        const browseRow = projectedBrowseRowFromCurrentRow(memoryDir, row, undefined, true);
        if (!browseRow) continue;
        if (validRowsSeen >= options.offset) {
          pageRows.push(browseRow);
          if (pageRows.length >= options.limit) break;
        }
        validRowsSeen += 1;
      }
      const totalRow = db
        .prepare(`SELECT COUNT(*) AS total FROM memory_current ${browseWhereSql}`)
        .get(...params) as { total: number };
      return { total: totalRow.total, memories: pageRows };
    }

    // Legacy projections have no materialized path validity. Preserve the
    // realpath-aware full scan rather than trusting rows from an older writer.
    const pageRows: ProjectedMemoryBrowseRow[] = [];
    const fetchSize = Math.max(options.limit * 2, 50);
    let validRowsSeen = 0;
    let scanOffset = 0;

    while (true) {
      const rows = db
        .prepare(`
          SELECT
            memory_id,
            path_rel,
            category,
            status,
            created_at,
            updated_at,
            entity_ref,
            ${currentSelect.tagsJson},
            ${currentSelect.previewText}
          FROM memory_current
          ${browseWhereSql}
          ORDER BY ${orderBySql}
          LIMIT ? OFFSET ?
        `)
        .all(...params, fetchSize, scanOffset) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      scanOffset += rows.length;
      for (const row of rows) {
        const browseRow = projectedBrowseRowFromCurrentRow(memoryDir, row);
        if (!browseRow) continue;
        if (validRowsSeen >= options.offset && pageRows.length < options.limit) {
          pageRows.push(browseRow);
        }
        validRowsSeen += 1;
      }
      if (rows.length < fetchSize) break;
    }

    return {
      total: validRowsSeen,
      memories: pageRows,
    };
  });
}

export function readProjectedEntityMentions(
  memoryDir: string,
  memoryIds?: Set<string>,
): ProjectedEntityMentionRow[] | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  try {
    const rows = db
      .prepare(`
        SELECT
          memory_id,
          entity_ref,
          mention_source,
          created_at,
          updated_at
        FROM memory_entity_mentions
        ORDER BY entity_ref ASC, updated_at DESC, memory_id ASC
      `)
      .all() as Array<Record<string, unknown>>;

    return rows
      .filter(
        (row) =>
          typeof row.memory_id === "string" &&
          typeof row.entity_ref === "string" &&
          typeof row.mention_source === "string" &&
          typeof row.created_at === "string" &&
          typeof row.updated_at === "string" &&
          (!memoryIds || memoryIds.has(row.memory_id)),
      )
      .map((row) => ({
        memoryId: row.memory_id as string,
        entityRef: row.entity_ref as string,
        mentionSource: row.mention_source as string,
        created: row.created_at as string,
        updated: row.updated_at as string,
      }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readProjectedNativeKnowledgeChunks(
  memoryDir: string,
): ProjectedNativeKnowledgeChunkRow[] | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  try {
    const rows = db
      .prepare(`
        SELECT
          chunk_id,
          source_path,
          title,
          source_kind,
          start_line,
          end_line,
          derived_date,
          session_key,
          workflow_key,
          author,
          agent,
          namespace,
          privacy_class,
          source_hash,
          preview_text
        FROM native_knowledge_chunks
        ORDER BY source_kind ASC, source_path ASC, start_line ASC
      `)
      .all() as Array<Record<string, unknown>>;

    return rows
      .filter(
        (row) =>
          typeof row.chunk_id === "string" &&
          typeof row.source_path === "string" &&
          typeof row.title === "string" &&
          typeof row.source_kind === "string" &&
          typeof row.start_line === "number" &&
          typeof row.end_line === "number" &&
          typeof row.preview_text === "string",
      )
      .map((row) => ({
        chunkId: row.chunk_id as string,
        sourcePath: row.source_path as string,
        title: row.title as string,
        sourceKind: row.source_kind as string,
        startLine: row.start_line as number,
        endLine: row.end_line as number,
        derivedDate: typeof row.derived_date === "string" ? row.derived_date : undefined,
        sessionKey: typeof row.session_key === "string" ? row.session_key : undefined,
        workflowKey: typeof row.workflow_key === "string" ? row.workflow_key : undefined,
        author: typeof row.author === "string" ? row.author : undefined,
        agent: typeof row.agent === "string" ? row.agent : undefined,
        namespace: typeof row.namespace === "string" ? row.namespace : undefined,
        privacyClass: typeof row.privacy_class === "string" ? row.privacy_class : undefined,
        sourceHash: typeof row.source_hash === "string" ? row.source_hash : undefined,
        preview: row.preview_text as string,
      }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readProjectedLatestReviewQueue(
  memoryDir: string,
): ProjectedReviewQueueSnapshot | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  try {
    const latestRunId =
      (db.prepare(`SELECT value FROM meta WHERE key = 'latestGovernanceRunId'`).get() as { value?: string } | undefined)
        ?.value
      ?? (db.prepare(`SELECT run_id AS value FROM memory_review_runs ORDER BY created_at DESC LIMIT 1`).get() as {
        value?: string;
      } | undefined)?.value;
    if (!latestRunId) {
      return { found: false };
    }

    const runRow = db
      .prepare(`
        SELECT
          run_id,
          summary_json,
          metrics_json,
          applied_actions_json,
          report_markdown
        FROM memory_review_runs
        WHERE run_id = ?
      `)
      .get(latestRunId) as Record<string, unknown> | undefined;
    if (!runRow || typeof runRow.run_id !== "string") {
      return { found: false };
    }

    const queueRows = db
      .prepare(`
        SELECT
          entry_id,
          memory_id,
          path,
          reason_code,
          severity,
          suggested_action,
          suggested_status,
          related_memory_ids_json
        FROM memory_review_queue
        WHERE run_id = ?
        ORDER BY reason_code ASC, memory_id ASC
      `)
      .all(latestRunId) as Array<Record<string, unknown>>;

    const actionRows = db
      .prepare(`
        SELECT
          row_key,
          action,
          memory_id,
          reason_code,
          before_status,
          after_status,
          original_path,
          current_path
        FROM memory_review_actions
        WHERE run_id = ?
        ORDER BY memory_id ASC, action ASC
      `)
      .all(latestRunId) as Array<Record<string, unknown>>;

    const reviewQueue: MemoryGovernanceReviewQueueEntry[] = queueRows
      .filter(
        (row) =>
          typeof row.entry_id === "string" &&
          typeof row.memory_id === "string" &&
          typeof row.path === "string" &&
          typeof row.reason_code === "string" &&
          typeof row.severity === "string" &&
          typeof row.suggested_action === "string",
      )
      .map((row) => ({
        entryId: row.entry_id as string,
        memoryId: row.memory_id as string,
        path: row.path as string,
        reasonCode: row.reason_code as MemoryGovernanceReviewQueueEntry["reasonCode"],
        severity: row.severity as MemoryGovernanceReviewQueueEntry["severity"],
        suggestedAction: row.suggested_action as MemoryGovernanceReviewQueueEntry["suggestedAction"],
        suggestedStatus:
          typeof row.suggested_status === "string"
            ? (row.suggested_status as MemoryGovernanceReviewQueueEntry["suggestedStatus"])
            : undefined,
        relatedMemoryIds: parseStringArray(row.related_memory_ids_json),
      }));

    return {
      found: true,
      runId: latestRunId,
      summary: parseJsonObject<MemoryGovernanceSummary>(runRow.summary_json),
      metrics: parseJsonObject<MemoryGovernanceMetrics>(runRow.metrics_json),
      reviewQueue,
      appliedActions:
        actionRows.length > 0
          ? actionRows
            .filter(
              (row) =>
                typeof row.action === "string" &&
                typeof row.memory_id === "string" &&
                typeof row.reason_code === "string" &&
                typeof row.before_status === "string" &&
                typeof row.original_path === "string" &&
                typeof row.current_path === "string",
            )
            .map((row) => ({
              action: row.action as MemoryGovernanceAppliedAction["action"],
              memoryId: row.memory_id as string,
              reasonCode: row.reason_code as MemoryGovernanceAppliedAction["reasonCode"],
              beforeStatus: row.before_status as MemoryGovernanceAppliedAction["beforeStatus"],
              afterStatus:
                typeof row.after_status === "string"
                  ? (row.after_status as MemoryGovernanceAppliedAction["afterStatus"])
                  : undefined,
              originalPath: row.original_path as string,
              currentPath: row.current_path as string,
            }))
          : (parseJsonObject<MemoryGovernanceAppliedAction[]>(runRow.applied_actions_json) ?? []),
      report: typeof runRow.report_markdown === "string" ? runRow.report_markdown : undefined,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readProjectedGovernanceRecord(
  memoryDir: string,
): {
  runId: string;
  summary: unknown;
  metrics: unknown;
  reviewQueueRows: MemoryProjectionGovernanceReviewQueueRow[];
  appliedActionRows: MemoryProjectionGovernanceAppliedActionRow[];
  report: string;
} | null {
  const snapshot = readProjectedLatestReviewQueue(memoryDir);
  if (!snapshot?.found || !snapshot.runId) return null;

  return {
    runId: snapshot.runId,
    summary: snapshot.summary ?? {},
    metrics: snapshot.metrics ?? {},
    reviewQueueRows: (snapshot.reviewQueue ?? []).map((entry) => ({
      runId: snapshot.runId as string,
      entryId: entry.entryId,
      memoryId: entry.memoryId,
      path: entry.path,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      suggestedAction: entry.suggestedAction,
      suggestedStatus: entry.suggestedStatus,
      relatedMemoryIds: [...entry.relatedMemoryIds],
    })),
    appliedActionRows: (snapshot.appliedActions ?? []).map((action) => ({
      runId: snapshot.runId as string,
      rowKey: [
        action.action,
        action.memoryId,
        action.reasonCode,
        action.originalPath,
        action.currentPath,
      ].join("::"),
      action: action.action,
      memoryId: action.memoryId,
      reasonCode: action.reasonCode,
      beforeStatus: action.beforeStatus,
      afterStatus: action.afterStatus,
      originalPath: action.originalPath,
      currentPath: action.currentPath,
    })),
    report: snapshot.report ?? "",
  };
}
