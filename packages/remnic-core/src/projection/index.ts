/**
 * @remnic/core — Workspace Tree Projection
 *
 * Generates a human-readable `.engram/context-tree/` from canonical memory.
 * Each node is a `.md` file with rich metadata, * (provenance, trust, confidence, source anchors).
 * Manual edits are preserved in fenced blocks.
 */

import fs from "node:fs";
import path from "node:path";
import { getCategoryDir, ALL_CATEGORY_KEYS } from "../utils/category-dir.js";

const VALID_PROJECTION_CATEGORIES = new Set(ALL_CATEGORY_KEYS);

// ── Types ────────────────────────────────────────────────────────────────────

export interface TreeNode {
  /** Relative path from context-tree root, e.g. "entities/claude.md" */
  path: string;
  /** Category from canonical memory */
  category: string;
  /** Human-readable title */
  title: string;
  /** File content (rendered markdown) */
  content: string;
  /** Source memory IDs that contributed to this node */
  sourceAnchors: string[];
  /** Confidence (0-1) */
  confidence: number;
  /** Trust zone classification */
  confidenceTier: string;
  /** When this node was generated */
  generatedAt: string;
  /** Provenance chain */
  provenance: ProvenanceEntry[];
}

export interface ProvenanceEntry {
  memoryId: string;
  source: string;
  extracted: string;
}

export interface GenerateOptions {
  /** Memory root directory (e.g. ~/.openclaw/workspace/memory/local) */
  memoryDir: string;
  /** Output directory (e.g. .engram/context-tree) */
  outputDir: string;
  /** Categories to include (default: all) */
  categories?: string[];
  /** Whether to include entity graph */
  includeEntities?: boolean;
  /** Whether to include orphaned questions */
  includeQuestions?: boolean;
  /** Max nodes per category (default: unlimited) */
  maxPerCategory?: number;
  /** Whether to watch for changes and regenerate incrementally */
  watch?: boolean;
}

export interface GenerateResult {
  nodesGenerated: number;
  nodesSkipped: number;
  categories: Record<string, number>;
  durationMs: number;
  outputDir: string;
}

// ── Generation ──────────────────────────────────────────────────────────────

/**
 * Generate a context tree from canonical memory.
 *
 * Reads memory `.md` files from the source directory, * and projects them into a clean, * human-readable tree structure at `outputDir`.
 */
export async function generateContextTree(options: GenerateOptions): Promise<GenerateResult> {
  const startTime = Date.now();
  const {
    memoryDir,
    outputDir,
    categories: filterCategories,
    includeEntities = true,
    includeQuestions = true,
    maxPerCategory = Infinity,
  } = options;

  let nodesGenerated = 0;
  let nodesSkipped = 0;
  const categoryCounts: Record<string, number> = {};
  const resolvedMemoryDir = path.resolve(memoryDir);
  const resolvedOutputDir = path.resolve(outputDir);
  const requestedCategories = validateProjectionCategories(filterCategories);
  const realMemoryDir = fs.realpathSync(resolvedMemoryDir);

  // Ensure output directory exists
  assertNotSymlink(resolvedOutputDir, "context tree outputDir");
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const realOutputDir = fs.realpathSync(resolvedOutputDir);

  // Process each category (exclude 'question' — handled by separate includeQuestions pass)
  const allCategories = (requestedCategories ?? ALL_CATEGORY_KEYS)
    .filter((c) => c !== "question");

  for (const category of allCategories) {
    const categoryDir = getCategoryDir(memoryDir, category);
    if (!fs.existsSync(categoryDir)) continue;
    assertSafeInputRoot(realMemoryDir, categoryDir, `${category} memory category`);

    categoryCounts[category] = 0;
    const files = walkR(categoryDir, realMemoryDir);
    let count = 0;

    for (const filePath of files) {
      if (count >= maxPerCategory) {
        nodesSkipped++;
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");
      const fm = parseFrontmatter(content);
      if (!fm) {
        nodesSkipped++;
        continue;
      }

      const node = projectNode(filePath, category, fm, content);
      if (!node) {
        nodesSkipped++;
        continue;
      }

      // Write node to output
      const outputPath = resolveContainedOutputPath(realOutputDir, node.path);
      writeProjectedContent(realOutputDir, outputPath, node.content);

      nodesGenerated++;
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
      count++;
    }
  }

  // Process entities
  if (includeEntities) {
    const entitiesDir = path.join(memoryDir, "entities");
    if (fs.existsSync(entitiesDir)) {
      assertSafeInputRoot(realMemoryDir, entitiesDir, "entities root");
      categoryCounts["entity"] = 0;
      const entityFiles = walkR(entitiesDir, realMemoryDir);
      let count = 0;

      for (const filePath of entityFiles) {
        if (count >= maxPerCategory) {
          nodesSkipped++;
          continue;
        }

        const content = fs.readFileSync(filePath, "utf8");
        const fileName = path.basename(filePath, ".md");
        const node = projectEntityNode(fileName, content);

        const outputPath = resolveContainedOutputPath(realOutputDir, "entities", `${fileName}.md`);
        writeProjectedContent(realOutputDir, outputPath, node.content);

        nodesGenerated++;
        categoryCounts["entity"] = (categoryCounts["entity"] ?? 0) + 1;
        count++;
      }
    }
  }

  // Process questions
  const shouldIncludeQuestions =
    includeQuestions &&
    (requestedCategories === undefined || requestedCategories.includes("question"));
  if (shouldIncludeQuestions) {
    const questionsDir = path.join(memoryDir, "questions");
    if (fs.existsSync(questionsDir)) {
      assertSafeInputRoot(realMemoryDir, questionsDir, "questions root");
      categoryCounts["question"] = 0;
      const qFiles = walkR(questionsDir, realMemoryDir);
      let count = 0;

      for (const filePath of qFiles) {
        if (count >= maxPerCategory) {
          nodesSkipped++;
          continue;
        }

        const content = fs.readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        if (!fm) {
          nodesSkipped++;
          continue;
        }

        const node = projectNode(filePath, "question", fm, content);
        if (!node) {
          nodesSkipped++;
          continue;
        }

        const outputPath = resolveContainedOutputPath(realOutputDir, node.path);
        writeProjectedContent(realOutputDir, outputPath, node.content);

        nodesGenerated++;
        categoryCounts["question"] = (categoryCounts["question"] ?? 0) + 1;
        count++;
      }
    }
  }

  // Write index
  const index = generateIndex(categoryCounts, resolvedOutputDir);
  writeProjectedContent(realOutputDir, resolveContainedOutputPath(realOutputDir, "INDEX.md"), index);

  return {
    nodesGenerated,
    nodesSkipped,
    categories: categoryCounts,
    durationMs: Date.now() - startTime,
    outputDir,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNotSymlink(targetPath: string, label: string): void {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink: ${targetPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function assertSafeInputRoot(realMemoryDir: string, targetPath: string, label: string): void {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${targetPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${targetPath}`);
  }
  const realTarget = fs.realpathSync(targetPath);
  if (!isPathInside(realMemoryDir, realTarget)) {
    throw new Error(`${label} escapes memoryDir: ${targetPath}`);
  }
}

function assertSafeOutputTarget(realOutputDir: string, outputPath: string): void {
  let current = realOutputDir;
  const relative = path.relative(realOutputDir, outputPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`context tree output path escapes outputDir: ${outputPath}`);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`context tree output path contains symlink: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw err;
    }
  }
}

function validateProjectionCategories(categories: string[] | undefined): string[] | undefined {
  if (categories === undefined) {
    return undefined;
  }
  const validated: string[] = [];
  for (const category of categories) {
    if (typeof category !== "string" || !VALID_PROJECTION_CATEGORIES.has(category)) {
      throw new Error(`invalid context tree category: ${String(category)}`);
    }
    if (!validated.includes(category)) {
      validated.push(category);
    }
  }
  return validated;
}

function resolveContainedOutputPath(outputRoot: string, ...segments: string[]): string {
  const resolved = path.resolve(outputRoot, ...segments);
  const relative = path.relative(outputRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`context tree output path escapes outputDir: ${segments.join("/")}`);
}

function writeProjectedContent(realOutputDir: string, outputPath: string, generatedContent: string): void {
  assertSafeOutputTarget(realOutputDir, outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const realParent = fs.realpathSync(path.dirname(outputPath));
  if (!isPathInside(realOutputDir, realParent)) {
    throw new Error(`context tree output path escapes outputDir: ${outputPath}`);
  }
  const existingContent = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8")
    : "";
  fs.writeFileSync(
    outputPath,
    preserveManualFencedBlocks(generatedContent, existingContent),
  );
}

function preserveManualFencedBlocks(
  generatedContent: string,
  existingContent: string,
): string {
  const manualBlocks = extractManualFencedBlocks(existingContent)
    .filter((block) => !generatedContent.includes(block));
  if (manualBlocks.length === 0) {
    return generatedContent;
  }
  return `${generatedContent.trimEnd()}\n\n## Manual Edits\n\n${manualBlocks.join("\n\n")}\n`;
}

function extractManualFencedBlocks(content: string): string[] {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const fencePattern = /(?:^|\n)([`~]{3,})[^\n]*\bmanual\b[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)/gi;
  for (const match of content.matchAll(fencePattern)) {
    const block = match[0].trim();
    if (!seen.has(block)) {
      seen.add(block);
      blocks.push(block);
    }
  }
  return blocks;
}

function walkR(dir: string, realMemoryDir: string): string[] {
  const results: string[] = [];
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`context tree input path contains symlink: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      const realDir = fs.realpathSync(fullPath);
      if (!isPathInside(realMemoryDir, realDir)) {
        throw new Error(`context tree input path escapes memoryDir: ${fullPath}`);
      }
      walk(fullPath);
    } else if (entry.name.endsWith(".md")) {
      const realFile = fs.realpathSync(fullPath);
      if (!isPathInside(realMemoryDir, realFile)) {
        throw new Error(`context tree input path escapes memoryDir: ${fullPath}`);
      }
      results.push(fullPath);
    }
  }
  }
  walk(dir);
  return results;
}

interface Frontmatter {
  id: string;
  category: string;
  created: string;
  updated: string;
  confidence: number;
  confidenceTier: string;
  tags: string[];
  source: string;
  entityRef?: string;
  lifecycleState?: string;
}

function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fmText = match[1];
  const fm: Record<string, unknown> = {};
  for (const line of fmText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "tags") {
      try {
        fm[key] = JSON.parse(value) as string[];
      } catch {
        fm[key] = [] as string[];
      }
    } else if (key === "confidence") {
      const parsed = parseFloat(value);
      fm[key] = Number.isFinite(parsed) ? parsed : 0;
    } else {
      fm[key] = value;
    }
  }
  return fm as unknown as Frontmatter;
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

function projectNode(
  filePath: string,
  category: string,
  fm: Frontmatter,
  rawContent: string,
): TreeNode | null {
  const body = extractBody(rawContent);
  const fileName = path.basename(filePath, ".md");
  const dateDir = path.basename(path.dirname(filePath));

  // Build relative path: category/date/file or just category/file
  let relPath: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) {
    relPath = path.join(category, dateDir, `${fileName}.md`);
  } else {
    relPath = path.join(category, `${fileName}.md`);
  }

  const generatedAt = new Date().toISOString();

  const md = `# ${fm.id}

> **Category:** ${fm.category}
> **Created:** ${fm.created}
> **Updated:** ${fm.updated ?? fm.created}
> **Confidence:** ${fm.confidence} (${fm.confidenceTier}${fm.lifecycleState ? `, ${fm.lifecycleState}` : ""})
${fm.tags?.length ? `\n> **Tags:** ${fm.tags.join(", ")}` : ""}
${fm.entityRef ? `\n> **Entity:** ${fm.entityRef}` : ""}
> **Source:** ${fm.source ?? "unknown"}
> **Projected:** ${generatedAt}

---

${body}
`;

  return {
    path: relPath,
    category,
    title: fm.id,
    content: md,
    sourceAnchors: [fm.id],
    confidence: fm.confidence ?? 0,
    confidenceTier: fm.confidenceTier ?? "unknown",
    generatedAt,
    provenance: [{
      memoryId: fm.id,
      source: fm.source ?? "unknown",
      extracted: fm.created,
    }],
  };
}

function projectEntityNode(fileName: string, content: string): TreeNode {
  const generatedAt = new Date().toISOString();

  const md = `> **Projected:** ${generatedAt}
> **Source:** canonical

---

${content}
`;

  return {
    path: path.join("entities", `${fileName}.md`),
    category: "entity",
    title: fileName,
    content: md,
    sourceAnchors: [fileName],
    confidence: 1,
    confidenceTier: "explicit",
    generatedAt,
    provenance: [{
      memoryId: fileName,
      source: "canonical",
      extracted: generatedAt,
    }],
  };
}

function generateIndex(
  categoryCounts: Record<string, number>,
  outputDir: string,
): string {
  const lines = [
    "# Context Tree Index",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `| Category | Count |`,
    `|----------|-------|`,
  ];

  let total = 0;
  for (const [cat, count] of Object.entries(categoryCounts).sort()) {
    lines.push(`| ${cat} | ${count} |`);
    total += count;
  }

  lines.push("");
  lines.push(`**Total:** ${total} nodes`);
  lines.push("");
  lines.push("## Structure");
  lines.push("");
  lines.push("```");
  lines.push("context-tree/");
  lines.push("├── entities/       # Entity knowledge graph");
  lines.push("├── fact/           # Factual memories (date-partitioned)");
  lines.push("├── correction/    # Correction memories");
  lines.push("├── decision/      # Decisions");
  lines.push("├── moment/        # Notable moments");
  lines.push("├── preference/    # Preferences");
  lines.push("├── principle/     # Principles");
  lines.push("├── question/      # Open questions");
  lines.push("└── INDEX.md        # This file");
  lines.push("```");

  return lines.join("\n") + "\n";
}
