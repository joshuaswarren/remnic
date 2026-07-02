import path from "node:path";

/**
 * Shared filesystem-containment helpers for the memory-store walkers.
 *
 * Every walker that reads memory files off disk (search/document-scanner.ts,
 * cli.ts, consolidation-provenance-check.ts, storage.ts) must guard against a
 * category directory or entry being a symlink that escapes `memoryDir`. A
 * symlinked category dir (e.g. `decisions/` -> an external directory) would
 * otherwise pull out-of-store files into recall results (info leak). This is
 * the single containment check those walkers share — do NOT fork a new one.
 *
 * Callers resolve the memory root once via `realpath`, then per directory /
 * per entry `realpath` the candidate and `assertPathInsideRoot(...)` (or check
 * `pathIsInside(...)`) before reading.
 */

/**
 * True when `child` is `parent` itself or a descendant of it. Both arguments
 * must already be `realpath`-resolved absolute paths so symlink escapes are
 * detectable via the resolved location.
 */
export function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Throw when `candidateReal` (a `realpath`-resolved path) is not inside
 * `rootReal` (the `realpath`-resolved memory root). `originalPath` is the
 * pre-resolution path, used only for the error message.
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
