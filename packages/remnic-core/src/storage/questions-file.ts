/**
 * Question file format (issue #1946 extraction from storage.ts so the
 * surface file stays under its structural ceiling). Pure text parsing —
 * no filesystem, no caches; StorageManager delegates through so the
 * selfDeps consumers (MemoryReadStore) keep their seam unchanged.
 */
import path from "node:path";

export interface ParsedQuestionFile {
  id: string;
  question: string;
  context: string;
  priority: number;
  resolved: boolean;
  created: string;
  filePath: string;
}

export function parseQuestionFile(raw: string, filePath: string): ParsedQuestionFile | null {
  if (!raw.startsWith("---\n")) return null;
  const close = raw.indexOf("\n---\n\n", 4);
  if (close === -1) return null;
  const frontmatterStr = raw.slice(4, close);
  const body = raw.slice(close + 6).trim();

  const id = extractFrontmatterValue(frontmatterStr, "id") ?? path.basename(filePath, ".md");
  const created = extractFrontmatterValue(frontmatterStr, "created") ?? "";
  const priority = parseFloat(extractFrontmatterValue(frontmatterStr, "priority") ?? "0.5");
  const resolved = extractFrontmatterValue(frontmatterStr, "resolved") === "true";

  const contextMarker = "**Context:**";
  const contextAt = body.indexOf(contextMarker);
  const question = contextAt === -1 ? body : body.slice(0, contextAt).trim();
  const context = contextAt === -1 ? "" : body.slice(contextAt + contextMarker.length).trim();

  return { id, question, context, priority, resolved, created, filePath };
}

function extractFrontmatterValue(frontmatter: string, key: string): string | null {
  const prefix = `${key}:`;
  for (const line of frontmatter.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    let value = line.slice(prefix.length).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}
