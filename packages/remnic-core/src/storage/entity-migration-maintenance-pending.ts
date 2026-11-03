import { randomUUID } from "node:crypto";
import { lstat, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isErrnoCode } from "../utils/errno.js";

/**
 * Issue #3286: the entity migration asks search maintenance to re-index only
 * after a pass that rewrote references. A crash between that rewrite and the
 * request would replay as a quiet no-op and leave the QMD index and projections
 * naming pre-rewrite entity ids. This marker, written BEFORE a pass rewrites
 * anything and cleared only after maintenance was requested, makes the owed
 * request survive the crash. No marker means no request, so ordinary no-op
 * startups stay quiet.
 */
export const ENTITY_MIGRATION_MAINTENANCE_PENDING_FILE = "entity-canonical-id-maintenance.pending";

function markerPath(stateDir: string): string {
  return path.join(stateDir, ENTITY_MIGRATION_MAINTENANCE_PENDING_FILE);
}

/** Atomic temp-and-rename publish, the same pattern as the migration journal. */
export async function writeMaintenancePending(stateDir: string): Promise<void> {
  const destination = markerPath(stateDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${new Date().toISOString()}\n`, "utf-8");
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function maintenancePendingExists(stateDir: string): Promise<boolean> {
  try {
    await lstat(markerPath(stateDir));
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function clearMaintenancePending(stateDir: string): Promise<void> {
  try {
    await unlink(markerPath(stateDir));
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
}
