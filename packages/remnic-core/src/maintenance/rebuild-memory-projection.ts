import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import {
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
} from "./memory-governance.js";
import { loadPersistedNativeKnowledgeChunks } from "../native-knowledge.js";
import { toBackupStamp } from "./backup-stamp.js";
import type {
  MemoryFile,
  MemoryLifecycleEvent,
  MemoryProjectionCurrentState,
  MemoryStatus,
} from "../types.js";
import {
  buildLifecycleEventsForMemory,
  inferMemoryStatus,
  MEMORY_LIFECYCLE_EVENT_SORT_ORDER,
  sortMemoryLifecycleEvents,
  toMemoryPathRel,
} from "../memory-lifecycle-ledger-utils.js";
import {
  getMemoryProjectionPath,
  initializeMemoryProjectionDb,
  type ProjectedEntityMentionRow,
  type MemoryProjectionGovernanceAppliedActionRow,
  type MemoryProjectionGovernanceReviewQueueRow,
  type ProjectedNativeKnowledgeChunkRow,
  MEMORY_PROJECTION_SCHEMA_VERSION,
  memoryCurrentSelectExpressions,
  parseCurrentRow,
  readProjectedEntityMentions,
  readProjectedGovernanceRecord,
  readProjectedNativeKnowledgeChunks,
  parseTimelineRows,
} from "../memory-projection-store.js";
import {
  normalizeProjectionPreview,
  normalizeProjectionTags,
} from "../memory-projection-format.js";
import { openBetterSqlite3 } from "../runtime/better-sqlite.js";
import { commitPreparedFileAtomically } from "./atomic-file.js";

export interface RebuildMemoryProjectionOptions {
  memoryDir: string;
  defaultNamespace?: string;
  dryRun?: boolean;
  now?: Date;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface RebuildMemoryProjectionResult {
  dryRun: boolean;
  scannedMemories: number;
  currentRows: number;
  timelineRows: number;
  entityMentionRows: number;
  nativeKnowledgeRows: number;
  reviewQueueRows: number;
  outputPath: string;
  backupPath?: string;
  usedLifecycleLedger: boolean;
  scope: {
    updatedAfter: string | null;
    updatedBefore: string | null;
  };
}

export interface VerifyMemoryProjectionOptions {
  memoryDir: string;
  defaultNamespace?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface VerifyMemoryProjectionResult {
  outputPath: string;
  projectionExists: boolean;
  ok: boolean;
  expectedCurrentRows: number;
  actualCurrentRows: number;
  expectedTimelineRows: number;
  actualTimelineRows: number;
  expectedEntityMentionRows: number;
  actualEntityMentionRows: number;
  expectedNativeKnowledgeRows: number;
  actualNativeKnowledgeRows: number;
  expectedReviewQueueRows: number;
  actualReviewQueueRows: number;
  missingCurrentMemoryIds: string[];
  extraCurrentMemoryIds: string[];
  mismatchedCurrentMemoryIds: string[];
  missingTimelineEventIds: string[];
  extraTimelineEventIds: string[];
  missingEntityMentionKeys: string[];
  extraEntityMentionKeys: string[];
  mismatchedEntityMentionKeys: string[];
  missingNativeKnowledgeChunkIds: string[];
  extraNativeKnowledgeChunkIds: string[];
  mismatchedNativeKnowledgeChunkIds: string[];
  missingReviewQueueEntryIds: string[];
  extraReviewQueueEntryIds: string[];
  mismatchedReviewQueueEntryIds: string[];
  usedLifecycleLedger: boolean;
  scope: {
    updatedAfter: string | null;
    updatedBefore: string | null;
  };
}

export interface RepairMemoryProjectionOptions extends RebuildMemoryProjectionOptions {}

export interface RepairMemoryProjectionResult {
  dryRun: boolean;
  repaired: boolean;
  verify: VerifyMemoryProjectionResult;
  rebuild?: RebuildMemoryProjectionResult;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

export async function backupExistingProjection(
  memoryDir: string,
  outputPath: string,
  now: Date,
): Promise<string | undefined> {
  try {
    await stat(outputPath);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  const backupPath = path.join(
    memoryDir,
    "archive",
    "memory-projection",
    toBackupStamp(now),
    "state",
    "memory-projection.sqlite",
  );
  return backupPath;
}

function inferProjectedStatus(pathRel: string, memory: MemoryFile): MemoryStatus {
  return inferMemoryStatus(memory.frontmatter, pathRel);
}

function toCurrentStateRow(memoryDir: string, memory: MemoryFile): MemoryProjectionCurrentState {
  const pathRel = toMemoryPathRel(memoryDir, memory.path);
  return {
    memoryId: memory.frontmatter.id,
    category: memory.frontmatter.category,
    status: inferProjectedStatus(pathRel, memory),
    lifecycleState: memory.frontmatter.lifecycleState,
    path: memory.path,
    pathRel,
    created: memory.frontmatter.created,
    updated: memory.frontmatter.updated,
    archivedAt: memory.frontmatter.archivedAt,
    supersededAt: memory.frontmatter.supersededAt,
    entityRef: memory.frontmatter.entityRef,
    source: memory.frontmatter.source,
    confidence: memory.frontmatter.confidence,
    confidenceTier: memory.frontmatter.confidenceTier,
    memoryKind: memory.frontmatter.memoryKind,
    accessCount: memory.frontmatter.accessCount,
    lastAccessed: memory.frontmatter.lastAccessed,
    tags: normalizeProjectionTags(memory.frontmatter.tags),
    preview: normalizeProjectionPreview(memory.content),
  };
}

function buildEntityMentionRows(
  currentRows: MemoryProjectionCurrentState[],
): ProjectedEntityMentionRow[] {
  return currentRows.flatMap((row) => {
    const mentions: ProjectedEntityMentionRow[] = [];
    if (row.entityRef) {
      mentions.push({
        memoryId: row.memoryId,
        entityRef: row.entityRef,
        mentionSource: "frontmatter.entityRef",
        created: row.created,
        updated: row.updated,
      });
    }
    for (const tag of row.tags ?? []) {
      if (!tag.includes(":")) continue;
      mentions.push({
        memoryId: row.memoryId,
        entityRef: tag,
        mentionSource: "tag",
        created: row.created,
        updated: row.updated,
      });
    }
    return mentions;
  });
}

function buildGovernanceActionRowKey(action: {
  action: string;
  memoryId: string;
  reasonCode: string;
  originalPath: string;
  currentPath: string;
}): string {
  return [
    action.action,
    action.memoryId,
    action.reasonCode,
    action.originalPath,
    action.currentPath,
  ].join("::");
}

async function loadLatestGovernanceProjection(memoryDir: string): Promise<{
  runId: string;
  summary: unknown;
  metrics: unknown;
  reviewQueueRows: MemoryProjectionGovernanceReviewQueueRow[];
  appliedActionRows: MemoryProjectionGovernanceAppliedActionRow[];
  report: string;
} | null> {
  const runId = (await listMemoryGovernanceRuns(memoryDir))[0];
  if (!runId) return null;
  try {
    const artifact = await readMemoryGovernanceRunArtifact(memoryDir, runId);
    return {
      runId,
      summary: artifact.summary,
      metrics: artifact.metrics,
      reviewQueueRows: artifact.reviewQueue.map((entry) => ({
        runId,
        entryId: entry.entryId,
        memoryId: entry.memoryId,
        path: entry.path,
        reasonCode: entry.reasonCode,
        severity: entry.severity,
        suggestedAction: entry.suggestedAction,
        suggestedStatus: entry.suggestedStatus,
        relatedMemoryIds: [...entry.relatedMemoryIds],
      })),
      appliedActionRows: artifact.appliedActions.map((action) => ({
        runId,
        rowKey: buildGovernanceActionRowKey(action),
        action: action.action,
        memoryId: action.memoryId,
        reasonCode: action.reasonCode,
        beforeStatus: action.beforeStatus,
        afterStatus: action.afterStatus,
        originalPath: action.originalPath,
        currentPath: action.currentPath,
      })),
      report: artifact.report,
    };
  } catch {
    return null;
  }
}

function loadTimelineEvents(
  memories: MemoryFile[],
  lifecycleEvents: MemoryLifecycleEvent[],
): { events: MemoryLifecycleEvent[]; usedLifecycleLedger: boolean } {
  if (lifecycleEvents.length > 0) {
    return {
      events: sortMemoryLifecycleEvents(lifecycleEvents),
      usedLifecycleLedger: true,
    };
  }

  return {
    events: sortMemoryLifecycleEvents(memories.flatMap((memory) => buildLifecycleEventsForMemory(memory))),
    usedLifecycleLedger: false,
  };
}

function normalizeScopedIso(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid projection scope timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function normalizeProjectionScope(options: {
  updatedAfter?: string;
  updatedBefore?: string;
}): {
  updatedAfter: string | null;
  updatedBefore: string | null;
} {
  const updatedAfter = normalizeScopedIso(options.updatedAfter);
  const updatedBefore = normalizeScopedIso(options.updatedBefore);
  if (
    updatedAfter &&
    updatedBefore &&
    new Date(updatedAfter).getTime() > new Date(updatedBefore).getTime()
  ) {
    throw new Error("updatedAfter must be less than or equal to updatedBefore");
  }
  return {
    updatedAfter,
    updatedBefore,
  };
}

function hasScopedProjectionFilter(scope: {
  updatedAfter: string | null;
  updatedBefore: string | null;
}): boolean {
  return scope.updatedAfter !== null || scope.updatedBefore !== null;
}

function memoryScopeTimestamp(memory: MemoryFile): string {
  const candidate = memory.frontmatter.updated || memory.frontmatter.created;
  return candidate;
}

function isTimestampInProjectionScope(
  timestamp: string,
  scope: { updatedAfter: string | null; updatedBefore: string | null },
): boolean {
  if (!scope.updatedAfter && !scope.updatedBefore) return true;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return false;
  if (scope.updatedAfter && parsed.getTime() < new Date(scope.updatedAfter).getTime()) return false;
  if (scope.updatedBefore && parsed.getTime() >= new Date(scope.updatedBefore).getTime()) return false;
  return true;
}

function filterMemoriesForProjectionScope(
  memories: MemoryFile[],
  scope: { updatedAfter: string | null; updatedBefore: string | null },
): MemoryFile[] {
  if (!scope.updatedAfter && !scope.updatedBefore) return memories;
  return memories.filter((memory) => isTimestampInProjectionScope(memoryScopeTimestamp(memory), scope));
}

function filterCurrentStateRowsForProjectionScope(
  rows: MemoryProjectionCurrentState[],
  scope: { updatedAfter: string | null; updatedBefore: string | null },
): MemoryProjectionCurrentState[] {
  if (!scope.updatedAfter && !scope.updatedBefore) return rows;
  return rows.filter((row) => isTimestampInProjectionScope(row.updated || row.created, scope));
}

function serializeCurrentStateRow(row: MemoryProjectionCurrentState): string {
  return JSON.stringify({
    memoryId: row.memoryId,
    category: row.category,
    status: row.status,
    lifecycleState: row.lifecycleState ?? null,
    pathRel: row.pathRel,
    created: row.created,
    updated: row.updated,
    archivedAt: row.archivedAt ?? null,
    supersededAt: row.supersededAt ?? null,
    entityRef: row.entityRef ?? null,
    source: row.source,
    confidence: row.confidence,
    confidenceTier: row.confidenceTier,
    memoryKind: row.memoryKind ?? null,
    accessCount: row.accessCount ?? null,
    lastAccessed: row.lastAccessed ?? null,
    tags: row.tags ?? [],
    preview: row.preview ?? "",
  });
}

function serializeTimelineEvent(event: MemoryLifecycleEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    memoryId: event.memoryId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    actor: event.actor,
    reasonCode: event.reasonCode ?? null,
    ruleVersion: event.ruleVersion,
    relatedMemoryIds: event.relatedMemoryIds ?? [],
    before: event.before ?? null,
    after: event.after ?? null,
    correlationId: event.correlationId ?? null,
  });
}

function serializeEntityMentionRow(row: ProjectedEntityMentionRow): string {
  return JSON.stringify(row);
}

function serializeNativeKnowledgeRow(row: ProjectedNativeKnowledgeChunkRow): string {
  return JSON.stringify({
    chunkId: row.chunkId,
    sourceKind: row.sourceKind,
    sourcePath: row.sourcePath,
    title: row.title,
    startLine: row.startLine,
    endLine: row.endLine,
    namespace: row.namespace ?? null,
    privacyClass: row.privacyClass ?? null,
    derivedDate: row.derivedDate ?? null,
    sessionKey: row.sessionKey ?? null,
    workflowKey: row.workflowKey ?? null,
    author: row.author ?? null,
    agent: row.agent ?? null,
    sourceHash: row.sourceHash ?? null,
    preview: row.preview,
  });
}

function serializeGovernanceReviewQueueRow(
  row: MemoryProjectionGovernanceReviewQueueRow,
): string {
  return JSON.stringify({
    runId: row.runId,
    entryId: row.entryId,
    memoryId: row.memoryId,
    path: row.path,
    reasonCode: row.reasonCode,
    severity: row.severity,
    suggestedAction: row.suggestedAction,
    suggestedStatus: row.suggestedStatus ?? null,
    relatedMemoryIds: row.relatedMemoryIds,
  });
}

async function loadAuthoritativeProjectionSnapshot(options: {
  memoryDir: string;
  defaultNamespace?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}): Promise<{
  allMemories: MemoryFile[];
  currentRows: MemoryProjectionCurrentState[];
  timelineRows: MemoryLifecycleEvent[];
  scopedCurrentRows: MemoryProjectionCurrentState[];
  scopedTimelineRows: MemoryLifecycleEvent[];
  entityMentionRows: ProjectedEntityMentionRow[];
  scopedEntityMentionRows: ProjectedEntityMentionRow[];
  nativeKnowledgeRows: ProjectedNativeKnowledgeChunkRow[];
  governance:
    | {
      runId: string;
      summary: unknown;
      metrics: unknown;
      reviewQueueRows: MemoryProjectionGovernanceReviewQueueRow[];
      appliedActionRows: MemoryProjectionGovernanceAppliedActionRow[];
      report: string;
    }
    | null;
  usedLifecycleLedger: boolean;
  scope: {
    updatedAfter: string | null;
    updatedBefore: string | null;
  };
}> {
  const storage = new StorageManager(options.memoryDir);
  // Force a fresh disk read — projection verify/rebuild must see the true
  // on-disk state, not a potentially stale in-process cache.
  storage.invalidateAllMemoriesCacheForDir();
  const allMemories = [
    ...await storage.readAllMemories(),
    ...await storage.readAllColdMemories(),
    ...await storage.readArchivedMemories(),
  ]
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  const lifecycleEvents = await storage.readAllMemoryLifecycleEvents();
  const { events, usedLifecycleLedger } = loadTimelineEvents(allMemories, lifecycleEvents);
  const currentRows = allMemories.map((memory) => toCurrentStateRow(options.memoryDir, memory));
  const scope = normalizeProjectionScope(options);
  const scopedMemories = filterMemoriesForProjectionScope(allMemories, scope);
  const scopedMemoryIds = new Set(scopedMemories.map((memory) => memory.frontmatter.id));
  const nativeKnowledgeRows = await loadPersistedNativeKnowledgeChunks({
    memoryDir: options.memoryDir,
    defaultNamespace: options.defaultNamespace ?? "default",
  }).then((rows) => rows.map((row) => ({
    chunkId: row.chunkId,
    sourceKind: row.sourceKind,
    sourcePath: row.sourcePath,
    title: row.title,
    startLine: row.startLine,
    endLine: row.endLine,
    namespace: row.namespace ?? options.defaultNamespace ?? "default",
    privacyClass: row.privacyClass,
    derivedDate: row.derivedDate,
    sessionKey: row.sessionKey,
    workflowKey: row.workflowKey,
    author: row.author,
    agent: row.agent,
    sourceHash: row.sourceHash,
    preview: normalizeProjectionPreview(row.content),
  })));
  const governance = await loadLatestGovernanceProjection(options.memoryDir);
  const entityMentionRows = buildEntityMentionRows(currentRows);

  return {
    allMemories,
    currentRows,
    timelineRows: events,
    scopedCurrentRows: currentRows.filter((row) => scopedMemoryIds.has(row.memoryId)),
    scopedTimelineRows: events.filter((event) => scopedMemoryIds.has(event.memoryId)),
    entityMentionRows,
    scopedEntityMentionRows: entityMentionRows.filter((row) => scopedMemoryIds.has(row.memoryId)),
    nativeKnowledgeRows,
    governance,
    usedLifecycleLedger,
    scope,
  };
}

function readProjectedCurrentRows(
  memoryDir: string,
): { projectionExists: boolean; rows: MemoryProjectionCurrentState[] } {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    const db = openBetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    try {
      const selectExpressions = memoryCurrentSelectExpressions(db);
      const rows = db.prepare(`
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
          ${selectExpressions.tagsJson},
          ${selectExpressions.previewText}
        FROM memory_current
      `).all() as Array<Record<string, unknown>>;

      return {
        projectionExists: true,
        rows: rows
          .map((row) => parseCurrentRow(memoryDir, row))
          .filter((row): row is MemoryProjectionCurrentState => row !== null),
      };
    } finally {
      db.close();
    }
  } catch {
    return { projectionExists: false, rows: [] };
  }
}

function readProjectedTimelineRows(
  memoryDir: string,
): { projectionExists: boolean; rows: MemoryLifecycleEvent[] } {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    const db = openBetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        SELECT
          event_id,
          memory_id,
          event_type,
          timestamp,
          actor,
          reason_code,
          rule_version,
          related_memory_ids_json,
          before_json,
          after_json,
          correlation_id
        FROM memory_timeline
      `).all() as Array<Record<string, unknown>>;

      return {
        projectionExists: true,
        rows: parseTimelineRows(rows),
      };
    } finally {
      db.close();
    }
  } catch {
    return { projectionExists: false, rows: [] };
  }
}

function readProjectedEntityMentionRows(
  memoryDir: string,
): { projectionExists: boolean; rows: ProjectedEntityMentionRow[] } {
  const rows = readProjectedEntityMentions(memoryDir);
  if (rows === null) return { projectionExists: false, rows: [] };
  return { projectionExists: true, rows };
}

function readProjectedNativeKnowledgeRows(
  memoryDir: string,
): { projectionExists: boolean; rows: ProjectedNativeKnowledgeChunkRow[] } {
  const rows = readProjectedNativeKnowledgeChunks(memoryDir);
  if (rows === null) return { projectionExists: false, rows: [] };
  return { projectionExists: true, rows };
}

function readProjectedGovernanceRows(memoryDir: string): {
  projectionExists: boolean;
  runId: string | null;
  summary: unknown;
  metrics: unknown;
  reviewQueueRows: MemoryProjectionGovernanceReviewQueueRow[];
  appliedActionRows: MemoryProjectionGovernanceAppliedActionRow[];
  report: string;
} {
  const record = readProjectedGovernanceRecord(memoryDir);
  if (record === null) {
    return {
      projectionExists: false,
      runId: null,
      summary: undefined,
      metrics: undefined,
      reviewQueueRows: [],
      appliedActionRows: [],
      report: "",
    };
  }
  return {
    projectionExists: true,
    runId: record.runId,
    summary: record.summary,
    metrics: record.metrics,
    reviewQueueRows: record.reviewQueueRows,
    appliedActionRows: record.appliedActionRows,
    report: record.report,
  };
}

function writeProjectionDb(
  dbPath: string,
  nowIso: string,
  currentRows: MemoryProjectionCurrentState[],
  timelineRows: MemoryLifecycleEvent[],
  entityMentionRows: ProjectedEntityMentionRow[],
  nativeKnowledgeRows: ProjectedNativeKnowledgeChunkRow[],
  governance: Awaited<ReturnType<typeof loadLatestGovernanceProjection>>,
  usedLifecycleLedger: boolean,
): void {
  const db = openBetterSqlite3(dbPath);
  try {
    initializeMemoryProjectionDb(db);

    const insertMeta = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    insertMeta.run("schemaVersion", String(MEMORY_PROJECTION_SCHEMA_VERSION));
    insertMeta.run("rebuiltAt", nowIso);
    insertMeta.run("usedLifecycleLedger", usedLifecycleLedger ? "true" : "false");
    insertMeta.run("latestGovernanceRunId", governance?.runId ?? "");

    const insertCurrent = db.prepare(`
      INSERT INTO memory_current (
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
        tags_json,
        preview_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTimeline = db.prepare(`
      INSERT INTO memory_timeline (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEntityMention = db.prepare(`
      INSERT INTO memory_entity_mentions (
        memory_id,
        entity_ref,
        mention_source,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const insertNativeKnowledge = db.prepare(`
      INSERT INTO native_knowledge_chunks (
        chunk_id,
        source_kind,
        source_path,
        title,
        start_line,
        end_line,
        namespace,
        privacy_class,
        derived_date,
        session_key,
        workflow_key,
        author,
        agent,
        source_hash,
        preview_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertGovernanceReviewQueue = db.prepare(`
      INSERT INTO memory_review_queue (
        entry_id,
        run_id,
        memory_id,
        path,
        reason_code,
        severity,
        suggested_action,
        suggested_status,
        related_memory_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertGovernanceAppliedAction = db.prepare(`
      INSERT INTO memory_review_actions (
        row_key,
        run_id,
        action,
        memory_id,
        reason_code,
        before_status,
        after_status,
        original_path,
        current_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertGovernanceRun = db.prepare(`
      INSERT INTO memory_review_runs (
        run_id,
        created_at,
        mode,
        summary_json,
        metrics_json,
        applied_actions_json,
        report_markdown
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const writeTx = db.transaction(() => {
      for (const row of currentRows) {
        insertCurrent.run(
          row.memoryId,
          row.category,
          row.status,
          row.lifecycleState ?? null,
          row.pathRel,
          row.created,
          row.updated,
          row.archivedAt ?? null,
          row.supersededAt ?? null,
          row.entityRef ?? null,
          row.source,
          row.confidence,
          row.confidenceTier,
          row.memoryKind ?? null,
          row.accessCount ?? null,
          row.lastAccessed ?? null,
          JSON.stringify(row.tags ?? []),
          row.preview ?? "",
        );
      }

      for (const event of timelineRows) {
        insertTimeline.run(
          event.eventId,
          event.memoryId,
          event.eventType,
          event.timestamp,
          MEMORY_LIFECYCLE_EVENT_SORT_ORDER[event.eventType],
          event.actor,
          event.reasonCode ?? null,
          event.ruleVersion,
          JSON.stringify(event.relatedMemoryIds ?? []),
          event.before ? JSON.stringify(event.before) : null,
          event.after ? JSON.stringify(event.after) : null,
          event.correlationId ?? null,
        );
      }

      for (const row of entityMentionRows) {
        insertEntityMention.run(
          row.memoryId,
          row.entityRef,
          row.mentionSource,
          row.created,
          row.updated,
        );
      }

      for (const row of nativeKnowledgeRows) {
        insertNativeKnowledge.run(
          row.chunkId,
          row.sourceKind,
          row.sourcePath,
          row.title,
          row.startLine,
          row.endLine,
          row.namespace ?? null,
          row.privacyClass ?? null,
          row.derivedDate ?? null,
          row.sessionKey ?? null,
          row.workflowKey ?? null,
          row.author ?? null,
          row.agent ?? null,
          row.sourceHash ?? null,
          row.preview,
        );
      }

      for (const row of governance?.reviewQueueRows ?? []) {
        insertGovernanceReviewQueue.run(
          row.entryId,
          row.runId,
          row.memoryId,
          row.path,
          row.reasonCode,
          row.severity,
          row.suggestedAction,
          row.suggestedStatus ?? null,
          JSON.stringify(row.relatedMemoryIds),
        );
      }

      for (const row of governance?.appliedActionRows ?? []) {
        insertGovernanceAppliedAction.run(
          row.rowKey,
          row.runId,
          row.action,
          row.memoryId,
          row.reasonCode,
          row.beforeStatus,
          row.afterStatus ?? null,
          row.originalPath,
          row.currentPath,
        );
      }

      if (governance) {
        const createdAt =
          typeof (governance.summary as { createdAt?: unknown } | undefined)?.createdAt === "string"
            ? (governance.summary as { createdAt: string }).createdAt
            : nowIso;
        const mode =
          typeof (governance.summary as { mode?: unknown } | undefined)?.mode === "string"
            ? (governance.summary as { mode: string }).mode
            : "shadow";
        insertGovernanceRun.run(
          governance.runId,
          createdAt,
          mode,
          JSON.stringify(governance.summary ?? null),
          JSON.stringify(governance.metrics ?? null),
          JSON.stringify(
            (governance.appliedActionRows ?? []).map((row) => ({
              action: row.action,
              memoryId: row.memoryId,
              reasonCode: row.reasonCode,
              beforeStatus: row.beforeStatus,
              afterStatus: row.afterStatus,
              originalPath: row.originalPath,
              currentPath: row.currentPath,
            })),
          ),
          governance.report,
        );
      }
    });

    writeTx();
  } finally {
    db.close();
  }
}

function mergeScopedCurrentRows(
  existingRows: MemoryProjectionCurrentState[],
  replacementRows: MemoryProjectionCurrentState[],
  scopedMemoryIds: Set<string>,
): MemoryProjectionCurrentState[] {
  return [...existingRows.filter((row) => !scopedMemoryIds.has(row.memoryId)), ...replacementRows]
    .sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}

function mergeScopedTimelineRows(
  existingRows: MemoryLifecycleEvent[],
  replacementRows: MemoryLifecycleEvent[],
  scopedMemoryIds: Set<string>,
): MemoryLifecycleEvent[] {
  return sortMemoryLifecycleEvents([
    ...existingRows.filter((event) => !scopedMemoryIds.has(event.memoryId)),
    ...replacementRows,
  ]);
}

function mergeScopedEntityMentionRows(
  existingRows: ProjectedEntityMentionRow[],
  replacementRows: ProjectedEntityMentionRow[],
  scopedMemoryIds: Set<string>,
): ProjectedEntityMentionRow[] {
  return [
    ...existingRows.filter((row) => !scopedMemoryIds.has(row.memoryId)),
    ...replacementRows,
  ].sort((left, right) =>
    [left.entityRef, left.memoryId, left.mentionSource].join("::").localeCompare(
      [right.entityRef, right.memoryId, right.mentionSource].join("::"),
    )
  );
}

export async function rebuildMemoryProjection(
  options: RebuildMemoryProjectionOptions,
): Promise<RebuildMemoryProjectionResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const outputPath = getMemoryProjectionPath(options.memoryDir);
  const snapshot = await loadAuthoritativeProjectionSnapshot(options);

  let backupPath: string | undefined;
  if (!dryRun) {
    let nextCurrentRows = snapshot.currentRows;
    let nextTimelineRows = snapshot.timelineRows;
    let nextEntityMentionRows = snapshot.entityMentionRows;
    let nextNativeKnowledgeRows = snapshot.nativeKnowledgeRows;
    let nextGovernance = snapshot.governance;
    if (hasScopedProjectionFilter(snapshot.scope)) {
      nextCurrentRows = snapshot.scopedCurrentRows;
      nextTimelineRows = snapshot.scopedTimelineRows;
      nextEntityMentionRows = snapshot.scopedEntityMentionRows;
      const projectedCurrent = readProjectedCurrentRows(options.memoryDir);
      const projectedTimeline = readProjectedTimelineRows(options.memoryDir);
      const projectedEntityMentions = readProjectedEntityMentionRows(options.memoryDir);
      const projectedNativeKnowledge = readProjectedNativeKnowledgeRows(options.memoryDir);
      const projectedGovernance = readProjectedGovernanceRows(options.memoryDir);
      if (projectedCurrent.projectionExists && projectedTimeline.projectionExists) {
        const actualScopedCurrentRows = filterCurrentStateRowsForProjectionScope(
          projectedCurrent.rows,
          snapshot.scope,
        );
        const scopedMemoryIds = new Set([
          ...snapshot.scopedCurrentRows.map((row) => row.memoryId),
          ...snapshot.scopedTimelineRows.map((event) => event.memoryId),
          ...actualScopedCurrentRows.map((row) => row.memoryId),
        ]);
        nextCurrentRows = mergeScopedCurrentRows(
          projectedCurrent.rows,
          snapshot.scopedCurrentRows,
          scopedMemoryIds,
        );
        nextTimelineRows = mergeScopedTimelineRows(
          projectedTimeline.rows,
          snapshot.scopedTimelineRows,
          scopedMemoryIds,
        );
        nextEntityMentionRows = mergeScopedEntityMentionRows(
          projectedEntityMentions.rows,
          snapshot.scopedEntityMentionRows,
          scopedMemoryIds,
        );
      }
      if (projectedNativeKnowledge.projectionExists) {
        // Native knowledge rows are always loaded from the full persisted sync state,
        // so scoped memory rebuilds should publish the fresh snapshot instead of
        // pinning the projection to stale previously projected rows.
        nextNativeKnowledgeRows = snapshot.nativeKnowledgeRows;
      }
      if (projectedGovernance.projectionExists && projectedGovernance.runId) {
        // Governance rows are also sourced from standalone artifact snapshots, so
        // scoped memory rebuilds should keep the latest governance artifact data
        // instead of restoring whatever happened to be in the prior projection.
        nextGovernance = snapshot.governance;
      }
    }

    const tempPath = `${outputPath}.tmp`;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await rm(tempPath, { force: true });
    writeProjectionDb(
      tempPath,
      now.toISOString(),
      nextCurrentRows,
      nextTimelineRows,
      nextEntityMentionRows,
      nextNativeKnowledgeRows,
      nextGovernance,
      snapshot.usedLifecycleLedger,
    );
    backupPath = await backupExistingProjection(options.memoryDir, outputPath, now);
    backupPath = await commitPreparedFileAtomically(tempPath, outputPath, backupPath);
  }

  return {
    dryRun,
    scannedMemories: snapshot.allMemories.length,
    currentRows: snapshot.scopedCurrentRows.length,
    timelineRows: snapshot.scopedTimelineRows.length,
    entityMentionRows: snapshot.scopedEntityMentionRows.length,
    nativeKnowledgeRows: snapshot.nativeKnowledgeRows.length,
    reviewQueueRows: snapshot.governance?.reviewQueueRows.length ?? 0,
    outputPath,
    backupPath,
    usedLifecycleLedger: snapshot.usedLifecycleLedger,
    scope: snapshot.scope,
  };
}

export async function verifyMemoryProjection(
  options: VerifyMemoryProjectionOptions,
): Promise<VerifyMemoryProjectionResult> {
  const outputPath = getMemoryProjectionPath(options.memoryDir);
  const snapshot = await loadAuthoritativeProjectionSnapshot(options);
  const projectedCurrent = readProjectedCurrentRows(options.memoryDir);
  const projectedTimeline = readProjectedTimelineRows(options.memoryDir);
  const projectedEntityMentions = readProjectedEntityMentionRows(options.memoryDir);
  const projectedNativeKnowledge = readProjectedNativeKnowledgeRows(options.memoryDir);
  const projectedGovernance = readProjectedGovernanceRows(options.memoryDir);
  const projectionExists = projectedCurrent.projectionExists
    || projectedTimeline.projectionExists
    || projectedEntityMentions.projectionExists
    || projectedNativeKnowledge.projectionExists
    || projectedGovernance.projectionExists;

  const actualScopedCurrentRows = filterCurrentStateRowsForProjectionScope(projectedCurrent.rows, snapshot.scope);
  const expectedCurrentById = new Map(
    snapshot.scopedCurrentRows.map((row) => [row.memoryId, serializeCurrentStateRow(row)]),
  );
  const actualCurrentById = new Map(
    actualScopedCurrentRows.map((row) => [row.memoryId, serializeCurrentStateRow(row)]),
  );

  const missingCurrentMemoryIds = [...expectedCurrentById.keys()]
    .filter((memoryId) => !actualCurrentById.has(memoryId))
    .sort();
  const extraCurrentMemoryIds = [...actualCurrentById.keys()]
    .filter((memoryId) => !expectedCurrentById.has(memoryId))
    .sort();
  const mismatchedCurrentMemoryIds = [...expectedCurrentById.keys()]
    .filter((memoryId) =>
      actualCurrentById.has(memoryId) && actualCurrentById.get(memoryId) !== expectedCurrentById.get(memoryId)
    )
    .sort();

  const selectedMemoryIds = new Set([
    ...snapshot.scopedCurrentRows.map((row) => row.memoryId),
    ...actualScopedCurrentRows.map((row) => row.memoryId),
  ]);
  const expectedTimelineById = new Map(
    snapshot.scopedTimelineRows.map((event) => [event.eventId, serializeTimelineEvent(event)]),
  );
  const actualTimelineRows = projectedTimeline.rows.filter((event) => selectedMemoryIds.has(event.memoryId));
  const actualTimelineById = new Map(
    actualTimelineRows.map((event) => [event.eventId, serializeTimelineEvent(event)]),
  );
  const missingTimelineEventIds = [...expectedTimelineById.keys()]
    .filter((eventId) => !actualTimelineById.has(eventId))
    .sort();
  const extraTimelineEventIds = [...actualTimelineById.keys()]
    .filter((eventId) => !expectedTimelineById.has(eventId))
    .sort();

  const expectedEntityMentionsByKey = new Map(
    snapshot.scopedEntityMentionRows.map((row) => [
      `${row.memoryId}::${row.entityRef}::${row.mentionSource}`,
      serializeEntityMentionRow(row),
    ]),
  );
  const actualScopedEntityMentionRows = projectedEntityMentions.rows.filter((row) => selectedMemoryIds.has(row.memoryId));
  const actualEntityMentionsByKey = new Map(
    actualScopedEntityMentionRows.map((row) => [
      `${row.memoryId}::${row.entityRef}::${row.mentionSource}`,
      serializeEntityMentionRow(row),
    ]),
  );
  const missingEntityMentionKeys = [...expectedEntityMentionsByKey.keys()]
    .filter((key) => !actualEntityMentionsByKey.has(key))
    .sort();
  const extraEntityMentionKeys = [...actualEntityMentionsByKey.keys()]
    .filter((key) => !expectedEntityMentionsByKey.has(key))
    .sort();
  const mismatchedEntityMentionKeys = [...expectedEntityMentionsByKey.keys()]
    .filter((key) =>
      actualEntityMentionsByKey.has(key) && actualEntityMentionsByKey.get(key) !== expectedEntityMentionsByKey.get(key)
    )
    .sort();

  const expectedNativeKnowledgeById = new Map(
    snapshot.nativeKnowledgeRows.map((row) => [row.chunkId, serializeNativeKnowledgeRow(row)]),
  );
  const actualNativeKnowledgeById = new Map(
    projectedNativeKnowledge.rows.map((row) => [row.chunkId, serializeNativeKnowledgeRow(row)]),
  );
  const missingNativeKnowledgeChunkIds = [...expectedNativeKnowledgeById.keys()]
    .filter((chunkId) => !actualNativeKnowledgeById.has(chunkId))
    .sort();
  const extraNativeKnowledgeChunkIds = [...actualNativeKnowledgeById.keys()]
    .filter((chunkId) => !expectedNativeKnowledgeById.has(chunkId))
    .sort();
  const mismatchedNativeKnowledgeChunkIds = [...expectedNativeKnowledgeById.keys()]
    .filter((chunkId) =>
      actualNativeKnowledgeById.has(chunkId) && actualNativeKnowledgeById.get(chunkId) !== expectedNativeKnowledgeById.get(chunkId)
    )
    .sort();

  const expectedReviewQueueById = new Map(
    (snapshot.governance?.reviewQueueRows ?? []).map((row) => [
      `${row.runId}::${row.entryId}`,
      serializeGovernanceReviewQueueRow(row),
    ]),
  );
  const actualReviewQueueById = new Map(
    projectedGovernance.reviewQueueRows.map((row) => [
      `${row.runId}::${row.entryId}`,
      serializeGovernanceReviewQueueRow(row),
    ]),
  );
  const missingReviewQueueEntryIds = [...expectedReviewQueueById.keys()]
    .filter((entryId) => !actualReviewQueueById.has(entryId))
    .sort();
  const extraReviewQueueEntryIds = [...actualReviewQueueById.keys()]
    .filter((entryId) => !expectedReviewQueueById.has(entryId))
    .sort();
  const mismatchedReviewQueueEntryIds = [...expectedReviewQueueById.keys()]
    .filter((entryId) =>
      actualReviewQueueById.has(entryId) && actualReviewQueueById.get(entryId) !== expectedReviewQueueById.get(entryId)
    )
    .sort();

  return {
    outputPath,
    projectionExists,
    ok:
      projectionExists &&
      missingCurrentMemoryIds.length === 0 &&
      extraCurrentMemoryIds.length === 0 &&
      mismatchedCurrentMemoryIds.length === 0 &&
      missingTimelineEventIds.length === 0 &&
      extraTimelineEventIds.length === 0 &&
      missingEntityMentionKeys.length === 0 &&
      extraEntityMentionKeys.length === 0 &&
      mismatchedEntityMentionKeys.length === 0 &&
      missingNativeKnowledgeChunkIds.length === 0 &&
      extraNativeKnowledgeChunkIds.length === 0 &&
      mismatchedNativeKnowledgeChunkIds.length === 0 &&
      missingReviewQueueEntryIds.length === 0 &&
      extraReviewQueueEntryIds.length === 0 &&
      mismatchedReviewQueueEntryIds.length === 0,
    expectedCurrentRows: snapshot.scopedCurrentRows.length,
    actualCurrentRows: actualScopedCurrentRows.length,
    expectedTimelineRows: snapshot.scopedTimelineRows.length,
    actualTimelineRows: actualTimelineRows.length,
    expectedEntityMentionRows: snapshot.scopedEntityMentionRows.length,
    actualEntityMentionRows: actualScopedEntityMentionRows.length,
    expectedNativeKnowledgeRows: snapshot.nativeKnowledgeRows.length,
    actualNativeKnowledgeRows: projectedNativeKnowledge.rows.length,
    expectedReviewQueueRows: snapshot.governance?.reviewQueueRows.length ?? 0,
    actualReviewQueueRows: projectedGovernance.reviewQueueRows.length,
    missingCurrentMemoryIds,
    extraCurrentMemoryIds,
    mismatchedCurrentMemoryIds,
    missingTimelineEventIds,
    extraTimelineEventIds,
    missingEntityMentionKeys,
    extraEntityMentionKeys,
    mismatchedEntityMentionKeys,
    missingNativeKnowledgeChunkIds,
    extraNativeKnowledgeChunkIds,
    mismatchedNativeKnowledgeChunkIds,
    missingReviewQueueEntryIds,
    extraReviewQueueEntryIds,
    mismatchedReviewQueueEntryIds,
    usedLifecycleLedger: snapshot.usedLifecycleLedger,
    scope: snapshot.scope,
  };
}

export async function repairMemoryProjection(
  options: RepairMemoryProjectionOptions,
): Promise<RepairMemoryProjectionResult> {
  const dryRun = options.dryRun !== false;
  const verify = await verifyMemoryProjection(options);
  if (verify.ok) {
    return {
      dryRun,
      repaired: false,
      verify,
    };
  }
  if (dryRun) {
    return {
      dryRun: true,
      repaired: false,
      verify,
    };
  }

  const rebuild = await rebuildMemoryProjection({
    ...options,
    dryRun: false,
  });
  const verified = await verifyMemoryProjection(options);
  return {
    dryRun: false,
    repaired: verified.ok,
    verify: verified,
    rebuild,
  };
}
