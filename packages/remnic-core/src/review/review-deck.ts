import { createHash } from "node:crypto";
import { parseFrontmatterFields } from "./frontmatter.js";

export type ReviewDeckChoice = "keep" | "prepare_fix" | "not_true";
export type ReviewDeckRisk = "reversible";

export interface ReviewDeckEvidence {
  sourceMemoryId?: string;
  sourceDate?: string;
  excerpt?: string;
  relation: "supports" | "conflicts" | "origin";
}

export interface ReviewDeckItem {
  schemaVersion: 1;
  itemId: string;
  source: "review";
  sourceId: string;
  memoryId?: string;
  content: string;
  category?: string;
  lifecycleState?: string;
  confidence?: number;
  confidenceTier?: string;
  reviewReason: string;
  reviewReasonLabel: string;
  supportCount: number;
  provenance: readonly ReviewDeckEvidence[];
  allowedChoices: readonly ReviewDeckChoice[];
  choiceRisk: Readonly<Record<ReviewDeckChoice, ReviewDeckRisk | "unavailable">>;
  namespace: string;
  revision: string;
}

export interface ReviewDeckPage {
  schemaVersion: 1;
  items: readonly ReviewDeckItem[];
  nextCursor?: string;
  total: number;
}

export type ReviewDeckActionRequest =
  | { schemaVersion: 1; itemId: string; revision: string; action: "keep" | "not_true"; idempotencyKey: string }
  | { schemaVersion: 1; itemId: string; revision: string; action: "prepare_fix"; correctionText: string; idempotencyKey: string };

export interface ReviewDeckActionReceipt {
  schemaVersion: 1;
  receiptId: string;
  itemId: string;
  action: "keep" | "not_true" | "prepare_fix" | "undo";
  outcome: "planned" | "applied" | "conflict" | "failed";
  effect: string;
  undoAvailable: boolean;
  appliedRevision?: string;
  correctionPlanId?: string;
  correctionPreview?: unknown;
}

export interface ReviewDeckUndoRequest {
  schemaVersion: 1;
  receiptId: string;
  expectedRevision: string;
  idempotencyKey: string;
}

export interface ReviewDeckSourceRow {
  itemId: string;
  filePath: string;
  fileContent: string;
  revision: string;
  content: string;
  category?: string;
  confidence?: number;
  confidenceTier?: string;
  reviewReason: string;
  created: string;
  source?: string;
  blockedBy?: string;
  lifecycleState?: string;
  context?: string;
}

export interface ReviewDeckSnapshot {
  corpusVersion: string;
  total: number;
  rows: readonly ReviewDeckSourceRow[];
}

export interface ReviewDeckCursorScope {
  principalDigest: string;
  namespace: string;
  filterDigest: string;
  corpusVersion: string;
}

export class ReviewDeckCursorError extends Error {
  constructor(message = "Invalid review deck cursor") {
    super(message);
    this.name = "ReviewDeckCursorError";
  }
}

const ALLOWED_CHOICES = ["keep", "prepare_fix", "not_true"] as const satisfies readonly ReviewDeckChoice[];
const REVERSIBLE_RISK = {
  keep: "reversible",
  prepare_fix: "reversible",
  not_true: "reversible",
} as const satisfies Record<ReviewDeckChoice, ReviewDeckRisk>;

const REVIEW_REASON_LABELS: Record<string, string> = {
  low_confidence: "Low confidence",
  suggestion: "Suggested memory",
  tombstone_blocked: "Blocked by a deletion",
  contradiction: "Conflicts with another memory",
  duplicate: "Possible duplicate",
};

const EXCERPT_LIMIT = 240;

export function computeReviewItemRevision(fileContent: string): string {
  return `rv1:${createHash("sha256").update(fileContent).digest("hex")}`;
}

export function projectReviewDeckItem(row: ReviewDeckSourceRow, namespace: string): ReviewDeckItem {
  const provenance = provenanceFromRow(row);
  return {
    schemaVersion: 1,
    itemId: row.itemId,
    source: "review",
    sourceId: row.itemId,
    memoryId: row.itemId,
    content: row.content,
    ...(row.category !== undefined ? { category: row.category } : {}),
    ...(row.lifecycleState !== undefined ? { lifecycleState: row.lifecycleState } : {}),
    ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
    ...(row.confidenceTier !== undefined ? { confidenceTier: row.confidenceTier } : {}),
    reviewReason: row.reviewReason,
    reviewReasonLabel: reviewReasonLabel(row.reviewReason),
    supportCount: provenance.filter((entry) => entry.relation === "supports").length,
    provenance,
    allowedChoices: ALLOWED_CHOICES,
    choiceRisk: REVERSIBLE_RISK,
    namespace,
    revision: row.revision,
  };
}

export function compareReviewDeckRows(a: ReviewDeckSourceRow, b: ReviewDeckSourceRow): number {
  const aBlocked = a.blockedBy && a.blockedBy.length > 0 ? 0 : 1;
  const bBlocked = b.blockedBy && b.blockedBy.length > 0 ? 0 : 1;
  if (aBlocked !== bBlocked) return aBlocked - bBlocked;
  const aConfidence = a.confidence ?? 0.5;
  const bConfidence = b.confidence ?? 0.5;
  if (aConfidence !== bConfidence) return aConfidence < bConfidence ? -1 : 1;
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  return 0;
}

export function encodeReviewDeckCursor(scope: ReviewDeckCursorScope, lastSortKey: string): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      p: scope.principalDigest,
      n: scope.namespace,
      f: scope.filterDigest,
      c: scope.corpusVersion,
      k: lastSortKey,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeReviewDeckCursor(cursor: string, scope: ReviewDeckCursorScope): string {
  const payload = parseCursorPayload(cursor);
  if (
    payload.p !== scope.principalDigest
    || payload.n !== scope.namespace
    || payload.f !== scope.filterDigest
    || payload.c !== scope.corpusVersion
  ) {
    throw new ReviewDeckCursorError("Review deck cursor scope mismatch");
  }
  return payload.k;
}

export function buildReviewDeckPage(
  rows: readonly ReviewDeckSourceRow[],
  opts: { scope: ReviewDeckCursorScope; cursor?: string; limit: number },
): ReviewDeckPage {
  const sorted = [...rows].sort(compareReviewDeckRows);
  const limit = Math.max(0, opts.limit);
  let start = 0;
  if (opts.cursor !== undefined) {
    const lastSortKey = decodeReviewDeckCursor(opts.cursor, opts.scope);
    start = sorted.findIndex((row) => reviewDeckSortKey(row) > lastSortKey);
    if (start < 0) start = sorted.length;
  }
  const pageRows = limit === 0 ? [] : sorted.slice(start, start + limit);
  const items = pageRows.map((row) => projectReviewDeckItem(row, opts.scope.namespace));
  const consumed = start + pageRows.length;
  const nextCursor =
    pageRows.length > 0 && consumed < sorted.length
      ? encodeReviewDeckCursor(opts.scope, reviewDeckSortKey(pageRows[pageRows.length - 1]))
      : undefined;
  return {
    schemaVersion: 1,
    items,
    total: sorted.length,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function reviewDeckSortKey(row: ReviewDeckSourceRow): string {
  const blocked = row.blockedBy && row.blockedBy.length > 0 ? "0" : "1";
  return `${blocked}\t${(row.confidence ?? 0.5).toFixed(6)}\t${row.created}\t${row.itemId}`;
}

function reviewReasonLabel(reason: string): string {
  const known = REVIEW_REASON_LABELS[reason];
  if (known) return known;
  const words = reason.split("_").filter((part) => part.length > 0);
  if (words.length === 0) return "Review";
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function provenanceFromRow(row: ReviewDeckSourceRow): ReviewDeckEvidence[] {
  const fm = parseFrontmatterFields(row.fileContent);
  const source = nonempty(row.source) ?? nonempty(fm.source);
  const context = nonempty(row.context) ?? nonempty(fm.context);
  const created = nonempty(row.created) ?? nonempty(fm.created);
  const supportIds = idList(fm.supports);
  const conflictIds = [...idList(fm.conflicts), ...idList(fm.contradicts)];
  const relatedIds = idList(fm.relatedMemoryIds);
  const relatedRelation = row.reviewReason === "contradiction" ? "conflicts" : "supports";
  const provenance: ReviewDeckEvidence[] = [];
  if (source !== undefined || context !== undefined) {
    provenance.push({
      relation: "origin",
      ...(created !== undefined ? { sourceDate: created } : {}),
      excerpt: truncateExcerpt(context ?? source ?? ""),
    });
  }
  for (const sourceMemoryId of supportIds) {
    provenance.push({ relation: "supports", sourceMemoryId });
  }
  for (const sourceMemoryId of conflictIds) {
    provenance.push({ relation: "conflicts", sourceMemoryId });
  }
  for (const sourceMemoryId of relatedIds) {
    if (supportIds.includes(sourceMemoryId) || conflictIds.includes(sourceMemoryId)) continue;
    provenance.push({ relation: relatedRelation, sourceMemoryId });
  }
  return provenance;
}


function idList(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => part.length > 0);
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function truncateExcerpt(value: string): string {
  return value.length <= EXCERPT_LIMIT ? value : value.slice(0, EXCERPT_LIMIT);
}

function parseCursorPayload(cursor: string): { v: 1; p: string; n: string; f: string; c: string; k: string } {
  if (cursor.length === 0) throw new ReviewDeckCursorError("Malformed review deck cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ReviewDeckCursorError("Malformed review deck cursor");
  }
  if (!parsed || typeof parsed !== "object") throw new ReviewDeckCursorError("Malformed review deck cursor");
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw new ReviewDeckCursorError("Unsupported review deck cursor schema");
  if (
    typeof record.p !== "string"
    || typeof record.n !== "string"
    || typeof record.f !== "string"
    || typeof record.c !== "string"
    || typeof record.k !== "string"
    || record.k.length === 0
  ) {
    throw new ReviewDeckCursorError("Malformed review deck cursor");
  }
  return { v: 1, p: record.p, n: record.n, f: record.f, c: record.c, k: record.k };
}
