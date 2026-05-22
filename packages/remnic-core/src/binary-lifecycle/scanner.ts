/**
 * Binary file scanner.
 *
 * Recursively walks the memory directory, matches files against configured
 * glob patterns, skips files already tracked in the manifest, and respects
 * the max-size limit.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { BinaryLifecycleConfig, BinaryLifecycleManifest } from "./types.js";

/**
 * Test whether a filename matches any of the provided glob patterns.
 * Supports simple `*.ext` patterns (the default scan patterns).
 * For more complex globs a proper library should be used; this covers
 * the 95% case without adding a dependency.
 */
export function matchesPatterns(filename: string, patterns: string[]): boolean {
  const lower = filename.toLowerCase();
  for (const pattern of patterns) {
    // Simple *.ext matching
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1).toLowerCase(); // e.g. ".png"
      if (lower.endsWith(ext)) return true;
    } else if (lower === pattern.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Scan memoryDir recursively for binary files matching the configured patterns.
 * Returns relative paths (relative to memoryDir) for files not yet tracked.
 */
export async function scanForBinaries(
  memoryDir: string,
  config: BinaryLifecycleConfig,
  manifest: BinaryLifecycleManifest,
): Promise<string[]> {
  const tracked = new Map(manifest.assets.map((a) => [a.originalPath, a]));
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Normalize to POSIX separators so redirect matching works on Windows
      // (markdown links always use forward slashes).
      const relativePath = path.relative(memoryDir, fullPath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        // Skip the manifest directory itself and hidden dirs starting with .
        if (entry.name === ".binary-lifecycle") continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Check pattern match
      if (!matchesPatterns(entry.name, config.scanPatterns)) continue;

      // Check file size
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.size > config.maxBinarySizeBytes) continue;
        if (stat.size === 0) continue; // skip empty files
        const existing = tracked.get(relativePath);
        if (existing) {
          if (existing.sizeBytes !== stat.size) {
            results.push(relativePath);
            continue;
          }
          const contentHash = await hashFile(fullPath);
          if (existing.contentHash !== contentHash) {
            results.push(relativePath);
          }
          continue;
        }
      } catch {
        continue; // stat failure, skip
      }

      results.push(relativePath);
    }
  }

  await walk(memoryDir);
  return results;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}
