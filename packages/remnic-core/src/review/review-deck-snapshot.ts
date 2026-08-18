import fs from "node:fs";
import path from "node:path";
import { MEMORY_CORPUS_VERSION_SENTINEL } from "../memory-corpus-version.js";
import {
  computeReviewItemRevision,
  type ReviewDeckSnapshot,
  type ReviewDeckSourceRow,
} from "./review-deck.js";

const QUEUE_DIRS = ["suggestions", "review"] as const;

export function readReviewDeckSnapshot(opts: { memoryDir: string; namespace: string }): ReviewDeckSnapshot {
  const corpusVersion = readCorpusVersion(opts.memoryDir);
  const rootReal = realMemoryRoot(opts.memoryDir);
  if (!rootReal) return { corpusVersion, total: 0, rows: [] };

  const rows: ReviewDeckSourceRow[] = [];
  for (const location of QUEUE_DIRS) {
    const dir = path.join(opts.memoryDir, location);
    if (!fs.existsSync(dir) || !isSafeDirectory(rootReal, dir)) continue;
    walkMd(rootReal, dir, (filePath, content) => {
      const row = rowFromQueueFile(filePath, content, location);
      if (row) rows.push(row);
    });
  }
  return { corpusVersion, total: rows.length, rows };
}

export function readReviewDeckRow(opts: { memoryDir: string; itemId: string }): ReviewDeckSourceRow | null {
  const rootReal = realMemoryRoot(opts.memoryDir);
  if (!rootReal) return null;
  for (const location of QUEUE_DIRS) {
    const dir = path.join(opts.memoryDir, location);
    if (!fs.existsSync(dir) || !isSafeDirectory(rootReal, dir)) continue;
    let found: ReviewDeckSourceRow | null = null;
    walkMd(rootReal, dir, (filePath, content) => {
      const row = rowFromQueueFile(filePath, content, location);
      if (row?.itemId === opts.itemId) {
        found = row;
        return true;
      }
    });
    if (found) return found;
  }
  return null;
}

function readCorpusVersion(memoryDir: string): string {
  try {
    return String(fs.statSync(path.join(memoryDir, "state", MEMORY_CORPUS_VERSION_SENTINEL)).size);
  } catch {
    return "0";
  }
}

function rowFromQueueFile(
  filePath: string,
  content: string,
  location: (typeof QUEUE_DIRS)[number],
): ReviewDeckSourceRow | null {
  const fm = parseFrontmatter(content);
  const itemId = optionalString(fm?.id);
  if (!fm || !itemId || !isPendingQueueRow(fm)) return null;
  const blockedBy = optionalString(fm.blockedBy);
  const confidence = parseOptionalConfidence(fm.confidence);
  const category = optionalString(fm.category);
  const confidenceTier = optionalString(fm.confidenceTier);
  const source = optionalString(fm.source);
  const context = optionalString(fm.context);
  const lifecycleState = optionalString(fm.lifecycleState) ?? optionalString(fm.status);
  const created = optionalString(fm.created) ?? "";
  const explicitReason = optionalString(fm.reviewReason);
  return {
    itemId,
    filePath,
    fileContent: content,
    revision: computeReviewItemRevision(content),
    content: extractBody(content),
    reviewReason: explicitReason
      ?? (blockedBy ? "tombstone_blocked" : location === "suggestions" ? "suggestion" : "low_confidence"),
    created,
    ...(category ? { category } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(confidenceTier ? { confidenceTier } : {}),
    ...(source ? { source } : {}),
    ...(blockedBy ? { blockedBy } : {}),
    ...(lifecycleState ? { lifecycleState } : {}),
    ...(context ? { context } : {}),
  };
}

function isPendingQueueRow(fm: Record<string, unknown>): boolean {
  if (parseBoolean(fm.reviewDismissed)) return false;
  const status = optionalString(fm.status);
  return status === undefined || status === "pending_review";
}

function realMemoryRoot(memoryDir: string): string | null {
  try {
    const stat = fs.lstatSync(memoryDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return fs.realpathSync(memoryDir);
  } catch {
    return null;
  }
}

function isPathInside(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafeDirectory(rootReal: string, dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return isPathInside(rootReal, fs.realpathSync(dir));
  } catch {
    return false;
  }
}

function walkMd(
  rootReal: string,
  dir: string,
  callback: (filePath: string, content: string) => boolean | void,
): boolean {
  if (!isSafeDirectory(rootReal, dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (walkMd(rootReal, fullPath, callback)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = readFileSafe(fullPath);
      if (content && callback(fullPath, content) === true) return true;
    }
  }
  return false;
}

function readFileSafe(filePath: string): string | null {
  try {
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
    fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }
  return fm;
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalConfidence(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
