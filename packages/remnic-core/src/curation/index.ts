/**
 * @remnic/core — Curation
 *
 * Deliberate ingestion of files into memory with provenance tracking.
 * Supports statement-level extraction, dedup, and contradiction checks.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getCategoryDir, ALL_CATEGORY_DIRS } from "../utils/category-dir.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CurateOptions {
  /** File or directory path to curate */
  targetPath: string;
  /** Memory root directory for writing */
  memoryDir: string;
  /** Source label (e.g. "manual", "docs", "onboarding") */
  source?: string;
  /** Category override (default: auto-detect) */
  category?: string;
  /** Confidence to assign (default: 0.9 for curated items) */
  confidence?: number;
  /** Entity reference to attach */
  entityRef?: string;
  /** Tags to add */
  tags?: string[];
  /** Whether to perform dedup check against existing memories */
  checkDuplicates?: boolean;
  /** Whether to detect contradictions */
  checkContradictions?: boolean;
  /** Whether to write files (default: true). False = dry run */
  write?: boolean;
}

export interface CuratedStatement {
  /** Unique ID for this statement */
  id: string;
  /** The extracted statement text */
  content: string;
  /** Category */
  category: string;
  /** Confidence */
  confidence: number;
  /** Provenance info */
  provenance: StatementProvenance;
  /** Hash of content for dedup */
  contentHash: string;
  /** Tags */
  tags: string[];
  /** Entity reference */
  entityRef?: string;
}

export interface StatementProvenance {
  /** Source file path */
  sourcePath: string;
  /** Relative path from project root */
  relativePath: string;
  /** Source label */
  source: string;
  /** Line number if extractable (0 = unknown) */
  lineNumber: number;
  /** Timestamp of ingestion */
  ingestedAt: string;
  /** Hash of the source file for diff tracking */
  sourceFileHash: string;
}

export interface CurateResult {
  /** Statements extracted */
  statements: CuratedStatement[];
  /** Files processed */
  filesProcessed: number;
  /** Files skipped (empty, binary, etc.) */
  filesSkipped: number;
  /** Duplicate statements found (if checkDuplicates) */
  duplicates: DuplicateResult[];
  /** Contradictions found (if checkContradictions) */
  contradictions: ContradictionResult[];
  /** Memory files written */
  written: string[];
  /** Duration in ms */
  durationMs: number;
}

export interface DuplicateResult {
  /** New statement */
  newStatement: CuratedStatement;
  /** Existing memory ID that matches */
  existingId: string;
  /** Similarity score (0-1) */
  similarity: number;
  /** Recommended action */
  action: "skip" | "merge" | "keep";
}

export interface ContradictionResult {
  /** New statement */
  newStatement: CuratedStatement;
  /** Conflicting memory ID */
  conflictingId: string;
  /** The conflicting content */
  conflictingContent: string;
  /** Severity */
  severity: "high" | "medium" | "low";
}

// ── Main function ────────────────────────────────────────────────────────────

export async function curate(options: CurateOptions): Promise<CurateResult> {
  const startTime = Date.now();
  const {
    targetPath,
    memoryDir,
    source = "curation",
    category: categoryOverride,
    confidence = 0.9,
    entityRef,
    tags = [],
    checkDuplicates = true,
    checkContradictions = false,
    write = true,
  } = options;

  const statements: CuratedStatement[] = [];
  const written: string[] = [];
  const duplicates: DuplicateResult[] = [];
  const contradictions: ContradictionResult[] = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  // Determine targets
  const targets = resolveTargets(targetPath);
  const provenanceRoot = resolveProvenanceRoot(targetPath);

  // Load existing memories for dedup/contradiction checks
  const existingMemories = checkDuplicates || checkContradictions
    ? loadExistingMemories(memoryDir)
    : new Map();

  // Process each file
  for (const filePath of targets) {
    const content = readFileSafe(filePath);
    if (!content) {
      filesSkipped++;
      continue;
    }

    if (isBinary(content)) {
      filesSkipped++;
      continue;
    }

    filesProcessed++;

    const sourceFileHash = hashContent(content);
    const fileStatements = extractStatements(
      content,
      filePath,
      provenanceRoot,
      source,
      sourceFileHash,
      categoryOverride,
      confidence,
      entityRef,
      tags,
    );

    for (const stmt of fileStatements) {
      // Dedup check
      if (checkDuplicates) {
        const dup = findDuplicate(stmt, existingMemories);
        if (dup) {
          duplicates.push(dup);
          if (dup.action === "skip") continue;
        }
      }

      // Contradiction check
      if (checkContradictions) {
        const contra = findContradiction(stmt, existingMemories);
        if (contra) {
          contradictions.push(contra);
        }
      }

      statements.push(stmt);

      // Write to memory
      if (write) {
        const writtenPath = writeStatement(stmt, memoryDir);
        written.push(writtenPath);
        existingMemories.set(stmt.contentHash, {
          id: stmt.id,
          content: stmt.content,
          category: stmt.category,
        });
      }
    }
  }

  return {
    statements,
    filesProcessed,
    filesSkipped,
    duplicates,
    contradictions,
    written,
    durationMs: Date.now() - startTime,
  };
}

// ── Target resolution ────────────────────────────────────────────────────────

function resolveTargets(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  // Directory — walk for .md, .txt, .mdx
  const results: string[] = [];
  const extensions = new Set([".md", ".txt", ".mdx", ".rst"]);

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") {
          walk(fullPath);
        }
      } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  walk(targetPath);
  return results;
}

function resolveProvenanceRoot(targetPath: string): string {
  const resolvedTarget = path.resolve(targetPath);
  const stat = fs.statSync(resolvedTarget);
  return stat.isFile() ? path.dirname(resolvedTarget) : resolvedTarget;
}

// ── Statement extraction ─────────────────────────────────────────────────────

function extractStatements(
  content: string,
  filePath: string,
  projectRoot: string,
  source: string,
  sourceFileHash: string,
  categoryOverride: string | undefined,
  confidence: number,
  entityRef: string | undefined,
  tags: string[],
): CuratedStatement[] {
  const relativePath = path.relative(projectRoot, path.resolve(filePath)) || path.basename(filePath);
  const statements: CuratedStatement[] = [];
  const now = new Date().toISOString();

  // Split content into paragraphs/lines and extract meaningful statements
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20 && p.length < 2000);

  // Also extract list items
  const listItems = content
    .split("\n")
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l.length > 10 && l.length < 500);

  const allItems = [...paragraphs, ...listItems];

  // Deduplicate within file
  const seen = new Set<string>();
  for (const item of allItems) {
    const hash = hashContent(item.toLowerCase());
    if (seen.has(hash)) continue;
    seen.add(hash);

    const id = generateId();
    const category = categoryOverride ?? detectCategory(item);

    statements.push({
      id,
      content: item,
      category,
      confidence,
      provenance: {
        sourcePath: filePath,
        relativePath,
        source,
        lineNumber: 0,
        ingestedAt: now,
        sourceFileHash,
      },
      contentHash: hash,
      tags: [...tags],
      entityRef,
    });
  }

  return statements;
}

// ── Category detection ───────────────────────────────────────────────────────

function detectCategory(text: string): string {
  const lower = text.toLowerCase();

  if (/^(always|never|must|should|don't|avoid|ensure)/.test(lower)) return "principle";
  if (/^(we|team|project)\s+(decided|chose|will|use)/.test(lower)) return "decision";
  if (/^(i|we)\s+(prefer|like|want|hate|dislike)/.test(lower)) return "preference";
  if (/fix|bug|issue|broken|error/i.test(lower)) return "correction";
  if (/\?.+$/.test(lower.trim())) return "question";

  return "fact";
}

// ── Dedup ────────────────────────────────────────────────────────────────────

interface ExistingMemory {
  id: string;
  content: string;
  category: string;
}

function findDuplicate(
  stmt: CuratedStatement,
  existing: Map<string, ExistingMemory>,
): DuplicateResult | null {
  const stmtLower = stmt.content.toLowerCase();

  // Exact hash match
  const exactMatch = existing.get(stmt.contentHash);
  if (exactMatch) {
    return {
      newStatement: stmt,
      existingId: exactMatch.id,
      similarity: 1,
      action: "skip",
    };
  }

  // Fuzzy match — check substring containment
  for (const [_, mem] of existing) {
    const memLower = mem.content.toLowerCase();
    if (memLower.length > 50 && stmtLower.length > 50) {
      // Check if one contains the other
      if (memLower.includes(stmtLower.slice(0, 40)) || stmtLower.includes(memLower.slice(0, 40))) {
        return {
          newStatement: stmt,
          existingId: mem.id,
          similarity: 0.85,
          action: "skip",
        };
      }
    }
  }

  return null;
}

// ── Contradiction detection ──────────────────────────────────────────────────

function findContradiction(
  stmt: CuratedStatement,
  existing: Map<string, ExistingMemory>,
): ContradictionResult | null {
  const negationPatterns = [
    /\b(not|don't|doesn't|isn't|aren't|won't|can't|never|no)\b/i,
  ];

  const hasNegation = negationPatterns.some((p) => p.test(stmt.content));
  if (!hasNegation) return null;

  // Strip negation and look for positive version
  const stripped = stmt.content
    .toLowerCase()
    .replace(/\b(not|don't|doesn't|isn't|aren't|won't|can't|never|no)\b/gi, "")
    .trim();

  if (stripped.length < 20) return null;

  for (const [_, mem] of existing) {
    const memLower = mem.content.toLowerCase();
    // If an existing memory affirms what this statement negates
    if (memLower.includes(stripped.slice(0, Math.min(30, stripped.length)))) {
      return {
        newStatement: stmt,
        conflictingId: mem.id,
        conflictingContent: mem.content,
        severity: "high",
      };
    }
  }

  return null;
}

// ── Memory loading ───────────────────────────────────────────────────────────

function loadExistingMemories(memoryDir: string): Map<string, ExistingMemory> {
  const result = new Map<string, ExistingMemory>();
  if (!fs.existsSync(memoryDir)) return result;

  // Walk all known category dirs for existing memories
  const dirs = ALL_CATEGORY_DIRS;
  for (const dir of dirs) {
    const fullDir = path.join(memoryDir, dir);
    if (!fs.existsSync(fullDir)) continue;

    walkFiles(fullDir, (filePath) => {
      const content = readFileSafe(filePath);
      if (!content) return;

      const fm = parseFrontmatter(content);
      const body = extractBody(content);
      if (!fm?.id || !body) return;

      const hash = hashContent(body.toLowerCase());
      result.set(hash, {
        id: fm.id,
        content: body,
        category: fm.category ?? dir.slice(0, -1),
      });
    });
  }

  return result;
}

// ── Writing ──────────────────────────────────────────────────────────────────

function writeStatement(stmt: CuratedStatement, memoryDir: string): string {
  const now = new Date();
  const dateDir = now.toISOString().split("T")[0];
  const categoryDir = getCategoryDir(memoryDir, stmt.category);

  const dir = path.join(categoryDir, dateDir);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = `${stmt.category}-${Date.now()}-${stmt.id.slice(0, 8)}.md`;
  const filePath = path.join(dir, fileName);

  const frontmatter = [
    "---",
    `id: ${stmt.id}`,
    `category: ${stmt.category}`,
    `created: ${stmt.provenance.ingestedAt}`,
    `updated: ${stmt.provenance.ingestedAt}`,
    `confidence: ${stmt.confidence}`,
    `confidenceTier: ${tierFromConfidence(stmt.confidence)}`,
    `source: ${stmt.provenance.source}`,
    `tags: ${JSON.stringify(stmt.tags)}`,
    stmt.entityRef ? `entityRef: ${stmt.entityRef}` : null,
    `provenanceFile: ${stmt.provenance.relativePath}`,
    `provenanceHash: ${stmt.provenance.sourceFileHash}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const body = `${frontmatter}\n\n${stmt.content}\n`;

  fs.writeFileSync(filePath, body);
  return filePath;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function tierFromConfidence(confidence: number): string {
  if (confidence >= 0.95) return "explicit";
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isBinary(content: string): boolean {
  // Simple heuristic: if content has null bytes, it's binary
  for (let i = 0; i < Math.min(content.length, 8000); i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

interface SimpleFrontmatter {
  id?: string;
  category?: string;
  [key: string]: unknown;
}

function parseFrontmatter(content: string): SimpleFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: SimpleFrontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    (fm as Record<string, unknown>)[key] = value;
  }
  return fm;
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

function walkFiles(dir: string, callback: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, callback);
    } else if (entry.name.endsWith(".md")) {
      callback(fullPath);
    }
  }
}
