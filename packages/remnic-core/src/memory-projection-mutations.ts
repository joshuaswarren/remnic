import { lstat, realpath } from "node:fs/promises";
import { isErrnoCode } from "./utils/errno.js";
import { assertPathInsideRoot } from "./utils/path-containment.js";
import { getMemoryProjectionPath, initializeMemoryProjectionDb } from "./memory-projection-store.js";
import { type BetterSqlite3Database, openBetterSqlite3 } from "./runtime/better-sqlite.js";

const PROJECTION_WRITE_BUSY_TIMEOUT_MS = 100;
const PROJECTION_WRITE_RETRY_COUNT = 4;
const PROJECTION_WRITE_RETRY_DELAY_MS = 100;

function isSqliteBusyError(error: unknown): boolean {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) messages.push(current.message);
    if (!("cause" in current)) break;
    current = current.cause;
  }
  const lower = messages.join("\n").toLowerCase();
  return lower.includes("database is locked") || lower.includes("sqlite_busy");
}

async function validateProjectionPath(
  memoryDir: string,
  projectionPath: string,
): Promise<boolean> {
  let projectionStat;
  try {
    projectionStat = await lstat(projectionPath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
  if (projectionStat.isSymbolicLink() || !projectionStat.isFile()) {
    throw new Error(`Refusing memory projection rewrite through unsafe database path: ${projectionPath}.`);
  }
  const [memoryRoot, projectionReal] = await Promise.all([
    realpath(memoryDir),
    realpath(projectionPath),
  ]);
  assertPathInsideRoot(memoryRoot, projectionReal, projectionPath);
  return true;
}

async function rewriteProjectedEntityReferenceRows(
  memoryDir: string,
  entries: ReadonlyArray<readonly [string, string]>,
  memoryId?: string,
): Promise<void> {
  if (memoryId !== undefined && memoryId.length === 0) {
    throw new Error("Projection memoryId must not be empty.");
  }
  const scopedMemory = memoryId !== undefined;
  const validEntries = entries.filter(
    ([previousEntityRef, nextEntityRef]) =>
      previousEntityRef.length > 0 && nextEntityRef.length > 0 && previousEntityRef !== nextEntityRef,
  );
  if (validEntries.length === 0) return;

  const projectionPath = getMemoryProjectionPath(memoryDir);
  if (!(await validateProjectionPath(memoryDir, projectionPath))) return;

  let lastError: unknown;
  for (let attempt = 0; attempt < PROJECTION_WRITE_RETRY_COUNT; attempt += 1) {
    if (!(await validateProjectionPath(memoryDir, projectionPath))) return;
    let db: BetterSqlite3Database | null = null;
    try {
      db = openBetterSqlite3(projectionPath, { fileMustExist: true });
      db.pragma(`busy_timeout = ${PROJECTION_WRITE_BUSY_TIMEOUT_MS}`);
      initializeMemoryProjectionDb(db);
      const updateCurrent = db.prepare(
        scopedMemory
          ? "UPDATE memory_current SET entity_ref = ? WHERE memory_id = ? AND entity_ref = ?"
          : "UPDATE memory_current SET entity_ref = ? WHERE entity_ref = ?",
      );
      const updateMentions = db.prepare(
        scopedMemory
          ? `
            UPDATE memory_entity_mentions
            SET entity_ref = ?
            WHERE memory_id = ? AND entity_ref = ? AND mention_source = 'frontmatter.entityRef'
          `
          : `
            UPDATE memory_entity_mentions
            SET entity_ref = ?
            WHERE entity_ref = ? AND mention_source = 'frontmatter.entityRef'
          `,
      );
      const rewrite = db.transaction(() => {
        for (const [previousEntityRef, nextEntityRef] of validEntries) {
          const params = scopedMemory
            ? [nextEntityRef, memoryId, previousEntityRef]
            : [nextEntityRef, previousEntityRef];
          updateCurrent.run(...params);
          updateMentions.run(...params);
        }
      });
      rewrite();
      return;
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === PROJECTION_WRITE_RETRY_COUNT - 1) {
        throw error;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, PROJECTION_WRITE_RETRY_DELAY_MS);
      await promise;
    } finally {
      db?.close();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Projection rewrite failed.");
}

export async function rewriteProjectedMemoryEntityReference(
  memoryDir: string,
  memoryId: string,
  previousEntityRef: string,
  nextEntityRef: string,
): Promise<void> {
  await rewriteProjectedEntityReferenceRows(memoryDir, [[previousEntityRef, nextEntityRef]], memoryId);
}

export async function rewriteProjectedEntityReferences(
  memoryDir: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  await rewriteProjectedEntityReferenceRows(memoryDir, Object.entries(replacements));
}
