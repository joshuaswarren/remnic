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
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  HistoricalEntityCanonicalIdCache,
  canonicalizeEntityRefFrontmatter,
  repairContentAfterJournalMoveSync,
} from "../storage/entity-canonical-id-references.js";


export interface CurateOptions {
  targetPath: string;
  memoryDir: string;
  /** Source label (e.g. "manual", "docs", "onboarding") */
  source?: string;
  /** Category override (default: auto-detect) */
  category?: string;
  /** Confidence to assign (default: 0.9 for curated items) */
  confidence?: number;
  entityRef?: string;
  tags?: string[];
  /** Whether to perform dedup check against existing memories */
  checkDuplicates?: boolean;
  checkContradictions?: boolean;
  /** Whether to write files (default: true). False = dry run */
  write?: boolean;
}

export interface CuratedStatement {
  id: string;
  content: string;
  category: string;
  confidence: number;
  provenance: StatementProvenance;
  /** Hash of content for dedup */
  contentHash: string;
  tags: string[];
  entityRef?: string;
}

export interface StatementProvenance {
  sourcePath: string;
  /** Relative path from project root */
  relativePath: string;
  source: string;
  /** Line number if extractable (0 = unknown) */
  lineNumber: number;
  ingestedAt: string;
  /** Hash of the source file for diff tracking */
  sourceFileHash: string;
}

export interface CurateResult {
  statements: CuratedStatement[];
  filesProcessed: number;
  /** Files skipped (empty, binary, etc.) */
  filesSkipped: number;
  /** Duplicate statements found (if checkDuplicates) */
  duplicates: DuplicateResult[];
  /** Contradictions found (if checkContradictions) */
  contradictions: ContradictionResult[];
  written: string[];
  /** Duration in ms */
  durationMs: number;
}

export interface DuplicateResult {
  newStatement: CuratedStatement;
  existingId: string;
  /** Similarity score (0-1) */
  similarity: number;
  action: "skip" | "merge" | "keep";
}

export interface ContradictionResult {
  /** New statement */
  newStatement: CuratedStatement;
  conflictingId: string;
  conflictingContent: string;
  severity: "high" | "medium" | "low";
}


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

  const targets = resolveTargets(targetPath);
  const provenanceRoot = resolveProvenanceRoot(targetPath);

  const existingMemories = checkDuplicates || checkContradictions
    ? loadExistingMemories(memoryDir)
    : new Map();

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
      if (checkDuplicates) {
        const dup = findDuplicate(stmt, existingMemories);
        if (dup) {
          duplicates.push(dup);
          if (dup.action === "skip") continue;
        }
      }

      if (checkContradictions) {
        const contra = findContradiction(stmt, existingMemories);
        if (contra) {
          contradictions.push(contra);
        }
      }

      statements.push(stmt);

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

  // same-process readAllMemories mid-batch never serves a stale/partial corpus
  // (Cursor Medium, #1902); no after-loop bump needed here.

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


function resolveTargets(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

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

  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20 && p.length < 2000);

  const listItems = content
    .split("\n")
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l.length > 10 && l.length < 500);

  const allItems = [...paragraphs, ...listItems];

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


function detectCategory(text: string): string {
  const lower = text.toLowerCase();

  if (/^(always|never|must|should|don't|avoid|ensure)/.test(lower)) return "principle";
  if (/^(we|team|project)\s+(decided|chose|will|use)/.test(lower)) return "decision";
  if (/^(i|we)\s+(prefer|like|want|hate|dislike)/.test(lower)) return "preference";
  if (/fix|bug|issue|broken|error/i.test(lower)) return "correction";
  if (/\?.+$/.test(lower.trim())) return "question";

  return "fact";
}


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

  const exactMatch = existing.get(stmt.contentHash);
  if (exactMatch) {
    return {
      newStatement: stmt,
      existingId: exactMatch.id,
      similarity: 1,
      action: "skip",
    };
  }

  for (const [_, mem] of existing) {
    const memLower = mem.content.toLowerCase();
    if (memLower.length > 50 && stmtLower.length > 50) {
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


function findContradiction(
  stmt: CuratedStatement,
  existing: Map<string, ExistingMemory>,
): ContradictionResult | null {
  const negationPatterns = [
    /\b(not|don't|doesn't|isn't|aren't|won't|can't|never|no)\b/i,
  ];

  const hasNegation = negationPatterns.some((p) => p.test(stmt.content));
  if (!hasNegation) return null;

  const stripped = stmt.content
    .toLowerCase()
    .replace(/\b(not|don't|doesn't|isn't|aren't|won't|can't|never|no)\b/gi, "")
    .trim();

  if (stripped.length < 20) return null;

  for (const [_, mem] of existing) {
    const memLower = mem.content.toLowerCase();
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


function loadExistingMemories(memoryDir: string): Map<string, ExistingMemory> {
  const result = new Map<string, ExistingMemory>();
  if (!fs.existsSync(memoryDir)) return result;

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


// entity references too (issue #2213): resolve through the target's journal.
const historicalIdCache = new HistoricalEntityCanonicalIdCache();

function writeStatement(stmt: CuratedStatement, memoryDir: string): string {
  const now = new Date();
  const dateDir = now.toISOString().split("T")[0];
  const categoryDir = getCategoryDir(memoryDir, stmt.category);

  const dir = path.join(categoryDir, dateDir);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = `${stmt.category}-${Date.now()}-${stmt.id.slice(0, 8)}.md`;
  const filePath = path.join(dir, fileName);
  const historicalIds = historicalIdCache.get(path.join(memoryDir, "state"));

  // re-resolve from it, including the direction where a mapping was parked
  // and the resolution falls back to the legacy claimant (issue #2213).
  const rawBody = `${[
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
    .join("\n")}\n\n${stmt.content}\n`;
  const body = canonicalizeEntityRefFrontmatter(rawBody, historicalIds);

  fs.writeFileSync(filePath, body);
  // across this write would otherwise strand the reference — the corpus bump
  // below no longer re-triggers the migration, and a parked mapping cannot be
  // fixed after the fact by the reconcile pass. On repair exhaustion, remove
  // the just-created file so the retryable error leaves no untracked partial
  // statement (a retry would otherwise duplicate it).
  try {
    repairContentAfterJournalMoveSync({
      stateDir: path.join(memoryDir, "state"),
      cache: historicalIdCache,
      idsAtWrite: historicalIds,
      rawContent: rawBody,
      lastWritten: body,
      rewrite: (next) => fs.writeFileSync(filePath, next),
    });
  } catch (err) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best effort — the retryable repair error is the primary signal.
    }
    throw err;
  }
  // same-process readAllMemories rescans and sees this statement immediately,
  // never a stale/partial corpus mid-batch (Cursor Medium, #1902). AFTER the
  // repair, so a rescan never captures pre-repair bytes.
  bumpMemoryCorpusVersionForDir(memoryDir);
  return filePath;
}


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
