/**
 * materialize-paths.ts — containment guard for the materializer's managed
 * sub-directories (`rollout_summaries/`, `skills/`).
 *
 * Extracted from codex-materialize.ts so the skills section (issue #2369) and
 * the rollout section share ONE containment implementation instead of forking
 * the check (rule 22).
 */

import fs from "node:fs";
import path from "node:path";

import { pathIsInside } from "../utils/path-containment.js";

/**
 * Resolve a managed sub-directory of `memoriesDir`, creating it when absent,
 * and refuse a symlinked or escaping target. Returns the (unchanged) path so
 * callers can use it directly.
 */
export function ensureSafeManagedSubdir(memoriesDir: string, subdir: string, label: string): string {
  const memoriesReal = fs.realpathSync(memoriesDir);

  try {
    const stat = fs.lstatSync(subdir);
    if (stat.isSymbolicLink()) {
      throw new Error("is a symbolic link");
    }
    if (!stat.isDirectory()) {
      throw new Error("is not a directory");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `codex-materialize: unsafe ${label} directory at ${subdir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    fs.mkdirSync(subdir, { recursive: true });
  }

  const subdirReal = fs.realpathSync(subdir);
  if (!pathIsInside(memoriesReal, subdirReal)) {
    throw new Error(
      `codex-materialize: unsafe ${label} directory at ${subdir}: resolves outside ${memoriesDir}`,
    );
  }

  return path.normalize(subdir);
}
