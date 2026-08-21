/**
 * Shared path helpers. CLAUDE.md #17 requires consistent `~` expansion across
 * every user-facing path input, but Node's `fs` does not expand `~`, so every
 * call site must go through this helper.
 */

import path from "node:path";

import { resolveHomeDir } from "../runtime/env.js";

/**
 * Expand a leading `~` or `~/…` to the resolved home directory.
 *
 * Leaves paths without a leading `~` unchanged — including absolute paths,
 * relative paths, and paths that contain `~` in the middle.
 *
 * Accepts both `~/` (POSIX) and `~\` (Windows) as separators so call sites
 * don't have to branch on platform.
 */
export function expandTildePath(p: string): string {
  if (p === "~") return resolveHomeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(resolveHomeDir(), p.slice(2));
  }
  return p;
}
