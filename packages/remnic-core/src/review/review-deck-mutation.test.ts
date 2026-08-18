import assert from "node:assert/strict";

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { computeReviewItemRevision } from "./review-deck.js";
import { readReviewDeckRow } from "./review-deck-snapshot.js";
import {
  executeReviewDeckAction,
  executeReviewDeckUndo,
  parseReviewLifecycleReceipt,
  ReviewDeckIdempotencyError,
  type ReviewDeckMutationContext,
  type ReviewLifecycleLedgerEvent,
} from "./review-deck-mutation.js";

async function makeMemoryDir(t: TestContext): Promise<string> {
  const dir = await mkdtempSafe(t);
  await mkdir(path.join(dir, "review"), { recursive: true });
  return dir;
}

async function mkdtempSafe(t: TestContext): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-review-deck-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function reviewMarkdown(id: string, extra = ""): string {
  return `---
id: ${id}
category: fact
confidence: 0.4
confidenceTier: low
source: test
created: 2026-05-17T00:00:00.000Z
reviewReason: low_confidence
lifecycleState: pending_review
status: pending_review
${extra}---
Candidate memory.
`;
}

function makeCtx(
  memoryDir: string,
  events: unknown[],
  extras: Partial<ReviewDeckMutationContext> = {},
): ReviewDeckMutationContext {
  return {
    memoryDir,
    namespace: "ns-test",
    principalDigest: "prin-test",
    async appendLifecycleEvents(next) {
      events.push(...next);
    },
    async readLifecycleEvents(memoryId) {
      if (!memoryId) return events;
      return events.filter((row) => {
        if (!row || typeof row !== "object" || !("memoryId" in row)) return false;
        return row.memoryId === memoryId;
      });
    },
    ...extras,
  };
}

async function writeQueueItem(
  memoryDir: string,
  id: string,
  extra = "",
): Promise<{ filePath: string; content: string; revision: string }> {
  const filePath = path.join(memoryDir, "review", `${id}.md`);
  const content = reviewMarkdown(id, extra);
  await writeFile(filePath, content, "utf8");
  const row = readReviewDeckRow({ memoryDir, itemId: id });
  assert.ok(row, `expected pending review row ${id}`);
  return { filePath, content, revision: row.revision };
}

function ledgerEvent(value: unknown): ReviewLifecycleLedgerEvent {
  if (!value || typeof value !== "object") throw new Error("expected lifecycle event");
  // Test ledger rows are objects this suite appended.
  return value as ReviewLifecycleLedgerEvent;
}

function todayStamp(): string {
  return new Date().toISOString().split("T")[0];
}

test("keep promotes through performReview and fires tombstone revocation", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const hookCalls: Array<[string, string]> = [];
  const item = await writeQueueItem(memoryDir, "keep-blocked", "blockedBy: tomb-1\n");
  const ctx = makeCtx(memoryDir, events, {
    onApproveBlockedMemory(tombstoneId, memoryId) {
      hookCalls.push([tombstoneId, memoryId]);
    },
  });

  const receipt = await executeReviewDeckAction(ctx, {
    schemaVersion: 1,
    itemId: "keep-blocked",
    revision: item.revision,
    action: "keep",
    idempotencyKey: "keep-1",
  });

  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.action, "keep");
  assert.equal(receipt.undoAvailable, true);
  assert.match(receipt.effect, /recalled/);
  assert.deepEqual(hookCalls, [["tomb-1", "keep-blocked"]]);
  await assert.rejects(stat(item.filePath), /ENOENT/);
  const promoted = path.join(memoryDir, "facts", todayStamp(), "keep-blocked.md");
  const promotedText = await readFile(promoted, "utf8");
  assert.match(promotedText, /confidence: 0\.9/);
  const row = ledgerEvent(events[0]);
  assert.equal(row.eventType, "promoted");
  assert.equal(row.actor, "admin-console.review-deck");
  assert.equal(row.reviewReceipt?.action, "approve");
});

test("not true dismisses a queue item", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "dismiss-1");
  const receipt = await executeReviewDeckAction(makeCtx(memoryDir, events), {
    schemaVersion: 1,
    itemId: "dismiss-1",
    revision: item.revision,
    action: "not_true",
    idempotencyKey: "dismiss-1",
  });

  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.action, "not_true");
  assert.equal(receipt.undoAvailable, true);
  assert.equal(typeof receipt.appliedRevision, "string");
  await assert.rejects(stat(item.filePath), /ENOENT/);
  const row = ledgerEvent(events[0]);
  assert.equal(row.eventType, "rejected");
  assert.equal(row.reviewReceipt?.action, "dismiss");
  const undone = await executeReviewDeckUndo(makeCtx(memoryDir, events), {
    schemaVersion: 1,
    receiptId: receipt.receiptId,
    expectedRevision: receipt.appliedRevision ?? "",
    idempotencyKey: "dismiss-1-undo",
  });
  assert.equal(undone.outcome, "applied");
  assert.equal(await readFile(item.filePath, "utf8"), item.content);
});

test("stale revision returns conflict with no file change", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "stale-1");
  const receipt = await executeReviewDeckAction(makeCtx(memoryDir, events), {
    schemaVersion: 1,
    itemId: "stale-1",
    revision: "rv1:deadbeef",
    action: "keep",
    idempotencyKey: "stale-1",
  });

  assert.equal(receipt.outcome, "conflict");
  assert.equal(receipt.appliedRevision, item.revision);
  assert.equal(receipt.undoAvailable, false);
  assert.equal(await readFile(item.filePath, "utf8"), item.content);
  assert.equal(events.length, 0);
});

test("duplicate idempotency key returns the saved receipt and does not apply twice", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "idemp-1");
  const ctx = makeCtx(memoryDir, events);
  const req = {
    schemaVersion: 1 as const,
    itemId: "idemp-1",
    revision: item.revision,
    action: "keep" as const,
    idempotencyKey: "same-key",
  };
  const first = await executeReviewDeckAction(ctx, req);
  const second = await executeReviewDeckAction(ctx, req);

  assert.equal(first.outcome, "applied");
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.outcome, first.outcome);
  assert.equal(second.effect, first.effect);
  assert.equal(events.length, 1);
  const promoted = path.join(memoryDir, "facts", todayStamp(), "idemp-1.md");
  assert.equal(computeReviewItemRevision(await readFile(promoted, "utf8")), first.appliedRevision);
});

test("same key with a different fingerprint is rejected", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const firstItem = await writeQueueItem(memoryDir, "fp-a");
  await writeQueueItem(memoryDir, "fp-b");
  const ctx = makeCtx(memoryDir, events);
  await executeReviewDeckAction(ctx, {
    schemaVersion: 1,
    itemId: "fp-a",
    revision: firstItem.revision,
    action: "keep",
    idempotencyKey: "shared-key",
  });

  await assert.rejects(
    () =>
      executeReviewDeckAction(ctx, {
        schemaVersion: 1,
        itemId: "fp-b",
        revision: computeReviewItemRevision(fs.readFileSync(path.join(memoryDir, "review", "fp-b.md"), "utf8")),
        action: "keep",
        idempotencyKey: "shared-key",
      }),
    ReviewDeckIdempotencyError,
  );
  assert.ok(fs.existsSync(path.join(memoryDir, "review", "fp-b.md")));
});

test("prepare_fix returns a plan id and writes no lifecycle event and no file change", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "fix-1");
  const receipt = await executeReviewDeckAction(
    makeCtx(memoryDir, events, {
      async planCorrection(input) {
        return { planId: "plan-fix-1", preview: { itemId: input.itemId } };
      },
    }),
    {
      schemaVersion: 1,
      itemId: "fix-1",
      revision: item.revision,
      action: "prepare_fix",
      correctionText: "Replace the guessed preference.",
      idempotencyKey: "fix-1",
    },
  );

  assert.equal(receipt.outcome, "planned");
  assert.equal(receipt.correctionPlanId, "plan-fix-1");
  assert.deepEqual(receipt.correctionPreview, { itemId: "fix-1" });
  assert.equal(receipt.undoAvailable, false);
  assert.equal(events.length, 0);
  assert.equal(await readFile(item.filePath, "utf8"), item.content);
});

test("abort before the write leaves the file untouched", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "abort-1");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      executeReviewDeckAction(makeCtx(memoryDir, events, { signal: controller.signal }), {
        schemaVersion: 1,
        itemId: "abort-1",
        revision: item.revision,
        action: "keep",
        idempotencyKey: "abort-1",
      }),
    (err: Error) => err.name === "AbortError",
  );
  assert.equal(await readFile(item.filePath, "utf8"), item.content);
  assert.equal(events.length, 0);
});

test("undo succeeds with no intervening change", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "undo-ok");
  const ctx = makeCtx(memoryDir, events);
  const kept = await executeReviewDeckAction(ctx, {
    schemaVersion: 1,
    itemId: "undo-ok",
    revision: item.revision,
    action: "keep",
    idempotencyKey: "undo-ok",
  });
  const undone = await executeReviewDeckUndo(ctx, {
    schemaVersion: 1,
    receiptId: kept.receiptId,
    expectedRevision: kept.appliedRevision ?? "",
    idempotencyKey: "undo-ok-revert",
  });

  assert.equal(undone.outcome, "applied");
  assert.equal(undone.action, "undo");
  assert.equal(undone.undoAvailable, false);
  assert.equal(await readFile(item.filePath, "utf8"), item.content);
  await assert.rejects(stat(path.join(memoryDir, "facts", todayStamp(), "undo-ok.md")), /ENOENT/);
  const restored = ledgerEvent(events.at(-1));
  assert.equal(restored.eventType, "restored");
  assert.equal(restored.reviewReceipt?.undoOfReceiptId, kept.receiptId);
});

test("undo after an intervening revision change returns conflict and leaves the memory unchanged", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [];
  const item = await writeQueueItem(memoryDir, "undo-conflict");
  const ctx = makeCtx(memoryDir, events);
  const kept = await executeReviewDeckAction(ctx, {
    schemaVersion: 1,
    itemId: "undo-conflict",
    revision: item.revision,
    action: "keep",
    idempotencyKey: "undo-conflict",
  });
  const promoted = path.join(memoryDir, "facts", todayStamp(), "undo-conflict.md");
  const edited = `${await readFile(promoted, "utf8")}\nEdited after keep.\n`;
  await writeFile(promoted, edited, "utf8");

  const undone = await executeReviewDeckUndo(ctx, {
    schemaVersion: 1,
    receiptId: kept.receiptId,
    expectedRevision: kept.appliedRevision ?? "",
    idempotencyKey: "undo-conflict-revert",
  });

  assert.equal(undone.outcome, "conflict");
  assert.equal(await readFile(promoted, "utf8"), edited);
  await assert.rejects(stat(item.filePath), /ENOENT/);
});

test("a corrupt receipt payload fails closed", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const events: unknown[] = [
    {
      eventId: "mle-corrupt",
      memoryId: "ghost",
      eventType: "promoted",
      timestamp: "2026-05-17T00:00:00.000Z",
      actor: "admin-console.review-deck",
      ruleVersion: "admin-console.review-deck.v1",
      reviewReceipt: {
        schemaVersion: 1,
        receiptId: "rcp1:corrupt",
        requestFingerprint: "rfp1:x",
        principalDigest: 12,
        itemId: "ghost",
        action: "approve",
        beforeRevision: "rv1:a",
        afterRevision: "rv1:b",
        sourcePath: "review/ghost.md",
      },
    },
  ];
  const item = await writeQueueItem(memoryDir, "ghost");
  const undone = await executeReviewDeckUndo(makeCtx(memoryDir, events), {
    schemaVersion: 1,
    receiptId: "rcp1:corrupt",
    expectedRevision: "rv1:b",
    idempotencyKey: "corrupt-undo",
  });
  assert.equal(undone.outcome, "failed");
  assert.equal(undone.itemId, "");
  assert.equal(await readFile(item.filePath, "utf8"), item.content);
  assert.equal(parseReviewLifecycleReceipt(ledgerEvent(events[0]).reviewReceipt), null);
});

test("parseReviewLifecycleReceipt rejects invalid fields", () => {
  assert.equal(parseReviewLifecycleReceipt(null), null);
  assert.equal(parseReviewLifecycleReceipt("nope"), null);
  assert.equal(
    parseReviewLifecycleReceipt({
      schemaVersion: 2,
      receiptId: "rcp1:x",
      requestFingerprint: "rfp1:x",
      principalDigest: "p",
      itemId: "i",
      action: "approve",
      beforeRevision: "a",
      afterRevision: "b",
      sourcePath: "review/x.md",
    }),
    null,
  );
  assert.equal(
    parseReviewLifecycleReceipt({
      schemaVersion: 1,
      receiptId: "rcp1:x",
      requestFingerprint: "rfp1:x",
      principalDigest: "p",
      itemId: "i",
      action: "approve",
      beforeRevision: "a",
      afterRevision: "b",
      sourcePath: "/abs/review/x.md",
    }),
    null,
  );
  const ok = parseReviewLifecycleReceipt({
    schemaVersion: 1,
    receiptId: "rcp1:x",
    requestFingerprint: "rfp1:x",
    principalDigest: "p",
    itemId: "i",
    action: "dismiss",
    beforeRevision: "a",
    afterRevision: "",
    sourcePath: "review/x.md",
    extra: "ignored",
  });
  assert.ok(ok);
  assert.equal(ok?.action, "dismiss");
  assert.equal(ok?.afterRevision, "");
});

