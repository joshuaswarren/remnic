/**
 * @remnic/core — Dedup & Contradiction Detection
 *
 * Statement-level deduplication and contradiction detection
 * against existing memories. Can be used standalone or via curation.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  /** Memory ID */
  id: string;
  /** Content text */
  content: string;
  /** Category */
  category: string;
  /** File path (if known) */
  filePath?: string;
}

export interface DedupOptions {
  /** Memory root directory */
  memoryDir: string;
  /** Categories to scan (default: all) */
  categories?: string[];
  /** Similarity threshold for fuzzy matching (0-1, default: 0.85) */
  threshold?: number;
  /** Max memories to load (default: 10000) */
  maxLoad?: number;
}

export interface DedupResult {
  /** Total memories scanned */
  scanned: number;
  /** Duplicate pairs found */
  duplicates: DuplicatePair[];
  /** Duration in ms */
  durationMs: number;
}

export interface DuplicatePair {
  /** First memory */
  left: MemoryEntry;
  /** Second memory */
  right: MemoryEntry;
  /** Similarity score */
  similarity: number;
  /** Recommended action */
  action: "merge" | "keep_left" | "keep_right";
}

export interface ContradictionOptions {
  /** Memory root directory */
  memoryDir: string;
  /** Categories to scan (default: all) */
  categories?: string[];
  /** Max memories to load (default: 10000) */
  maxLoad?: number;
}

export interface ContradictionResult {
  /** Total memories scanned */
  scanned: number;
  /** Contradictions found */
  contradictions: ContradictionPair[];
  /** Duration in ms */
  durationMs: number;
}

export interface ContradictionPair {
  /** First statement */
  left: MemoryEntry;
  /** Contradicting statement */
  right: MemoryEntry;
  /** Severity */
  severity: "high" | "medium" | "low";
  /** Reason */
  reason: string;
}

// ── Main functions ───────────────────────────────────────────────────────────

const DEFAULT_DEDUP_THRESHOLD = 0.85;
const DEFAULT_MAX_LOAD = 10000;

function normalizeThreshold(value: number | undefined, defaultValue: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : defaultValue;
}

function normalizeMaxLoad(value: number | undefined, defaultValue: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : defaultValue;
}

export function findDuplicates(options: DedupOptions): DedupResult {
  const startTime = Date.now();
  const { memoryDir } = options;
  const threshold = normalizeThreshold(options.threshold, DEFAULT_DEDUP_THRESHOLD);
  const maxLoad = normalizeMaxLoad(options.maxLoad, DEFAULT_MAX_LOAD);

  const memories = loadMemories(memoryDir, options.categories, maxLoad);
  const duplicates: DuplicatePair[] = [];

  // Compare all pairs (O(n^2) but bounded by maxLoad)
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const sim = computeSimilarity(memories[i].content, memories[j].content);
      if (sim >= threshold) {
        duplicates.push({
          left: memories[i],
          right: memories[j],
          similarity: sim,
          action: sim >= 0.98 ? "merge" : sim >= 0.9 ? "keep_right" : "keep_left",
        });
      }
    }
  }

  return {
    scanned: memories.length,
    duplicates,
    durationMs: Date.now() - startTime,
  };
}

export function findContradictions(options: ContradictionOptions): ContradictionResult {
  const startTime = Date.now();
  const { memoryDir } = options;
  const maxLoad = normalizeMaxLoad(options.maxLoad, DEFAULT_MAX_LOAD);

  const memories = loadMemories(memoryDir, options.categories, maxLoad);
  const contradictions: ContradictionPair[] = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const contra = detectContradiction(memories[i], memories[j]);
      if (contra) {
        contradictions.push(contra);
      }
    }
  }

  return {
    scanned: memories.length,
    contradictions,
    durationMs: Date.now() - startTime,
  };
}

// ── Similarity computation ───────────────────────────────────────────────────

function computeSimilarity(a: string, b: string): number {
  // Normalize
  const normA = normalize(a);
  const normB = normalize(b);

  // Exact match
  if (normA === normB) return 1;

  // Hash-based exact match
  if (hashContent(normA) === hashContent(normB)) return 0.99;

  // Substring containment
  if (normA.length > 50 && normB.length > 50) {
    if (normA.includes(normB.slice(0, 40)) || normB.includes(normA.slice(0, 40))) {
      return 0.9;
    }
  }

  // Word overlap (Jaccard)
  const wordsA = new Set(normA.split(/\s+/));
  const wordsB = new Set(normB.split(/\s+/));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Contradiction detection ──────────────────────────────────────────────────

const NEGATION_WORDS = new Set([
  "not", "don't", "doesn't", "isn't", "aren't", "won't", "can't", "cannot",
  "never", "no", "none", "neither", "nor", "nothing", "nowhere",
]);

function detectContradiction(
  a: MemoryEntry,
  b: MemoryEntry,
): ContradictionPair | null {
  const normA = normalize(a.content);
  const normB = normalize(b.content);

  // Check if one has negation and the other doesn't
  const aHasNegation = containsNegation(normA);
  const bHasNegation = containsNegation(normB);

  if (aHasNegation === bHasNegation) return null;

  // Strip negation and compare core content
  const strippedA = stripNegation(normA);
  const strippedB = stripNegation(normB);

  const sim = computeSimilarity(strippedA, strippedB);
  if (sim < 0.7) return null;

  // Check for opposite quantifiers
  const oppQuantifiers = [
    ["always", "never"],
    ["all", "none"],
    ["every", "no"],
    ["must", "must not"],
    ["should", "should not"],
    ["can", "cannot"],
  ];

  for (const [pos, neg] of oppQuantifiers) {
    if (
      (a.content.toLowerCase().includes(pos) && b.content.toLowerCase().includes(neg)) ||
      (a.content.toLowerCase().includes(neg) && b.content.toLowerCase().includes(pos))
    ) {
      return {
        left: a,
        right: b,
        severity: "high",
        reason: `Opposite quantifiers: "${pos}" vs "${neg}"`,
      };
    }
  }

  return {
    left: a,
    right: b,
    severity: sim >= 0.85 ? "high" : "medium",
    reason: "Negated version of similar content",
  };
}

function containsNegation(text: string): boolean {
  const words = text.split(/\s+/);
  return words.some((w) => NEGATION_WORDS.has(w));
}

function stripNegation(text: string): string {
  return text
    .replace(/\b(not|don't|doesn't|isn't|aren't|won't|can't|cannot|never|no|none|neither|nor|nothing|nowhere)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Memory loading ───────────────────────────────────────────────────────────

function loadMemories(
  memoryDir: string,
  categories?: string[],
  maxLoad = 10000,
): MemoryEntry[] {
  const result: MemoryEntry[] = [];
  const allCategories = categories ?? ALL_CATEGORY_DIRS;
  if (!fs.existsSync(memoryDir)) return result;
  const memoryRootReal = fs.realpathSync(memoryDir);

  for (const category of allCategories) {
    if (result.length >= maxLoad) break;

    const dir = path.join(memoryDir, category);
    if (!fs.existsSync(dir)) continue;
    const categoryStat = fs.lstatSync(dir);
    if (categoryStat.isSymbolicLink()) {
      throw new Error(`Refusing to scan symlinked memory category directory: ${dir}`);
    }
    if (!categoryStat.isDirectory()) continue;
    const categoryRootReal = fs.realpathSync(dir);
    assertPathInsideRoot(memoryRootReal, categoryRootReal, dir);

    walkMdFiles(dir, memoryRootReal, categoryRootReal, (filePath) => {
      if (result.length >= maxLoad) return;

      const content = readFileSafe(filePath, memoryRootReal, categoryRootReal);
      if (!content) return;

      const fm = parseFrontmatter(content);
      const body = extractBody(content);
      if (!fm?.id || !body) return;

      result.push({
        id: fm.id as string,
        content: body,
        category: (fm.category as string) ?? category.slice(0, -1),
        filePath,
      });
    });
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function readFileSafe(
  filePath: string,
  memoryRootReal: string,
  categoryRootReal: string,
): string | null {
  try {
    const fileStat = fs.lstatSync(filePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Refusing to read symlinked memory file: ${filePath}`);
    }
    const fileReal = fs.realpathSync(filePath);
    assertPathInsideRoot(memoryRootReal, fileReal, filePath);
    assertPathInsideRoot(categoryRootReal, fileReal, filePath);
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }
  return fm;
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

function assertPathInsideRoot(rootReal: string, targetReal: string, sourcePath: string): void {
  const rel = path.relative(rootReal, targetReal);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return;
  }
  throw new Error(`Refusing to scan memory path outside root: ${sourcePath}`);
}

function walkMdFiles(
  dir: string,
  memoryRootReal: string,
  categoryRootReal: string,
  callback: (filePath: string) => void,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const entryStat = fs.lstatSync(fullPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Refusing to scan symlinked memory path: ${fullPath}`);
    }
    const entryReal = fs.realpathSync(fullPath);
    assertPathInsideRoot(memoryRootReal, entryReal, fullPath);
    assertPathInsideRoot(categoryRootReal, entryReal, fullPath);
    if (entryStat.isDirectory()) {
      walkMdFiles(fullPath, memoryRootReal, categoryRootReal, callback);
    } else if (entry.name.endsWith(".md")) {
      callback(fullPath);
    }
  }
}
