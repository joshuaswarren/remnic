/**
 * @remnic/core — Diff-Aware Sync
 *
 * Watches source files for changes and triggers re-ingestion
 * only for changed content. Uses file hashing to detect changes.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Source directory to watch */
  sourceDir: string;
  /** Memory root directory */
  memoryDir: string;
  /** State file path (stores hashes). Default: memoryDir/.sync-state.json */
  stateFile?: string;
  /** File extensions to watch (default: .md, .txt, .mdx) */
  extensions?: string[];
  /** Directories to exclude */
  excludeDirs?: string[];
  /** Poll interval for watchForChanges. Default: 5000ms */
  pollIntervalMs?: number;
  /** Whether to actually write changes (default: true) */
  dryRun?: boolean;
}

export interface SyncResult {
  /** Files scanned */
  scanned: number;
  /** Files changed since last sync */
  changed: FileChange[];
  /** Files unchanged */
  unchanged: number;
  /** Files deleted since last sync */
  deleted: string[];
  /** Files newly added */
  added: string[];
  /** Duration in ms */
  durationMs: number;
  /** State file path */
  stateFile: string;
}

export interface FileChange {
  /** Absolute file path */
  filePath: string;
  /** Relative path from source root */
  relativePath: string;
  /** Change type */
  type: "added" | "modified" | "deleted";
  /** Current content hash */
  currentHash: string;
  /** Previous content hash (if modified) */
  previousHash?: string;
  /** File size in bytes */
  size: number;
}

export interface SyncState {
  /** Map of relative path → content hash */
  fileHashes: Record<string, string>;
  /** Last sync timestamp */
  lastSyncAt: string;
  /** Version of state format */
  version: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = new Set([".md", ".txt", ".mdx", ".rst"]);
const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".engram",
  "coverage",
]);

// ── Main function ────────────────────────────────────────────────────────────

export function syncChanges(options: SyncOptions): SyncResult {
  const startTime = Date.now();
  const {
    sourceDir,
    memoryDir,
    extensions = [...DEFAULT_EXTENSIONS],
    excludeDirs = [],
    dryRun = false,
  } = options;

  const extSet = new Set(extensions);
  const excludeSet = new Set([...DEFAULT_EXCLUDE, ...excludeDirs]);
  const stateFilePath = options.stateFile ?? path.join(memoryDir, ".sync-state.json");

  // Load previous state
  const prevState = loadState(stateFilePath);

  // Scan current files
  const currentFiles = scanFiles(sourceDir, extSet, excludeSet);

  // Compute diffs
  const changes = computeDiff(currentFiles, prevState.fileHashes, sourceDir);

  const added = changes.filter((c) => c.type === "added").map((c) => c.relativePath);
  const modified = changes.filter((c) => c.type === "modified");
  const deleted = changes
    .filter((c) => c.type === "deleted")
    .map((c) => c.relativePath);

  // Update state (even in dry run, we want to show what would change)
  if (!dryRun) {
    const newState: SyncState = {
      fileHashes: {},
      lastSyncAt: new Date().toISOString(),
      version: 1,
    };

    // Build new state from current files
    for (const [relPath, hash] of Object.entries(currentFiles)) {
      newState.fileHashes[relPath] = hash;
    }

    // Write state
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(newState, null, 2));
  }

  return {
    scanned: Object.keys(currentFiles).length,
    changed: changes,
    unchanged:
      Object.keys(currentFiles).length - changes.filter((c) => c.type !== "deleted").length,
    deleted,
    added,
    durationMs: Date.now() - startTime,
    stateFile: stateFilePath,
  };
}

/**
 * Watch for changes and call callback on file changes.
 * Returns a stop function.
 */
export function watchForChanges(
  options: SyncOptions,
  onChange: (changes: FileChange[]) => void | Promise<void>,
): { stop: () => void } {
  const { sourceDir, extensions, excludeDirs } = options;
  const extSet = new Set(extensions ?? DEFAULT_EXTENSIONS);
  const excludeSet = new Set([...DEFAULT_EXCLUDE, ...(excludeDirs ?? [])]);
  const pollIntervalMs =
    typeof options.pollIntervalMs === "number" &&
    Number.isFinite(options.pollIntervalMs) &&
    options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : 5000;

  let lastHashes: Record<string, string> = {};
  let pollInFlight = false;

  // Initial scan
  const currentFiles = scanFiles(sourceDir, extSet, excludeSet);
  lastHashes = { ...currentFiles };

  // Poll interval (FSWatcher doesn't reliably work for all platforms)
  const poll = async (): Promise<void> => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const nowFiles = scanFiles(sourceDir, extSet, excludeSet);
      const changes = computeDiff(nowFiles, lastHashes, sourceDir);

      if (changes.length > 0) {
        await onChange(changes);
        // Update hashes
        for (const change of changes) {
          if (change.type === "deleted") {
            delete lastHashes[change.relativePath];
          } else {
            lastHashes[change.relativePath] = change.currentHash;
          }
        }
      }
    } catch {
      // Leave lastHashes unchanged so the next poll retries the same diff.
    } finally {
      pollInFlight = false;
    }
  };
  const interval = setInterval(() => {
    void poll();
  }, pollIntervalMs);

  return {
    stop: () => clearInterval(interval),
  };
}

// ── File scanning ────────────────────────────────────────────────────────────

function scanFiles(
  root: string,
  extensions: Set<string>,
  exclude: Set<string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  function walk(dir: string, isRoot = false): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) {
        throw new Error(
          `sync scan failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.has(ext)) continue;

        const relPath = path.relative(root, fullPath);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          result[relPath] = hashContent(content);
        } catch {
          // Can't read — skip
        }
      }
    }
  }

  walk(root, true);
  return result;
}

// ── Diff computation ─────────────────────────────────────────────────────────

function computeDiff(
  current: Record<string, string>,
  previous: Record<string, string>,
  sourceDir: string,
): FileChange[] {
  const changes: FileChange[] = [];

  // Find added and modified
  for (const [relPath, hash] of Object.entries(current)) {
    const fullPath = path.join(sourceDir, relPath);

    if (!(relPath in previous)) {
      // Added
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        // ignore
      }
      changes.push({
        filePath: fullPath,
        relativePath: relPath,
        type: "added",
        currentHash: hash,
        size,
      });
    } else if (previous[relPath] !== hash) {
      // Modified
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        // ignore
      }
      changes.push({
        filePath: fullPath,
        relativePath: relPath,
        type: "modified",
        currentHash: hash,
        previousHash: previous[relPath],
        size,
      });
    }
  }

  // Find deleted
  for (const relPath of Object.keys(previous)) {
    if (!(relPath in current)) {
      changes.push({
        filePath: path.join(sourceDir, relPath),
        relativePath: relPath,
        type: "deleted",
        currentHash: "",
        size: 0,
      });
    }
  }

  return changes;
}

// ── State management ─────────────────────────────────────────────────────────

function loadState(stateFilePath: string): SyncState {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      fileHashes: {},
      lastSyncAt: new Date(0).toISOString(),
      version: 1,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}
