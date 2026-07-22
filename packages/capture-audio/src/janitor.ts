import { lstat, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { CaptureConfigError } from "./errors.js";

export async function pruneExpiredRawAudio(rawDirectory: string, retentionMs: number, nowMs: number = Date.now()): Promise<string[]> {
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new CaptureConfigError("raw audio retention must be a non-negative duration");
  }
  const cutoffMs = nowMs - retentionMs;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(rawDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const location = path.join(rawDirectory, entry.name);
    const stat = await lstat(location);
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoffMs) {
      await rm(location);
      removed.push(location);
    }
  }
  return removed.sort();
}
