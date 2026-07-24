import { lstat, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { CaptureConfigError } from "./errors.js";

export async function pruneExpiredRawAudio(rawDirectory: string, retentionMs: number, nowMs: number = Date.now()): Promise<string[]> {
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new CaptureConfigError("raw audio retention must be a non-negative duration");
  }
  const cutoffMs = nowMs - retentionMs;
  let root;
  try {
    root = await lstat(rawDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new CaptureConfigError("raw audio directory must be a non-symlink directory");
  }

  const entries = await readdir(rawDirectory, { withFileTypes: true });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const location = path.join(rawDirectory, entry.name);
    try {
      const stat = await lstat(location);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs <= cutoffMs) {
        await rm(location);
        removed.push(location);
      }
    } catch (error) {
      // A concurrent capture/cleanup can delete a chunk between readdir and
      // lstat/rm; a vanished file is already pruned, so skip it and continue
      // instead of aborting the whole janitor run with a generic FS error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return removed.sort();
}
