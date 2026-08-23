import path from "node:path";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";
import { isErrnoCode } from "../utils/errno.js";

export interface IndexableDocument {
  /** Memory ID from frontmatter or filename stem */
  docid: string;
  /** Absolute file path */
  path: string;
  /** Markdown body (no YAML frontmatter) */
  content: string;
  /** First ~200 chars for display */
  snippet: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the frontmatter key-value pairs and body, or null if no frontmatter block.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } | null {
  // Support both LF and CRLF line endings
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const body = (match[2] ?? "").trim();
  const data: Record<string, string> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    data[key] = value;
  }

  return { data, body };
}

/**
 * Recursively scan a directory for `.md` files and return IndexableDocuments.
 */
async function scanDir(dir: string, memoryRootReal: string): Promise<IndexableDocument[]> {
  const docs: IndexableDocument[] = [];
  try {
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(`Refusing to scan symlinked memory category directory: ${dir}`);
    }
    if (!dirStat.isDirectory()) {
      const error = new Error(`Memory category path is not a directory: ${dir}`) as NodeJS.ErrnoException;
      error.code = "ENOTDIR";
      throw error;
    }
    assertPathInsideRoot(memoryRootReal, await realpath(dir), dir);

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        assertPathInsideRoot(memoryRootReal, await realpath(fullPath), fullPath);
        const sub = await scanDir(fullPath, memoryRootReal);
        docs.push(...sub);
      } else if (entry.name.endsWith(".md")) {
        try {
          assertPathInsideRoot(memoryRootReal, await realpath(fullPath), fullPath);
          const raw = await readFile(fullPath, "utf-8");
          const parsed = parseFrontmatter(raw);
          const body = parsed ? parsed.body : raw.trim();
          const docid = parsed?.data.id || path.basename(entry.name, ".md");
          docs.push({
            docid,
            path: fullPath,
            content: body,
            snippet: body.slice(0, 200),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      // Optional category directories may not exist yet.
      return docs;
    }
    throw err;
  }
  return docs;
}

/**
 * Scan every recall category subdir of memoryDir for indexable markdown
 * documents. The directory set is derived from `RECALL_FALLBACK_DIRS`
 * (utils/category-dir.ts → ALL_CATEGORY_DIRS minus non-recall queue dirs) —
 * the single source of truth — so adding a new category never requires
 * touching this scanner. Non-QMD backends (Orama / Meilisearch / LanceDB)
 * build their index through this helper; deriving from RECALL_FALLBACK_DIRS
 * keeps them in parity with writeMemory's category-dir routing (issue #1546)
 * and the QMD filesystem-fallback corpus. reasoning-traces/ and the other
 * category dirs are covered automatically (issue #564 PR 3 no longer needs a
 * hand-maintained list). scanDir tolerates missing dirs (ENOENT), so category
 * dirs that do not exist yet are skipped.
 */
export async function scanMemoryDir(memoryDir: string): Promise<IndexableDocument[]> {
  let memoryRootReal: string;
  try {
    memoryRootReal = await realpath(memoryDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return [];
    }
    throw err;
  }
  const perDir = await Promise.all(
    RECALL_FALLBACK_DIRS.map((dir) => scanDir(path.join(memoryDir, dir), memoryRootReal)),
  );
  return perDir.flat();
}
