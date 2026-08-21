/**
 * Review-deck mutations. Keep/not-true go through performReview.
 * Receipts live on the existing memory lifecycle ledger.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { throwIfAborted } from "../abort-error.js";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import { toMemoryPathRel } from "../memory-lifecycle-ledger-utils.js";
import { createVersion, getVersion, revertToVersion, type VersioningConfig } from "../page-versioning.js";
import type { MemoryLifecycleEvent } from "../types.js";
import { performReview } from "./index.js";
import {
  computeReviewItemRevision,
  type ReviewDeckActionReceipt,
  type ReviewDeckActionRequest,
  type ReviewDeckUndoRequest,
} from "./review-deck.js";
import { readReviewDeckRow } from "./review-deck-snapshot.js";

const ACTOR = "admin-console.review-deck";
const RULE_VERSION = "admin-console.review-deck.v1";
const DECK_VERSIONING: VersioningConfig = {
  enabled: true,
  maxVersionsPerPage: 20,
  sidecarDir: ".versions",
};

const KEEP_EFFECT = "Kept: this memory can now be recalled.";
const NOT_TRUE_EFFECT = "Marked untrue: removed from the review queue.";
const PLANNED_EFFECT = "Prepared a correction plan.";
const PLAN_FAILED_EFFECT = "Could not prepare a correction plan.";
const MISSING_EFFECT = "This review item is no longer available.";
const CONFLICT_EFFECT = "This memory changed. Review it again.";
const UNDO_EFFECT = "Undid the last review decision.";
const UNDO_CONFLICT_EFFECT = "Another change happened first. Nothing was undone.";
const UNDO_FAILED_EFFECT = "This action cannot be undone.";

export class ReviewDeckIdempotencyError extends Error {
  override readonly name = "ReviewDeckIdempotencyError";
  constructor(message = "Idempotency key was reused with a different review request.") {
    super(message);
  }
}

export class ReviewDeckInputError extends Error {
  override readonly name = "ReviewDeckInputError";
  constructor(message: string) {
    super(message);
  }
}

export interface ReviewLifecycleReceipt {
  schemaVersion: 1;
  receiptId: string;
  requestFingerprint: string;
  principalDigest: string;
  itemId: string;
  action: "approve" | "dismiss" | "undo";
  beforeRevision: string;
  afterRevision: string;
  revisionArtifact?: string;
  sourcePath: string;
  undoOfReceiptId?: string;
}

export type ReviewLifecycleLedgerEvent = MemoryLifecycleEvent & {
  reviewReceipt?: ReviewLifecycleReceipt;
};

export interface ReviewDeckMutationContext {
  memoryDir: string;
  namespace: string;
  principalDigest: string;
  appendLifecycleEvents(events: unknown[]): Promise<void>;
  readLifecycleEvents(memoryId?: string): Promise<unknown[]>;
  onApproveBlockedMemory?: (tombstoneId: string, memoryId: string) => void | Promise<void>;
  planCorrection?: (input: {
    itemId: string;
    correctionText: string;
  }) => Promise<{ planId?: string; preview?: unknown; message?: string }>;
  signal?: AbortSignal;
}

type DeckActionName = "keep" | "not_true" | "prepare_fix" | "undo";

type StoredDeckEvent = ReviewLifecycleLedgerEvent & {
  reviewNamespace?: string;
  reviewCreatedPath?: string;
  reviewDeckReceipt?: ReviewDeckActionReceipt;
};

const LEDGER_ACTION: Record<"keep" | "not_true" | "undo", ReviewLifecycleReceipt["action"]> = {
  keep: "approve",
  not_true: "dismiss",
  undo: "undo",
};

const EVENT_TYPE: Record<"keep" | "not_true" | "undo", MemoryLifecycleEvent["eventType"]> = {
  keep: "promoted",
  not_true: "rejected",
  undo: "restored",
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function computeReceiptId(namespace: string, principalDigest: string, idempotencyKey: string): string {
  return `rcp1:${sha256Hex(`${namespace}\u0000${principalDigest}\u0000${idempotencyKey}`)}`;
}

function computeRequestFingerprint(parts: readonly string[]): string {
  return `rfp1:${sha256Hex(parts.join("\u0000"))}`;
}

function actionFingerprint(
  ctx: ReviewDeckMutationContext,
  itemId: string,
  action: DeckActionName,
  expectedRevision: string,
  correctionText?: string,
): string {
  const parts = [ctx.principalDigest, ctx.namespace, itemId, action, expectedRevision];
  if (correctionText !== undefined) parts.push(correctionText);
  return computeRequestFingerprint(parts);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isReceiptAction(value: unknown): value is ReviewLifecycleReceipt["action"] {
  return value === "approve" || value === "dismiss" || value === "undo";
}

export function parseReviewLifecycleReceipt(value: unknown): ReviewLifecycleReceipt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec.schemaVersion !== 1) return null;
  if (!isNonEmptyString(rec.receiptId)) return null;
  if (!isNonEmptyString(rec.requestFingerprint)) return null;
  if (!isNonEmptyString(rec.principalDigest)) return null;
  if (!isNonEmptyString(rec.itemId)) return null;
  if (!isReceiptAction(rec.action)) return null;
  if (typeof rec.beforeRevision !== "string") return null;
  if (typeof rec.afterRevision !== "string") return null;
  if (!isNonEmptyString(rec.sourcePath) || path.isAbsolute(rec.sourcePath)) return null;
  if (rec.revisionArtifact !== undefined && typeof rec.revisionArtifact !== "string") return null;
  if (rec.undoOfReceiptId !== undefined && typeof rec.undoOfReceiptId !== "string") return null;
  const parsed: ReviewLifecycleReceipt = {
    schemaVersion: 1,
    receiptId: rec.receiptId,
    requestFingerprint: rec.requestFingerprint,
    principalDigest: rec.principalDigest,
    itemId: rec.itemId,
    action: rec.action,
    beforeRevision: rec.beforeRevision,
    afterRevision: rec.afterRevision,
    sourcePath: rec.sourcePath,
  };
  if (typeof rec.revisionArtifact === "string") parsed.revisionArtifact = rec.revisionArtifact;
  if (typeof rec.undoOfReceiptId === "string") parsed.undoOfReceiptId = rec.undoOfReceiptId;
  return parsed;
}

function asStoredEvent(value: unknown): StoredDeckEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as StoredDeckEvent;
}

function findStoredReceipt(
  events: readonly unknown[],
  receiptId: string,
): { event: StoredDeckEvent; receipt: ReviewLifecycleReceipt } | null {
  for (const raw of events) {
    const event = asStoredEvent(raw);
    if (!event) continue;
    const receipt = parseReviewLifecycleReceipt(event.reviewReceipt);
    if (receipt && receipt.receiptId === receiptId) return { event, receipt };
  }
  return null;
}


function resolveInside(memoryDir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const root = path.resolve(memoryDir);
  const abs = path.resolve(root, rel.split("/").join(path.sep));
  const next = path.relative(root, abs);
  if (next.startsWith("..") || path.isAbsolute(next)) return null;
  return abs;
}

function currentRevision(absPath: string): string {
  try {
    return computeReviewItemRevision(fs.readFileSync(absPath, "utf8"));
  } catch {
    return "";
  }
}

function publicReceipt(input: {
  receiptId: string;
  itemId: string;
  action: DeckActionName;
  outcome: ReviewDeckActionReceipt["outcome"];
  effect: string;
  undoAvailable: boolean;
  appliedRevision?: string;
  correctionPlanId?: string;
  correctionPreview?: unknown;
}): ReviewDeckActionReceipt {
  return {
    schemaVersion: 1,
    receiptId: input.receiptId,
    itemId: input.itemId,
    action: input.action,
    outcome: input.outcome,
    effect: input.effect,
    undoAvailable: input.undoAvailable,
    ...(input.appliedRevision !== undefined ? { appliedRevision: input.appliedRevision } : {}),
    ...(input.correctionPlanId !== undefined ? { correctionPlanId: input.correctionPlanId } : {}),
    ...(input.correctionPreview !== undefined ? { correctionPreview: input.correctionPreview } : {}),
  };
}

async function snapshotForUndo(
  filePath: string,
  memoryDir: string,
): Promise<string | undefined> {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const version = await createVersion(
      filePath,
      content,
      "manual",
      DECK_VERSIONING,
      undefined,
      undefined,
      memoryDir,
    );
    return version.versionId;
  } catch {
    return undefined;
  }
}

async function artifactReadable(
  filePath: string,
  versionId: string,
  memoryDir: string,
): Promise<boolean> {
  try {
    await getVersion(filePath, versionId, DECK_VERSIONING, memoryDir);
    return true;
  } catch {
    return false;
  }
}

function undoTargetRevision(receipt: ReviewLifecycleReceipt, createdRel: string | undefined): string {
  const created = createdRel && createdRel !== receipt.sourcePath ? createdRel : undefined;
  if (receipt.action === "approve" && created) return created;
  return receipt.sourcePath;
}

async function honestUndoAvailable(
  ctx: ReviewDeckMutationContext,
  receipt: ReviewLifecycleReceipt,
  createdRel: string | undefined,
): Promise<boolean> {
  if (!receipt.revisionArtifact || receipt.action === "undo") return false;
  const sourceAbs = resolveInside(ctx.memoryDir, receipt.sourcePath);
  if (!sourceAbs) return false;
  if (!(await artifactReadable(sourceAbs, receipt.revisionArtifact, ctx.memoryDir))) return false;
  const targetRel = undoTargetRevision(receipt, createdRel);
  const targetAbs = resolveInside(ctx.memoryDir, targetRel);
  if (!targetAbs) return false;
  return currentRevision(targetAbs) === receipt.afterRevision;
}

async function replayReceipt(
  ctx: ReviewDeckMutationContext,
  hit: { event: StoredDeckEvent; receipt: ReviewLifecycleReceipt },
  action: DeckActionName,
): Promise<ReviewDeckActionReceipt> {
  const stored = hit.event.reviewDeckReceipt;
  const undoAvailable = await honestUndoAvailable(ctx, hit.receipt, hit.event.reviewCreatedPath);
  if (stored && stored.schemaVersion === 1 && stored.receiptId === hit.receipt.receiptId) {
    return {
      ...stored,
      undoAvailable,
      appliedRevision: stored.appliedRevision ?? hit.receipt.afterRevision,
    };
  }
  return publicReceipt({
    receiptId: hit.receipt.receiptId,
    itemId: hit.receipt.itemId,
    action,
    outcome: "applied",
    effect: action === "keep" ? KEEP_EFFECT : action === "not_true" ? NOT_TRUE_EFFECT : UNDO_EFFECT,
    undoAvailable,
    appliedRevision: hit.receipt.afterRevision,
  });
}

function applyKeepOrNotTrueSync(input: {
  memoryDir: string;
  itemId: string;
  filePath: string;
  expectedRevision: string;
  action: "keep" | "not_true";
  onApproveBlockedMemory?: ReviewDeckMutationContext["onApproveBlockedMemory"];
}):
  | { kind: "conflict"; current: string }
  | { kind: "failed" }
  | { kind: "applied"; afterRevision: string; createdAbs?: string } {
  let current: string;
  try {
    current = fs.readFileSync(input.filePath, "utf8");
  } catch {
    return { kind: "failed" };
  }
  const currentRev = computeReviewItemRevision(current);
  if (currentRev !== input.expectedRevision) {
    return { kind: "conflict", current: currentRev };
  }
  const result = performReview(
    input.memoryDir,
    input.itemId,
    input.action === "keep" ? "approve" : "dismiss",
    { onApproveBlockedMemory: input.onApproveBlockedMemory },
  );
  if (result.message === "Item not found" || result.message === "Could not parse frontmatter") {
    return { kind: "failed" };
  }
  if (result.updatedPath && fs.existsSync(result.updatedPath)) {
    return {
      kind: "applied",
      afterRevision: computeReviewItemRevision(fs.readFileSync(result.updatedPath, "utf8")),
      createdAbs: result.updatedPath,
    };
  }
  return { kind: "applied", afterRevision: "" };
}

async function appendAppliedEvent(
  ctx: ReviewDeckMutationContext,
  input: {
    itemId: string;
    action: "keep" | "not_true" | "undo";
    receipt: ReviewLifecycleReceipt;
    createdRel?: string;
    publicReceipt: ReviewDeckActionReceipt;
    undoOfReceiptId?: string;
  },
): Promise<void> {
  const event: StoredDeckEvent = {
    eventId: `mle-${randomUUID()}`,
    memoryId: input.itemId,
    eventType: EVENT_TYPE[input.action],
    timestamp: new Date().toISOString(),
    actor: ACTOR,
    ruleVersion: RULE_VERSION,
    reviewReceipt: input.receipt,
    reviewNamespace: ctx.namespace,
    reviewDeckReceipt: input.publicReceipt,
    before: { path: input.receipt.sourcePath },
    ...(input.createdRel ? { after: { path: input.createdRel }, reviewCreatedPath: input.createdRel } : {}),
    ...(input.undoOfReceiptId ? { relatedMemoryIds: [input.itemId] } : {}),
  };
  await ctx.appendLifecycleEvents([event]);
}

export async function executeReviewDeckAction(
  ctx: ReviewDeckMutationContext,
  req: ReviewDeckActionRequest,
): Promise<ReviewDeckActionReceipt> {
  throwIfAborted(ctx.signal);
  if (req.schemaVersion !== 1) throw new ReviewDeckInputError("schemaVersion must be 1");
  if (!isNonEmptyString(req.itemId)) throw new ReviewDeckInputError("itemId is required");
  if (!isNonEmptyString(req.revision)) throw new ReviewDeckInputError("revision is required");
  if (!isNonEmptyString(req.idempotencyKey)) throw new ReviewDeckInputError("idempotencyKey is required");

  const receiptId = computeReceiptId(ctx.namespace, ctx.principalDigest, req.idempotencyKey);

  if (req.action === "prepare_fix") {
    const correctionText = req.correctionText;
    if (typeof correctionText !== "string" || correctionText.trim() === "") {
      throw new ReviewDeckInputError("correctionText is required");
    }
    if (!ctx.planCorrection) {
      return publicReceipt({
        receiptId,
        itemId: req.itemId,
        action: "prepare_fix",
        outcome: "failed",
        effect: PLAN_FAILED_EFFECT,
        undoAvailable: false,
      });
    }
    const planned = await ctx.planCorrection({ itemId: req.itemId, correctionText });
    if (!planned.planId) {
      return publicReceipt({
        receiptId,
        itemId: req.itemId,
        action: "prepare_fix",
        outcome: "failed",
        effect: planned.message?.trim() || PLAN_FAILED_EFFECT,
        undoAvailable: false,
      });
    }
    return publicReceipt({
      receiptId,
      itemId: req.itemId,
      action: "prepare_fix",
      outcome: "planned",
      effect: PLANNED_EFFECT,
      undoAvailable: false,
      correctionPlanId: planned.planId,
      correctionPreview: planned.preview,
    });
  }

  if (req.action !== "keep" && req.action !== "not_true") {
    throw new ReviewDeckInputError("unsupported review deck action");
  }

  const fingerprint = actionFingerprint(ctx, req.itemId, req.action, req.revision);
  const existing = findStoredReceipt(await ctx.readLifecycleEvents(), receiptId);
  if (existing) {
    if (existing.receipt.requestFingerprint !== fingerprint) throw new ReviewDeckIdempotencyError();
    return replayReceipt(ctx, existing, req.action);
  }

  const row = readReviewDeckRow({ memoryDir: ctx.memoryDir, itemId: req.itemId });
  if (!row) {
    return publicReceipt({
      receiptId,
      itemId: req.itemId,
      action: req.action,
      outcome: "failed",
      effect: MISSING_EFFECT,
      undoAvailable: false,
    });
  }

  throwIfAborted(ctx.signal);
  const revisionArtifact = await snapshotForUndo(row.filePath, ctx.memoryDir);
  throwIfAborted(ctx.signal);

  const applied = applyKeepOrNotTrueSync({
    memoryDir: ctx.memoryDir,
    itemId: req.itemId,
    filePath: row.filePath,
    expectedRevision: req.revision,
    action: req.action,
    onApproveBlockedMemory: ctx.onApproveBlockedMemory,
  });

  if (applied.kind === "conflict") {
    return publicReceipt({
      receiptId,
      itemId: req.itemId,
      action: req.action,
      outcome: "conflict",
      effect: CONFLICT_EFFECT,
      undoAvailable: false,
      appliedRevision: applied.current,
    });
  }
  if (applied.kind === "failed") {
    return publicReceipt({
      receiptId,
      itemId: req.itemId,
      action: req.action,
      outcome: "failed",
      effect: MISSING_EFFECT,
      undoAvailable: false,
    });
  }

  const sourcePath = toMemoryPathRel(ctx.memoryDir, row.filePath);
  const createdRel = applied.createdAbs ? toMemoryPathRel(ctx.memoryDir, applied.createdAbs) : undefined;
  const ledgerReceipt: ReviewLifecycleReceipt = {
    schemaVersion: 1,
    receiptId,
    requestFingerprint: fingerprint,
    principalDigest: ctx.principalDigest,
    itemId: req.itemId,
    action: LEDGER_ACTION[req.action],
    beforeRevision: req.revision,
    afterRevision: applied.afterRevision,
    sourcePath,
    ...(revisionArtifact ? { revisionArtifact } : {}),
  };
  const undoAvailable = Boolean(revisionArtifact);
  const published = publicReceipt({
    receiptId,
    itemId: req.itemId,
    action: req.action,
    outcome: "applied",
    effect: req.action === "keep" ? KEEP_EFFECT : NOT_TRUE_EFFECT,
    undoAvailable,
    appliedRevision: applied.afterRevision,
  });
  await appendAppliedEvent(ctx, {
    itemId: req.itemId,
    action: req.action,
    receipt: ledgerReceipt,
    createdRel,
    publicReceipt: published,
  });
  return published;
}

export async function executeReviewDeckUndo(
  ctx: ReviewDeckMutationContext,
  req: ReviewDeckUndoRequest,
): Promise<ReviewDeckActionReceipt> {
  throwIfAborted(ctx.signal);
  if (req.schemaVersion !== 1) throw new ReviewDeckInputError("schemaVersion must be 1");
  if (!isNonEmptyString(req.receiptId)) throw new ReviewDeckInputError("receiptId is required");
  if (typeof req.expectedRevision !== "string") throw new ReviewDeckInputError("expectedRevision is required");
  if (!isNonEmptyString(req.idempotencyKey)) throw new ReviewDeckInputError("idempotencyKey is required");

  const undoReceiptId = computeReceiptId(ctx.namespace, ctx.principalDigest, req.idempotencyKey);
  const events = await ctx.readLifecycleEvents();
  const original = findStoredReceipt(events, req.receiptId);
  if (!original) {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: "",
      action: "undo",
      outcome: "failed",
      effect: UNDO_FAILED_EFFECT,
      undoAvailable: false,
    });
  }

  const scopeOk =
    original.receipt.principalDigest === ctx.principalDigest &&
    original.event.reviewNamespace === ctx.namespace;
  if (!scopeOk) {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: "",
      action: "undo",
      outcome: "failed",
      effect: UNDO_FAILED_EFFECT,
      undoAvailable: false,
    });
  }

  const fingerprint = actionFingerprint(
    ctx,
    original.receipt.itemId,
    "undo",
    req.expectedRevision,
  );
  const priorUndo = findStoredReceipt(events, undoReceiptId);
  if (priorUndo) {
    if (priorUndo.receipt.requestFingerprint !== fingerprint) throw new ReviewDeckIdempotencyError();
    return replayReceipt(ctx, priorUndo, "undo");
  }

  if (req.expectedRevision !== original.receipt.afterRevision) {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: original.receipt.itemId,
      action: "undo",
      outcome: "conflict",
      effect: UNDO_CONFLICT_EFFECT,
      undoAvailable: false,
    });
  }

  const createdRel = original.event.reviewCreatedPath;
  const targetRel = undoTargetRevision(original.receipt, createdRel);
  const targetAbs = resolveInside(ctx.memoryDir, targetRel);
  const sourceAbs = resolveInside(ctx.memoryDir, original.receipt.sourcePath);
  if (!targetAbs || !sourceAbs) {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: original.receipt.itemId,
      action: "undo",
      outcome: "failed",
      effect: UNDO_FAILED_EFFECT,
      undoAvailable: false,
    });
  }

  if (currentRevision(targetAbs) !== original.receipt.afterRevision) {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: original.receipt.itemId,
      action: "undo",
      outcome: "conflict",
      effect: UNDO_CONFLICT_EFFECT,
      undoAvailable: false,
      appliedRevision: currentRevision(targetAbs),
    });
  }

  if (!original.receipt.revisionArtifact) {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: original.receipt.itemId,
      action: "undo",
      outcome: "failed",
      effect: UNDO_FAILED_EFFECT,
      undoAvailable: false,
    });
  }

  throwIfAborted(ctx.signal);
  try {
    await revertToVersion(
      sourceAbs,
      original.receipt.revisionArtifact,
      DECK_VERSIONING,
      undefined,
      ctx.memoryDir,
    );
  } catch {
    return publicReceipt({
      receiptId: undoReceiptId,
      itemId: original.receipt.itemId,
      action: "undo",
      outcome: "failed",
      effect: UNDO_FAILED_EFFECT,
      undoAvailable: false,
    });
  }

  if (createdRel && createdRel !== original.receipt.sourcePath) {
    const createdAbs = resolveInside(ctx.memoryDir, createdRel);
    if (createdAbs && createdAbs !== sourceAbs && fs.existsSync(createdAbs)) {
      fs.unlinkSync(createdAbs);
    }
  }
  bumpMemoryCorpusVersionForDir(ctx.memoryDir);

  const afterRevision = currentRevision(sourceAbs);
  const ledgerReceipt: ReviewLifecycleReceipt = {
    schemaVersion: 1,
    receiptId: undoReceiptId,
    requestFingerprint: fingerprint,
    principalDigest: ctx.principalDigest,
    itemId: original.receipt.itemId,
    action: "undo",
    beforeRevision: original.receipt.afterRevision,
    afterRevision,
    sourcePath: original.receipt.sourcePath,
    undoOfReceiptId: original.receipt.receiptId,
  };
  const published = publicReceipt({
    receiptId: undoReceiptId,
    itemId: original.receipt.itemId,
    action: "undo",
    outcome: "applied",
    effect: UNDO_EFFECT,
    undoAvailable: false,
    appliedRevision: afterRevision,
  });
  await appendAppliedEvent(ctx, {
    itemId: original.receipt.itemId,
    action: "undo",
    receipt: ledgerReceipt,
    publicReceipt: published,
    undoOfReceiptId: original.receipt.receiptId,
  });
  return published;
}
