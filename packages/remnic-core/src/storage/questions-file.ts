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
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatterStr = match[1];
  const body = match[2].trim();

  // Parse frontmatter. Unknown keys (e.g. the inert OKF `type`) are tolerated.
  const id = extractFrontmatterValue(frontmatterStr, "id") ?? path.basename(filePath, ".md");
  const created = extractFrontmatterValue(frontmatterStr, "created") ?? "";
  const priority = parseFloat(extractFrontmatterValue(frontmatterStr, "priority") ?? "0.5");
  const resolved = extractFrontmatterValue(frontmatterStr, "resolved") === "true";

  // Extract question and context from body
  const contextMatch = body.match(/\*\*Context:\*\*\s*(.*)/);
  const question = contextMatch ? body.slice(0, contextMatch.index).trim() : body;
  const context = contextMatch ? contextMatch[1].trim() : "";

  return { id, question, context, priority, resolved, created, filePath };
}

function extractFrontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, "m"));
  return match ? match[1] : null;
}
