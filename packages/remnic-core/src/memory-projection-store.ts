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
import {
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "./runtime/better-sqlite.js";

export const MEMORY_PROJECTION_SCHEMA_VERSION = 2;

export interface ProjectedMemoryBrowseOptions {
  query?: string;
  status?: string;
  category?: string;
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
} {
  const columns = listTableColumns(db, "memory_current");
  return {
    tagsJson: columns.has("tags_json") ? "tags_json" : `'[]' AS tags_json`,
    previewText: columns.has("preview_text") ? "preview_text" : `'' AS preview_text`,
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

    CREATE INDEX IF NOT EXISTS idx_memory_current_updated
      ON memory_current(updated_at DESC);

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
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
    .run("schemaVersion", String(MEMORY_PROJECTION_SCHEMA_VERSION));
}

function openProjectionReadonly(memoryDir: string): BetterSqlite3Database | null {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    return openBetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
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

  return {
    memoryId: row.memory_id,
    category: row.category as MemoryProjectionCurrentState["category"],
    status: row.status as MemoryStatus,
    lifecycleState:
      typeof row.lifecycle_state === "string"
        ? (row.lifecycle_state as MemoryProjectionCurrentState["lifecycleState"])
        : undefined,
    path: path.join(memoryDir, row.path_rel),
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
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    if (normalizedQuery) {
      // Query-based browse: fetch all matching rows, filter by full file content, then paginate in JS
      const allRows = db
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
          ${whereSql}
          ORDER BY ${orderBySql}
        `)
        .all(...params) as Array<Record<string, unknown>>;

      const filtered = allRows.filter((row) => {
        if (typeof row.memory_id !== "string" || typeof row.path_rel !== "string") return false;
        // Check preview, category, entity_ref, tags first (fast)
        const preview = typeof row.preview_text === "string" ? row.preview_text.toLowerCase() : "";
        const category = typeof row.category === "string" ? row.category.toLowerCase() : "";
        const entityRef = typeof row.entity_ref === "string" ? row.entity_ref.toLowerCase() : "";
        const tags = typeof row.tags_json === "string" ? row.tags_json.toLowerCase() : "";
        if (preview.includes(normalizedQuery) || category.includes(normalizedQuery) ||
            entityRef.includes(normalizedQuery) || tags.includes(normalizedQuery)) {
          return true;
        }
        // Fall back to reading full file content from disk
        try {
          const filePath = path.join(memoryDir, row.path_rel as string);
          const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
          return content.includes(normalizedQuery);
        } catch {
          return false;
        }
      });

      const pageRows = filtered.slice(options.offset, options.offset + options.limit);
      return {
        total: filtered.length,
        memories: pageRows
          .filter(
            (row) =>
              typeof row.memory_id === "string" &&
              typeof row.path_rel === "string" &&
              typeof row.category === "string" &&
              typeof row.status === "string",
          )
          .map((row) => ({
            id: row.memory_id as string,
            path: path.join(memoryDir, row.path_rel as string),
            category: row.category as MemoryCategory,
            status: row.status as MemoryStatus,
            created: typeof row.created_at === "string" ? row.created_at : undefined,
            updated: typeof row.updated_at === "string" ? row.updated_at : undefined,
            tags: parseStringArray(row.tags_json),
            entityRef: typeof row.entity_ref === "string" ? row.entity_ref : undefined,
            preview: typeof row.preview_text === "string" ? row.preview_text : "",
          })),
      };
    }

    // No query: use SQL pagination directly
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS total FROM memory_current ${whereSql}`)
      .get(...params) as { total?: number } | undefined;
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
        ${whereSql}
        ORDER BY ${orderBySql}
        LIMIT ? OFFSET ?
      `)
      .all(...params, options.limit, options.offset) as Array<Record<string, unknown>>;

    return {
      total: typeof totalRow?.total === "number" ? totalRow.total : 0,
      memories: rows
        .filter(
          (row) =>
            typeof row.memory_id === "string" &&
            typeof row.path_rel === "string" &&
            typeof row.category === "string" &&
            typeof row.status === "string",
        )
        .map((row) => ({
          id: row.memory_id as string,
          path: path.join(memoryDir, row.path_rel as string),
          category: row.category as MemoryCategory,
          status: row.status as MemoryStatus,
          created: typeof row.created_at === "string" ? row.created_at : undefined,
          updated: typeof row.updated_at === "string" ? row.updated_at : undefined,
          tags: parseStringArray(row.tags_json),
          entityRef: typeof row.entity_ref === "string" ? row.entity_ref : undefined,
          preview: typeof row.preview_text === "string" ? row.preview_text : "",
        })),
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
