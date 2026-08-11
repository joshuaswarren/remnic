import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";

async function makeSubject() {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-passport-"));
  const aliceStorage = new StorageManager(path.join(root, "alice"));
  const bobStorage = new StorageManager(path.join(root, "bob"));
  await Promise.all([aliceStorage.ensureDirectories(), bobStorage.ensureDirectories()]);

  let currentTime = Date.parse("2026-08-11T12:00:00.000Z");
  const service = new SupportPassportCardService({
    now: () => new Date(currentTime),
    resolveOwner: async (principal) => {
      if (principal === "owner:alice") return { namespace: "alice", storage: aliceStorage };
      if (principal === "owner:bob") return { namespace: "bob", storage: bobStorage };
      throw new Error("unknown test principal");
    },
  });

  return {
    service,
    aliceStorage,
    advance: () => {
      currentTime += 1_000;
    },
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("manual support cards stay private until their owner approves them", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.service.createManualDraft({
      principal: "owner:alice",
      title: "When plans change",
      statement: "Tell me before plans change.",
      category: "transitions",
    });

    assert.equal(draft.status, "pending_review");
    assert.equal(draft.statement, "Tell me before plans change.");
    assert.equal(draft.reviewBy, "2027-02-07T12:00:00.000Z");
    assert.match(draft.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(await subject.service.listCards({ principal: "owner:bob" }), []);

    const stored = await subject.aliceStorage.getMemoryById(draft.cardId);
    assert.ok(stored);
    assert.equal(stored.frontmatter.category, "preference");
    assert.equal(stored.frontmatter.status, "pending_review");
    assert.ok(stored.frontmatter.tags.includes("support-passport-card"));
    assert.equal(stored.frontmatter.structuredAttributes?.["support-passport-title"], "When plans change");

    subject.advance();
    const approved = await subject.service.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });

    assert.equal(approved.status, "active");
    assert.notEqual(approved.revision, draft.revision);
    assert.equal((await subject.service.listCards({ principal: "owner:alice" }))[0]?.cardId, draft.cardId);
  } finally {
    await subject.cleanup();
  }
});

test("card mutations reject stale revisions and invalid lifecycle changes", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.service.createManualDraft({
      principal: "owner:alice",
      title: "Quiet space",
      statement: "Offer me a quiet place and time.",
      category: "environment",
    });

    await assert.rejects(
      subject.service.approveCard({
        principal: "owner:alice",
        cardId: draft.cardId,
        expectedRevision: "0".repeat(64),
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "revision_conflict"
    );

    const approved = await subject.service.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    await assert.rejects(
      subject.service.rejectCard({
        principal: "owner:alice",
        cardId: approved.cardId,
        expectedRevision: approved.revision,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_card_status"
    );
  } finally {
    await subject.cleanup();
  }
});

test("an approved replacement retires the prior card and withdrawal removes the new card", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.service.createManualDraft({
      principal: "owner:alice",
      title: "Bright lights",
      statement: "Bright lights make it hard for me to think.",
      category: "sensory",
    });
    const active = await subject.service.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });

    subject.advance();
    const replacement = await subject.service.replaceCard({
      principal: "owner:alice",
      cardId: active.cardId,
      expectedRevision: active.revision,
      title: "Lighting",
      statement: "Dim bright lights when you can.",
      category: "sensory",
    });
    assert.equal(replacement.status, "pending_review");
    assert.notEqual(replacement.cardId, active.cardId);
    assert.equal((await subject.aliceStorage.getMemoryById(active.cardId))?.frontmatter.status, "active");

    subject.advance();
    const approvedReplacement = await subject.service.approveCard({
      principal: "owner:alice",
      cardId: replacement.cardId,
      expectedRevision: replacement.revision,
    });
    assert.equal(approvedReplacement.status, "active");
    assert.equal((await subject.aliceStorage.getMemoryById(active.cardId))?.frontmatter.status, "superseded");

    subject.advance();
    await subject.service.withdrawCard({
      principal: "owner:alice",
      cardId: approvedReplacement.cardId,
      expectedRevision: approvedReplacement.revision,
    });
    assert.deepEqual(await subject.service.listCards({ principal: "owner:alice" }), []);
  } finally {
    await subject.cleanup();
  }
});

test("a rejected draft leaves no owner-visible card", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.service.createManualDraft({
      principal: "owner:alice",
      title: "Communication pause",
      statement: "Give me time when I stop speaking.",
      category: "communication",
    });

    await subject.service.rejectCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });

    assert.deepEqual(await subject.service.listCards({ principal: "owner:alice" }), []);
    assert.equal((await subject.aliceStorage.getMemoryById(draft.cardId))?.frontmatter.status, "rejected");
  } finally {
    await subject.cleanup();
  }
});

test("replacement approval rolls back when the prior card changes", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.service.createManualDraft({
      principal: "owner:alice",
      title: "Plan changes",
      statement: "Tell me before plans change.",
      category: "transitions",
    });
    const active = await subject.service.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const replacement = await subject.service.replaceCard({
      principal: "owner:alice",
      cardId: active.cardId,
      expectedRevision: active.revision,
      title: "Plan changes",
      statement: "Tell me early when plans change.",
      category: "transitions",
    });

    const priorMemory = await subject.aliceStorage.getMemoryById(active.cardId);
    assert.ok(priorMemory);
    assert.equal(
      await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(priorMemory, {
        status: "superseded",
        supersededBy: "another-replacement",
        updated: "2026-08-11T12:01:00.000Z",
      }),
      true
    );

    await assert.rejects(
      subject.service.approveCard({
        principal: "owner:alice",
        cardId: replacement.cardId,
        expectedRevision: replacement.revision,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal((await subject.aliceStorage.getMemoryById(replacement.cardId))?.frontmatter.status, "pending_review");
  } finally {
    await subject.cleanup();
  }
});
