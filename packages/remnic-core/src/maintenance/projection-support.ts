/**
 * Projection maintenance support (issue #2119) — helpers shared by the
 * scheduled projection rebuild, the CLI rebuild, and the ledger rebuild.
 * Lives beside the rebuild ops so the at-ceiling store/rebuild modules stay
 * within their structural ratchets.
 */

import path from "node:path";
import {
  openProjectionReadonly,
  readProjectedEntityMentions,
  readProjectedGovernanceRecord,
  readProjectedNativeKnowledgeChunks,
  type MemoryProjectionGovernanceAppliedActionRow,
  type MemoryProjectionGovernanceReviewQueueRow,
  type ProjectedEntityMentionRow,
  type ProjectedNativeKnowledgeChunkRow,
} from "../memory-projection-store.js";
import {
  isFrontmatterDerivedLifecycleEventType,
  memoryLifecycleEventProjectionIdentity,
} from "../memory-lifecycle-ledger-utils.js";
import type { MemoryLifecycleEvent } from "../types.js";
import type { BetterSqlite3Database } from "../runtime/better-sqlite.js";

/** Read the projection meta rebuiltAt timestamp; null when absent/unopenable. */
export function readProjectionRebuiltAt(memoryDir: string): string | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'rebuiltAt'").get() as
      | { value?: unknown }
      | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Format projection age description string for fallback warning telemetry. */
export function formatProjectionAge(rebuiltAt: string | null): string {
  if (!rebuiltAt) return "projection never rebuilt";
  const ageMs = Date.now() - Date.parse(rebuiltAt);
  if (!Number.isFinite(ageMs)) return `projection rebuiltAt=${rebuiltAt}`;
  const ageMin = Math.max(0, Math.round(ageMs / 60_000));
  const age = ageMin >= 120 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
  return `projection ${age} stale, last rebuilt ${rebuiltAt}`;
}

export interface ProjectionLifecycleLedgerHighWater {
  eventCount: number;
  sourceEventCount: number;
}

function readProjectionHighWaterFromDb(
  db: BetterSqlite3Database,
): ProjectionLifecycleLedgerHighWater | null {
  const sourceRow = db.prepare(
    "SELECT value FROM meta WHERE key = 'sourceLifecycleLedgerEventCount'",
  ).get() as { value?: unknown } | undefined;
  const projectedRow = db.prepare(
    "SELECT value FROM meta WHERE key = 'projectedLifecycleLedgerEventCount'",
  ).get() as { value?: unknown } | undefined;
  if (
    typeof sourceRow?.value !== "string"
    || !/^\d+$/.test(sourceRow.value)
    || typeof projectedRow?.value !== "string"
    || !/^\d+$/.test(projectedRow.value)
  ) return null;
  const sourceEventCount = Number(sourceRow.value);
  const eventCount = Number(projectedRow.value);
  if (!Number.isSafeInteger(sourceEventCount) || !Number.isSafeInteger(eventCount)) return null;
  return { eventCount, sourceEventCount };
}

export function readProjectionLifecycleLedgerHighWater(
  memoryDir: string,
): ProjectionLifecycleLedgerHighWater | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;
  try {
    return readProjectionHighWaterFromDb(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export interface ProjectionLifecycleLedgerLagTracker {
  highWater: ProjectionLifecycleLedgerHighWater;
  record(event: MemoryLifecycleEvent): { unique: boolean; projected: boolean };
  close(): void;
}

export function openProjectionLifecycleLedgerLagTracker(
  memoryDir: string,
): ProjectionLifecycleLedgerLagTracker | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;
  try {
    const highWater = readProjectionHighWaterFromDb(db);
    if (!highWater) {
      db.close();
      return null;
    }
    db.pragma("temp_store = FILE");
    db.exec(`
      CREATE TEMP TABLE projection_lag_current_identity (
        identity TEXT PRIMARY KEY
      ) WITHOUT ROWID;
    `);
    db.pragma("temp.cache_size = -1024");
    const insertCurrent = db.prepare(
      "INSERT OR IGNORE INTO projection_lag_current_identity(identity) VALUES (?)",
    );
    const findProjectedEvent = db.prepare(
      "SELECT 1 FROM memory_timeline WHERE event_id = ? LIMIT 1",
    );
    const findProjectedFrontmatterEvent = db.prepare(`
      SELECT 1
      FROM memory_timeline
      WHERE memory_id = ? AND event_type = ? AND timestamp = ?
      LIMIT 1
    `);
    return {
      highWater,
      record(event) {
        if (!event.memoryId.trim()) return { unique: false, projected: false };
        const identity = memoryLifecycleEventProjectionIdentity(event);
        const inserted = insertCurrent.run(identity);
        if (inserted.changes === 0) return { unique: false, projected: false };
        const projected = isFrontmatterDerivedLifecycleEventType(event.eventType)
          ? findProjectedFrontmatterEvent.get(event.memoryId, event.eventType, event.timestamp)
          : findProjectedEvent.get(event.eventId);
        return { unique: true, projected: projected !== undefined };
      },
      close: () => db.close(),
    };
  } catch {
    db.close();
    return null;
  }
}
/** Write the high-water ledger marker counts to projection meta store. */
export function writeProjectionMetaHighWater(
  insertMeta: { run: (key: string, value: string) => void },
  sourceLifecycleLedgerEventCount: number,
  timelineRows: MemoryLifecycleEvent[],
): void {
  insertMeta.run("sourceLifecycleLedgerEventCount", String(sourceLifecycleLedgerEventCount));
  insertMeta.run(
    "projectedLifecycleLedgerEventCount",
    String(new Set(timelineRows.map(memoryLifecycleEventProjectionIdentity)).size),
  );
}

export function readProjectedEntityMentionRows(
  memoryDir: string,
): { projectionExists: boolean; rows: ProjectedEntityMentionRow[] } {
  const rows = readProjectedEntityMentions(memoryDir);
  if (rows === null) return { projectionExists: false, rows: [] };
  return { projectionExists: true, rows };
}

export function readProjectedNativeKnowledgeRows(
  memoryDir: string,
): { projectionExists: boolean; rows: ProjectedNativeKnowledgeChunkRow[] } {
  const rows = readProjectedNativeKnowledgeChunks(memoryDir);
  if (rows === null) return { projectionExists: false, rows: [] };
  return { projectionExists: true, rows };
}

export function readProjectedGovernanceRows(memoryDir: string): {
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

/**
 * Assert an optionally injected storage (e.g. the daemon's live unlocked
 * secure-store instance) is rooted at `memoryDir`, and hand it back. Shared
 * by the projection and lifecycle-ledger rebuilds so the containment guard
 * cannot drift between them; callers construct their own StorageManager when
 * nothing was injected (keeps this module off the direct-storage-import
 * ratchet, issue #1533).
 */
export function assertInjectedStorageRooted<T extends { dir: string }>(
  label: string,
  memoryDir: string,
  injected: T | undefined,
): T | undefined {
  if (injected && path.resolve(injected.dir) !== path.resolve(memoryDir)) {
    throw new Error(
      `${label}: storage.dir (${injected.dir}) must match memoryDir (${memoryDir})`,
    );
  }
  return injected;
}

export interface SkippedDuplicateMemory {
  memoryId: string;
  keptPath: string;
  skippedPath: string;
}

export interface SkippedBlankIdMemory {
  path: string;
}
export interface SkippedDuplicateTimelineEvent {
  eventId: string;
  keptPath: string;
  skippedPath: string;
}

export interface SkippedBlankIdTimelineEvent {
  eventId: string;
  path: string;
}
