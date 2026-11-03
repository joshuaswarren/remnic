import { randomUUID } from "node:crypto";
import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isErrnoCode } from "../utils/errno.js";

/**
 * Issue #3286: the entity migration asks search maintenance to re-index only
 * after a pass that rewrote references. A crash between that rewrite and the
 * request would replay as a quiet no-op and leave the QMD index and projections
 * naming pre-rewrite entity ids. A marker, written BEFORE a pass rewrites
 * anything and cleared only after the host reports the request SERVED, makes
 * the owed request survive the crash. No marker means no request, so ordinary
 * no-op startups stay quiet.
 *
 * One file per arming run (`<prefix>.<pid>-<uuid>`): a run clears only the
 * files it observed at start or wrote itself, so a concurrent run's marker can
 * never be overwritten or deleted by this run's clear (review finding on #3287).
 */
export const ENTITY_MIGRATION_MAINTENANCE_PENDING_PREFIX = "entity-canonical-id-maintenance.pending";

/** Atomic temp-and-rename publish, the same pattern as the migration journal. Returns the marker's file name. */
export async function writeMaintenancePending(stateDir: string): Promise<string> {
  const name = `${ENTITY_MIGRATION_MAINTENANCE_PENDING_PREFIX}.${process.pid}-${randomUUID()}`;
  const destination = path.join(stateDir, name);
  const temporary = `${destination}.tmp`;
  try {
    await writeFile(temporary, `${new Date().toISOString()}\n`, "utf-8");
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return name;
}

/** Names of the markers currently on disk (in-progress temp files excluded). */
export async function listMaintenancePending(stateDir: string): Promise<string[]> {
  try {
    return (await readdir(stateDir)).filter(
      (name) => name.startsWith(ENTITY_MIGRATION_MAINTENANCE_PENDING_PREFIX) && !name.endsWith(".tmp"),
    );
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
}

/** Remove exactly the named markers; one already gone (another run cleared it) is fine. */
export async function clearMaintenancePending(stateDir: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    try {
      await unlink(path.join(stateDir, name));
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
  }
}

/**
 * Clear the markers `held` by a run once the host's maintenance request was
 * served. `false` (refused) or a promise settling to `false` keeps them; a
 * rejection propagates so the caller can log it and the markers stay.
 */
export async function settleMaintenancePending(
  stateDir: string,
  held: readonly string[],
  outcome: boolean | Promise<boolean> | void,
): Promise<void> {
  if ((await outcome) !== false) await clearMaintenancePending(stateDir, held);
}

const settlements = new Map<string, Set<Promise<void>>>();

/** Track a settlement that outlives its migration run (an async hook is served after a debounce). */
export function trackMaintenanceSettlement(stateDir: string, settling: Promise<void>): void {
  let tracked = settlements.get(stateDir);
  if (!tracked) {
    tracked = new Set<Promise<void>>();
    settlements.set(stateDir, tracked);
  }
  const done = tracked;
  done.add(settling);
  void settling.finally(() => done.delete(settling));
}

/** Resolves once every tracked settlement for the directory has finished (never rejects: callers pre-handle errors). */
export async function drainMaintenanceSettlements(stateDir: string): Promise<void> {
  const tracked = settlements.get(stateDir);
  if (tracked) await Promise.all(tracked);
}
