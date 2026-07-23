/**
 * Projection maintenance support (issue #2119) — helpers shared by the
 * scheduled projection rebuild, the CLI rebuild, and the ledger rebuild.
 * Lives beside the rebuild ops so the at-ceiling store/rebuild modules stay
 * within their structural ratchets.
 */

import path from "node:path";
import { openProjectionReadonly } from "../memory-projection-store.js";

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
