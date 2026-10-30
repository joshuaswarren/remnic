/**
 * macOS Finder metadata that arrives through Mac-to-Linux copies.
 *
 * AppleDouble sidecars are named `._` plus the real file's basename
 * (`._project-notes.md` beside `project-notes.md`). Finder also writes
 * `.DS_Store` into any directory it opens. Neither is a Remnic record.
 * Directory scanners and replication must ignore them so they are never
 * parsed as entities, memories, or sync objects.
 *
 * QMD's own indexer already drops every hidden path (`dot: false` plus a
 * hidden-segment filter). Callers that build index inputs themselves still
 * use this helper so the non-QMD scanners stay in parity.
 */

const warnedJunkDirectories = new Set<string>();

/** True for an AppleDouble sidecar or a Finder `.DS_Store` file. */
export function isMacOsReplicationJunkBasename(basename: string): boolean {
  return basename === ".DS_Store" || basename.startsWith("._");
}

/** True when the final path segment is macOS replication junk. */
export function isMacOsReplicationJunkRelativePath(relPath: string): boolean {
  const normalized = relPath.includes("\\") ? relPath.replaceAll("\\", "/") : relPath;
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  return isMacOsReplicationJunkBasename(basename);
}

/**
 * Drop junk names from a directory listing. `ignored` is the count of
 * names removed, so the caller can emit one summary warning.
 */
export function withoutMacOsReplicationJunk<T>(
  entries: readonly T[],
  basenameOf: (entry: T) => string
): { kept: T[]; ignored: number } {
  const kept: T[] = [];
  let ignored = 0;
  for (const entry of entries) {
    if (isMacOsReplicationJunkBasename(basenameOf(entry))) {
      ignored += 1;
      continue;
    }
    kept.push(entry);
  }
  return { kept, ignored };
}

/**
 * Emit at most one junk warning per directory and count. A later scan of
 * the same directory (entity migration, then entity load) stays quiet
 * instead of repeating the same summary.
 */
export function warnIgnoredMacOsReplicationJunk(
  directoryKey: string,
  count: number,
  warn: (message: string) => void
): void {
  if (count <= 0) return;
  const key = `${directoryKey}\0${count}`;
  if (warnedJunkDirectories.has(key)) return;
  warnedJunkDirectories.add(key);
  warn(`ignored ${count} macOS replication junk file(s) (._* and .DS_Store)`);
}
