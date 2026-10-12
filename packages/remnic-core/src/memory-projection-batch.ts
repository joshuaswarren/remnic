import type { MemoryProjectionCurrentState } from "./types.js";
import {
  memoryCurrentSelectExpressions,
  openProjectionReadonly,
  parseCurrentRow,
} from "./memory-projection-store.js";

export interface ProjectedMemoryStateBatch {
  states: Map<string, MemoryProjectionCurrentState>;
  /** Meta `rebuiltAt`; null when the projection never recorded one. */
  rebuiltAt: string | null;
  /**
   * True only when the writer recorded that `memory_current` covers every active
   * memory (an unscoped rebuild). Projections written before this flag existed,
   * and scoped rebuilds, read as false.
   */
  complete: boolean;
}

/**
 * Read many current-state rows over ONE readonly connection, plus the meta the
 * recall path needs to decide whether the index can be trusted. Ids absent from
 * `memory_current` are simply missing from the map. Null means the projection
 * could not be opened or read.
 */
export function readProjectedMemoryStates(
  memoryDir: string,
  memoryIds: Iterable<string>,
): ProjectedMemoryStateBatch | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;
  try {
    const currentSelect = memoryCurrentSelectExpressions(db);
    const select = db.prepare(
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
          ${currentSelect.previewText},
          ${currentSelect.privateRecord}
        FROM memory_current
        WHERE memory_id = ?
      `,
    );
    const states = new Map<string, MemoryProjectionCurrentState>();
    for (const memoryId of memoryIds) {
      const state = parseCurrentRow(memoryDir, select.get(memoryId) as Record<string, unknown> | undefined);
      if (state) states.set(memoryId, state);
    }
    const meta = new Map<string, unknown>(
      (db.prepare("SELECT key, value FROM meta WHERE key IN ('rebuiltAt', 'complete')").all() as Array<{
        key: string;
        value: unknown;
      }>).map((row) => [row.key, row.value]),
    );
    const rebuiltAt = meta.get("rebuiltAt");
    return {
      states,
      rebuiltAt: typeof rebuiltAt === "string" ? rebuiltAt : null,
      complete: meta.get("complete") === "true",
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
