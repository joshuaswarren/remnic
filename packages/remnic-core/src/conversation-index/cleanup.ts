import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";

/**
 * Best-effort retention cleanup for conversation chunk docs.
 *
 * Layout (written by indexer.ts):
 *   <root>/<safeSessionKey>/<YYYY-MM-DD>/<chunkId>.md
 *
 * We prune day directories older than retentionDays, and remove empty session dirs.
 */
export async function cleanupConversationChunks(
  rootDir: string,
  retentionDays: number,
): Promise<void> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const root = await assertCleanupRoot(rootDir);
    const sessions = await readdir(rootDir, { withFileTypes: true });
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const sessionDir = await assertCleanupChild(root, path.join(rootDir, s.name));
      const dayDirs = await readdir(sessionDir, { withFileTypes: true });

      for (const d of dayDirs) {
        if (!d.isDirectory()) continue;
        // Expect YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.name)) continue;
        const dayMs = new Date(d.name + "T00:00:00.000Z").getTime();
        if (!Number.isFinite(dayMs)) continue;
        if (dayMs < cutoffMs) {
          await rm(await assertCleanupChild(root, path.join(sessionDir, d.name)), { recursive: true, force: true });
        }
      }

      // Remove empty session dirs after pruning.
      try {
        const remaining = await readdir(sessionDir);
        if (remaining.length === 0) {
          await rm(await assertCleanupChild(root, sessionDir), { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch (err) {
    log.debug(`conversation chunk cleanup failed: ${err}`);
  }
}

async function assertCleanupRoot(rootDir: string): Promise<string> {
  const stat = await lstat(rootDir);
  if (stat.isSymbolicLink()) {
    throw new Error("conversation chunk cleanup root must not be a symlink");
  }
  return realpath(rootDir);
}

async function assertCleanupChild(rootReal: string, candidate: string): Promise<string> {
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error("conversation chunk cleanup path must not contain symlinks");
  }
  const real = await realpath(candidate);
  const relative = path.relative(rootReal, real);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return real;
  }
  throw new Error("conversation chunk cleanup path escapes index root");
}
