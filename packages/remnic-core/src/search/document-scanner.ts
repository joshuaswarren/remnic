import path from "node:path";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";

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
      return docs;
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
    if (isNodeError(err) && err.code === "ENOENT") {
      // Optional category directories may not exist yet.
      return docs;
    }
    throw err;
  }
  return docs;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathInsideRoot(rootReal: string, candidateReal: string, originalPath: string): void {
  if (!pathIsInside(rootReal, candidateReal)) {
    throw new Error(`Refusing to scan memory path outside memoryDir: ${originalPath}`);
  }
}

/**
 * Scan `facts/`, `corrections/`, `procedures/`, and `reasoning-traces/`
 * subdirs of memoryDir for indexable markdown documents.
 *
 * Note: reasoning-traces live under their own subtree (issue #564 PR 3).
 * Non-QMD backends (Orama / Meilisearch / LanceDB) build their index
 * through this helper, so any new category subtree must be listed here
 * or those backends silently stop seeing the new memories.
 */
export async function scanMemoryDir(memoryDir: string): Promise<IndexableDocument[]> {
  let memoryRootReal: string;
  try {
    memoryRootReal = await realpath(memoryDir);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const factsDir = path.join(memoryDir, "facts");
  const correctionsDir = path.join(memoryDir, "corrections");
  const proceduresDir = path.join(memoryDir, "procedures");
  const reasoningTracesDir = path.join(memoryDir, "reasoning-traces");
  const [facts, corrections, procedures, reasoningTraces] = await Promise.all([
    scanDir(factsDir, memoryRootReal),
    scanDir(correctionsDir, memoryRootReal),
    scanDir(proceduresDir, memoryRootReal),
    scanDir(reasoningTracesDir, memoryRootReal),
  ]);
  return [...facts, ...corrections, ...procedures, ...reasoningTraces];
}
