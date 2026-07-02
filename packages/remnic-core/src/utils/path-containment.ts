/**
 * @remnic/core — Path Containment Guards
 *
 * Shared symlink/traversal containment helpers for filesystem walkers that
 * scan the memory store. Extracted from search/document-scanner.ts so every
 * walker (the search index scanner, the CLI dedupe walker, ...) enforces the
 * SAME containment semantics instead of forking the check (CLAUDE.md rule 22).
 *
 * Both helpers operate on realpath()-resolved absolute paths: callers resolve
 * symlinks first, then assert the resolved target is still inside the (also
 * realpath-resolved) memory root. This blocks a symlinked category directory
 * (e.g. decisions/ → /etc) from redirecting a scan — or a destructive dedupe
 * unlink — outside the memory store.
 */

import path from "node:path";

/**
 * True when `child` is `parent` itself or nested underneath it. Both arguments
 * must already be resolved (realpath) absolute paths.
 */
export function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Throw if the realpath-resolved `candidateReal` escapes `rootReal`. The
 * message references the original (pre-realpath) path so operators can locate
 * the offending symlink/entry.
 */
export function assertPathInsideRoot(
  rootReal: string,
  candidateReal: string,
  originalPath: string,
): void {
  if (!pathIsInside(rootReal, candidateReal)) {
    throw new Error(`Refusing to scan memory path outside memoryDir: ${originalPath}`);
  }
}
