/**
 * @remnic/core — Review Inbox
 *
 * Manages low-confidence memories and suggestions pending review.
 * Integrates with the existing review-queue system.
 */

import fs from "node:fs";
import path from "node:path";
import { getCategoryDir, ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  HistoricalEntityCanonicalIdCache,
  canonicalizeEntityRefFrontmatter,
  repairContentAfterJournalMoveSync,
} from "../storage/entity-canonical-id-references.js";

// Write-boundary journal cache for review-queue promotions (issue #2213).
const historicalIdCache = new HistoricalEntityCanonicalIdCache();

/**
 * In-place raw rewrite under the uniform write-boundary rule (issue #2213):
 * canonicalize the effective entityRef at the write and REPAIR when the
 * journal moved across it — these rewrites re-serialize whole records, so an
 * unrelated approve/dismiss/flag must not write a legacy ref back out. On
 * repair exhaustion the ORIGINAL bytes are restored before the retryable
 * error propagates: performReview bumps the corpus sentinel only after the
 * action returns, so a half-applied rewrite would be invisible to a warm
 * cache while the caller is told the action failed.
 */
function writeReviewFileCanonicalized(memoryDir: string, filePath: string, content: string): void {
  const stateDir = path.join(memoryDir, "state");
  const idsAtWrite = historicalIdCache.get(stateDir);
  let originalBytes: string | null = null;
  try {
    originalBytes = fs.readFileSync(filePath, "utf8");
  } catch {
    originalBytes = null; // new file — rollback is removal
  }
  const written = canonicalizeEntityRefFrontmatter(content, idsAtWrite);
  fs.writeFileSync(filePath, written, "utf8");
  try {
    repairContentAfterJournalMoveSync({
      stateDir,
      cache: historicalIdCache,
      idsAtWrite,
      rawContent: content,
      lastWritten: written,
      rewrite: (next) => fs.writeFileSync(filePath, next, "utf8"),
    });
  } catch (err) {
    try {
      if (originalBytes === null) {
        fs.unlinkSync(filePath);
      } else {
        fs.writeFileSync(filePath, originalBytes, "utf8");
      }
    } catch {
      // Best effort — the retryable repair error is the primary signal.
    }
    throw err;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewItem {
  /** Memory ID */
  id: string;
  /** Content text */
  content: string;
  /** Category */
  category: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Confidence tier */
  confidenceTier: string;
  /** Source */
  source: string;
  /** File path if available */
  filePath?: string;
  /** Created date */
  created: string;
  /** Reason it's in review */
  reviewReason: "low_confidence" | "suggestion" | "contradiction" | "duplicate" | "tombstone_blocked";
  /** Additional context */
  context?: string;
}

export type ReviewAction = "approve" | "dismiss" | "flag";

export interface ReviewResult {
  /** Item acted upon */
  itemId: string;
  /** Action taken */
  action: ReviewAction;
  /** Updated file path (if modified) */
  updatedPath?: string;
  /** Status message */
  message: string;
  /** Tombstone id cleared by an approve action (for the caller to revoke). */
  clearedTombstoneId?: string;
}

export interface ReviewListResult {
  /** Items pending review */
  items: ReviewItem[];
  /** Total count */
  total: number;
  /** Duration in ms */
  durationMs: number;
}

export interface ReviewOptions {
  /** Memory root directory */
  memoryDir: string;
  /** Filter by reason */
  reason?: ReviewItem["reviewReason"];
  /** Max items to return (default: 50) */
  limit?: number;
  /** Include items with confidence below this threshold (default: 0.7) */
  confidenceThreshold?: number;
}

export interface ReviewActionOptions {
  /** Match the threshold used when listing review items (default: 0.7) */
  confidenceThreshold?: number;
  /**
   * Revocation hook (issue #1579). When approving a memory whose frontmatter
   * carries `blockedBy: <tombstoneId>`, the hook fires so the caller (CLI /
   * orchestrator) can append a `kind: "revocation"` tombstone entry —
   * re-allowing the content. Fire-and-forget: a revocation failure MUST NOT
   * fail the approval (gotcha #13). The hook receives the tombstone id and
   * the memory id.
   */
  onApproveBlockedMemory?: (tombstoneId: string, memoryId: string) => void | Promise<void>;
}

interface ReviewFileMatch {
  filePath: string;
  location: "queue" | "category";
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

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

function ensureSafeDirectory(rootReal: string, dir: string): void {
  if (fs.existsSync(dir)) {
    if (!isSafeDirectory(rootReal, dir)) {
      throw new Error(`Refusing to write through unsafe review path: ${dir}`);
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!isSafeDirectory(rootReal, dir)) {
    throw new Error(`Refusing to write through unsafe review path: ${dir}`);
  }
}

// ── Main functions ───────────────────────────────────────────────────────────

/**
 * List items pending review.
 */
export function listReviewItems(options: ReviewOptions): ReviewListResult {
  const startTime = Date.now();
  const {
    memoryDir,
    reason: filterReason,
    limit = 50,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  } = options;
  const maxItems = Math.max(0, limit);
  const rootReal = realMemoryRoot(memoryDir);
  if (!rootReal || maxItems === 0) {
    return { items: [], total: 0, durationMs: Date.now() - startTime };
  }

  const items: ReviewItem[] = [];
  const isLimitReached = (): boolean => items.length >= maxItems;
  const addItem = (item: ReviewItem): void => {
    if (isLimitReached()) return;
    if (filterReason && item.reviewReason !== filterReason) return;
    items.push(item);
  };

  // Check suggestions directory
  const suggestionsDir = path.join(memoryDir, "suggestions");
  if (!isLimitReached() && fs.existsSync(suggestionsDir) && isSafeDirectory(rootReal, suggestionsDir)) {
    walkMd(rootReal, suggestionsDir, (filePath, content) => {
      if (isLimitReached()) return true;

      const fm = parseFrontmatter(content);
      const body = extractBody(content);
      if (!fm?.id) return false;

      addItem({
        id: fm.id as string,
        content: body,
        category: (fm.category as string) ?? "suggestion",
        confidence: parseConfidence(fm.confidence, 0.5),
        confidenceTier: (fm.confidenceTier as string) ?? "low",
        source: (fm.source as string) ?? "unknown",
        filePath,
        created: (fm.created as string) ?? new Date().toISOString(),
        reviewReason: "suggestion",
      });
      return isLimitReached();
    });
  }

  // Check review directory
  const reviewDir = path.join(memoryDir, "review");
  if (!isLimitReached() && fs.existsSync(reviewDir) && isSafeDirectory(rootReal, reviewDir)) {
    walkMd(rootReal, reviewDir, (filePath, content) => {
      if (isLimitReached()) return true;

      const fm = parseFrontmatter(content);
      const body = extractBody(content);
      if (!fm?.id) return false;

      addItem({
        id: fm.id as string,
        content: body,
        category: (fm.category as string) ?? "review",
        confidence: parseConfidence(fm.confidence, 0.5),
        confidenceTier: (fm.confidenceTier as string) ?? "low",
        source: (fm.source as string) ?? "unknown",
        filePath,
        created: (fm.created as string) ?? new Date().toISOString(),
        reviewReason: (fm.reviewReason as ReviewItem["reviewReason"]) ?? "low_confidence",
        context: fm.context as string | undefined,
      });
      return isLimitReached();
    });
  }

  // Scan all categories for low-confidence items
  const categories = ALL_CATEGORY_DIRS;
  for (const category of categories) {
    if (isLimitReached()) break;

    const dir = path.join(memoryDir, category);
    if (!fs.existsSync(dir) || !isSafeDirectory(rootReal, dir)) continue;

    walkMd(rootReal, dir, (filePath, content) => {
      if (isLimitReached()) return true;

      const fm = parseFrontmatter(content);
      const body = extractBody(content);
      if (!fm?.id) return false;

      const confidence = parseConfidence(fm.confidence, 1);
      if (confidence >= confidenceThreshold && !(typeof fm.blockedBy === "string" && fm.blockedBy.length > 0)) return false;
      if (parseBoolean(fm.reviewDismissed)) return false;

      // Skip if already in items
      if (items.some((i) => i.id === fm.id)) return false;

      addItem({
        id: fm.id as string,
        content: body,
        category: (fm.category as string) ?? category.slice(0, -1),
        confidence,
        confidenceTier: (fm.confidenceTier as string) ?? "low",
        source: (fm.source as string) ?? "unknown",
        filePath,
        created: (fm.created as string) ?? new Date().toISOString(),
        reviewReason: (typeof fm.blockedBy === "string" && fm.blockedBy.length > 0) ? "tombstone_blocked" : "low_confidence",
      });
      return isLimitReached();
    });
  }

  return {
    items,
    total: items.length,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Perform a review action on an item.
 */
export function performReview(
  memoryDir: string,
  itemId: string,
  action: ReviewAction,
  options: ReviewActionOptions = {},
): ReviewResult {
  const result =
    action === "approve"
      ? approveItem(memoryDir, itemId, options)
      : action === "dismiss"
        ? dismissItem(memoryDir, itemId, options)
        : flagItem(memoryDir, itemId, options);
  // Review approval/dismissal/flagging edits, moves, or removes memory files
  // directly (out-of-band — it does not go through a StorageManager mutation
  // method), so bump the corpus sentinel to force the version-keyed hot cache
  // to rescan on its next read (issue #1902). Only bump when a file was
  // actually modified/moved (updatedPath set) — no-op early returns (item not
  // found, unparsable frontmatter) must not advance the sentinel or needlessly
  // clear caches (Cursor Medium).
  if (result.updatedPath !== undefined) bumpMemoryCorpusVersionForDir(memoryDir);
  return result;
}

// ── Actions ──────────────────────────────────────────────────────────────────

function approveItem(
  memoryDir: string,
  itemId: string,
  options: ReviewActionOptions,
): ReviewResult {
  const rootReal = realMemoryRoot(memoryDir);
  if (!rootReal) return { itemId, action: "approve", message: "Item not found" };
  const found = findReviewFileById(memoryDir, itemId, options);
  if (!found) {
    return { itemId, action: "approve", message: "Item not found" };
  }

  const content = fs.readFileSync(found.filePath, "utf8");
  const fm = parseFrontmatter(content);
  if (!fm) return { itemId, action: "approve", message: "Could not parse frontmatter" };

  // Issue #1579 — when approving a tombstone-blocked memory, fire the
  // revocation hook so the content is re-allowed (append-only log: a
  // `kind: "revocation"` entry supersedes the tombstone at lookup). Clear
  // blockedBy/tombstoneBlockTier on the promoted memory so it is fully
  // active. Fire-and-forget: a hook failure never fails the approval.
  const blockedBy = typeof fm.blockedBy === "string" ? fm.blockedBy : null;
  if (blockedBy && options.onApproveBlockedMemory) {
    try {
      const maybe = options.onApproveBlockedMemory(blockedBy, itemId);
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        void (maybe as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* fire-and-forget — never fail the approval (gotcha #13) */
    }
  }

  const updatedContent = updateFrontmatterFields(content, {
    confidence: "0.9",
    confidenceTier: "high",
    reviewDismissed: null,
    // Clear the tombstone-block markers so the promoted memory is active.
    // Clear the tombstone-block markers AND restore active status so the
    // promoted memory is fully active in recall + provenance (issue #1579
    // review: leaving status: pending_review kept it invisible to recall).
    ...(blockedBy ? { blockedBy: null, tombstoneBlockTier: null, status: "active" } : {}),
  });

  if (found.location === "category") {
    writeReviewFileCanonicalized(memoryDir, found.filePath, updatedContent);
    return {
      itemId,
      action: "approve",
      updatedPath: found.filePath,
      message: "Approved low-confidence memory in place with confidence 0.9",
      ...(blockedBy ? { clearedTombstoneId: blockedBy } : {}),
    };
  }

  // Promote queued suggestions/review items to their category directory.
  const category = (fm.category as string) ?? "fact";
  const targetDir = getCategoryDir(memoryDir, category);
  const dateDir = new Date().toISOString().split("T")[0];
  ensureSafeDirectory(rootReal, targetDir);
  const outputPath = path.join(targetDir, dateDir, path.basename(found.filePath));

  ensureSafeDirectory(rootReal, path.dirname(outputPath));
  // The suggestions/review queue dirs sit OUTSIDE the migration's reference
  // scan, so a queued pre-migration item can still carry a legacy entityRef
  // (issue #2213): promote it canonicalized against the target journal, and
  // REPAIR when the journal moved across the write.
  const reviewStateDir = path.join(memoryDir, "state");
  const idsAtWrite = historicalIdCache.get(reviewStateDir);
  const promotedWritten = canonicalizeEntityRefFrontmatter(updatedContent, idsAtWrite);
  const promotedPath = writeFileWithoutClobber(outputPath, promotedWritten, itemId);
  try {
    repairContentAfterJournalMoveSync({
      stateDir: reviewStateDir,
      cache: historicalIdCache,
      idsAtWrite,
      rawContent: updatedContent,
      lastWritten: promotedWritten,
      rewrite: (next) => fs.writeFileSync(promotedPath, next, "utf8"),
    });
  } catch (err) {
    // Roll back so a retried approve does not clobber-fail against a partial
    // promotion; the queue entry survives untouched (Bugbot).
    try {
      fs.unlinkSync(promotedPath);
    } catch {
      // Best effort — the retryable repair error below is the primary signal.
    }
    throw err;
  }

  // Remove from review
  fs.unlinkSync(found.filePath);

  return {
    itemId,
    action: "approve",
    updatedPath: promotedPath,
    message: `Promoted to ${category} with confidence 0.9`,
    ...(blockedBy ? { clearedTombstoneId: blockedBy } : {}),
  };
}

function dismissItem(
  memoryDir: string,
  itemId: string,
  options: ReviewActionOptions,
): ReviewResult {
  const found = findReviewFileById(memoryDir, itemId, options);
  if (!found) {
    return { itemId, action: "dismiss", message: "Item not found" };
  }

  if (found.location === "queue") {
    fs.unlinkSync(found.filePath);
    return { itemId, action: "dismiss", message: "Dismissed and removed" };
  }

  const content = fs.readFileSync(found.filePath, "utf8");
  writeReviewFileCanonicalized(
    memoryDir,
    found.filePath,
    updateFrontmatterFields(content, {
      reviewDismissed: "true",
      reviewDismissedAt: new Date().toISOString(),
    }),
  );
  return {
    itemId,
    action: "dismiss",
    updatedPath: found.filePath,
    message: "Dismissed low-confidence memory in place",
  };
}

function flagItem(
  memoryDir: string,
  itemId: string,
  options: ReviewActionOptions,
): ReviewResult {
  const found = findReviewFileById(memoryDir, itemId, options);
  if (!found) {
    return { itemId, action: "flag", message: "Item not found" };
  }

  const content = fs.readFileSync(found.filePath, "utf8");
  const fixed = updateFrontmatterFields(content, {
    flagged: "true",
    flaggedAt: new Date().toISOString(),
  });
  writeReviewFileCanonicalized(memoryDir, found.filePath, fixed);
  return {
    itemId,
    action: "flag",
    updatedPath: found.filePath,
    message: "Flagged for further review",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findReviewFileById(
  memoryDir: string,
  id: string,
  options: ReviewActionOptions = {},
): ReviewFileMatch | null {
  const rootReal = realMemoryRoot(memoryDir);
  if (!rootReal) return null;
  for (const loc of ["suggestions", "review"]) {
    const dir = path.join(memoryDir, loc);
    if (!fs.existsSync(dir) || !isSafeDirectory(rootReal, dir)) continue;

    const found = findFileById(rootReal, dir, id);
    if (found) return { filePath: found, location: "queue" };
  }

  for (const category of ALL_CATEGORY_DIRS) {
    const dir = path.join(memoryDir, category);
    if (!fs.existsSync(dir) || !isSafeDirectory(rootReal, dir)) continue;

    const found = findFileById(rootReal, dir, id, (fm) => isLowConfidenceReviewCandidate(fm, options));
    if (found) return { filePath: found, location: "category" };
  }

  return null;
}

function findFileById(
  rootReal: string,
  dir: string,
  id: string,
  include?: (frontmatter: Record<string, unknown>) => boolean,
): string | null {
  const files = walkMdPaths(rootReal, dir);
  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const fm = parseFrontmatter(content);
    if (fm?.id === id && (!include || include(fm))) return filePath;
  }
  return null;
}

function isLowConfidenceReviewCandidate(
  fm: Record<string, unknown>,
  options: ReviewActionOptions,
): boolean {
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  // Issue #1579: tombstone-blocked facts are ALWAYS review candidates,
  // regardless of confidence. The block sets status: pending_review +
  // blockedBy; these must be visible in the review queue so an operator
  // can approve (revoke the tombstone) or dismiss them. Without this, a
  // high-confidence blocked fact is visible on disk but absent from the
  // review UI — a silent drop, which violates the non-resurrection design
  // (rule 34: visible, not silent).
  if (typeof fm.blockedBy === "string" && fm.blockedBy.length > 0) {
    return !parseBoolean(fm.reviewDismissed);
  }
  return (
    parseConfidence(fm.confidence, 1) < threshold &&
    !parseBoolean(fm.reviewDismissed)
  );
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseConfidence(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function updateFrontmatterFields(
  content: string,
  fields: Record<string, string | null>,
): string {
  const match = content.match(/^(---\n)([\s\S]*?)(\n---(?:\n|$))/);
  if (!match) return content;

  const seen = new Set<string>();
  const lines = match[2].split("\n");
  const nextLines: string[] = [];
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      nextLines.push(line);
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      nextLines.push(line);
      continue;
    }
    seen.add(key);
    const value = fields[key];
    if (value !== null) {
      nextLines.push(`${key}: ${value}`);
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && !seen.has(key)) {
      nextLines.push(`${key}: ${value}`);
    }
  }

  return `${match[1]}${nextLines.join("\n")}${match[3]}${content.slice(match[0].length)}`;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeFileWithoutClobber(basePath: string, content: string, discriminator: string): string {
  const parsed = path.parse(basePath);
  const safeDiscriminator = sanitizeFilePart(discriminator);

  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = attempt === 0
      ? basePath
      : path.join(
        parsed.dir,
        `${parsed.name}-${safeDiscriminator}${attempt === 1 ? "" : `-${attempt}`}${parsed.ext || ".md"}`,
      );

    try {
      fs.writeFileSync(candidate, content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }

  throw new Error(`Could not find a free review promotion path for ${basePath}`);
}

function sanitizeFilePart(value: string): string {
  const chars: string[] = [];
  let previousWasDash = false;

  for (const char of value) {
    const next = isSafeFilePartChar(char) ? char : "-";
    if (next === "-" && previousWasDash) continue;
    chars.push(next);
    previousWasDash = next === "-";
    if (chars.length >= 64) break;
  }

  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === "-") start++;
  while (end > start && chars[end - 1] === "-") end--;

  const sanitized = chars.slice(start, end).join("");
  return sanitized || "review-item";
}

function isSafeFilePartChar(value: string): boolean {
  if (value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "." ||
    value === "_" ||
    value === "-"
  );
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

function walkMd(rootReal: string, dir: string, callback: (filePath: string, content: string) => boolean | void): boolean {
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

function walkMdPaths(rootReal: string, dir: string): string[] {
  const results: string[] = [];
  if (!isSafeDirectory(rootReal, dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...walkMdPaths(rootReal, fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}
