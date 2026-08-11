import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore } from "./grant-store.js";
import { SupportPassportModelAdapter, type SupportPassportModelRoute } from "./model-adapter.js";
import {
  type SupportPassportModelAuditRecord,
  SupportPassportModelAuditRecordSchema,
  SupportPassportModelAuditStore,
} from "./model-audit.js";
import { SupportPassportDraftService, SupportPassportQuestionService } from "./model-service.js";

async function makeSubject() {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-service-"));
  const aliceStorage = new StorageManager(path.join(root, "alice"));
  await aliceStorage.ensureDirectories();
  const now = () => new Date("2026-08-11T12:00:00.000Z");
  const resolveOwner = async (principal: string) => {
    if (principal !== "owner:alice") throw new Error("unknown test principal");
    return { namespace: "alice", storage: aliceStorage };
  };
  const cardService = new SupportPassportCardService({ resolveOwner, now });
  const grantStore = new SupportPassportGrantStore({ memoryDir: path.join(root, "shared"), now });
  const grantService = new SupportPassportGrantService({
    grantStore,
    resolveOwner,
    resolveNamespace: async () => aliceStorage,
    now,
  });
  return {
    root,
    now,
    aliceStorage,
    resolveOwner,
    cardService,
    grantService,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("drafting reads only selected memories and persists pending cards with a content-free audit", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    const unselected = await subject.aliceStorage.writeMemory("preference", "Do not send this note.", {
      source: "test",
    });
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const route: SupportPassportModelRoute = {
      kind: "gateway",
      invoke: async (messages) => {
        calls.push(messages);
        return {
          modelUsed: "gateway/test-model",
          content: JSON.stringify({
            cards: [
              {
                title: "Plan changes",
                statement: "Tell me before plans change.",
                category: "transitions",
                sourceMemoryIds: [selected.id],
              },
            ],
          }),
        };
      },
    };
    const records: SupportPassportModelAuditRecord[] = [];
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({ routes: [route] }),
      resolveOwner: subject.resolveOwner,
      audit: {
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
      now: subject.now,
    });

    const cards = await service.draftCards({
      principal: "owner:alice",
      sourceMemoryIds: [selected.id],
      consent: true,
    });

    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.status, "pending_review");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[1]?.content.includes(selected.id), true);
    assert.equal(calls[0]?.[1]?.content.includes(unselected.id), false);
    const firstCard = cards[0];
    assert.ok(firstCard);
    const stored = await subject.aliceStorage.getMemoryById(firstCard.cardId);
    assert.deepEqual(stored?.frontmatter.lineage, [selected.id]);
    assert.equal(records.length, 1);
    const serializedAudit = JSON.stringify(records[0]);
    assert.equal(serializedAudit.includes("owner:alice"), false);
    assert.equal(serializedAudit.includes(selected.id), false);
    assert.equal(serializedAudit.includes("Tell me before"), false);
  } finally {
    await subject.cleanup();
  }
});

test("drafting rejects missing sources and absent consent before the model runs", async () => {
  const subject = await makeSubject();
  try {
    let calls = 0;
    const modelAdapter = new SupportPassportModelAdapter({
      routes: [
        {
          kind: "local",
          invoke: async () => {
            calls += 1;
            return null;
          },
        },
      ],
    });
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter,
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({ principal: "owner:alice", sourceMemoryIds: ["missing-memory"], consent: true }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    await assert.rejects(
      service.draftCards({ principal: "owner:alice", sourceMemoryIds: ["missing-memory"], consent: false }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "consent_required"
    );
    assert.equal(calls, 0);
  } finally {
    await subject.cleanup();
  }
});

test("helper questions recheck the grant after the model call", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.cardService.createManualDraft({
      principal: "owner:alice",
      title: "Quiet space",
      statement: "Offer me a quiet place and time.",
      category: "environment",
    });
    const active = await subject.cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: active.cardId, revision: active.revision }],
      durationSeconds: 3_600,
    });
    const route: SupportPassportModelRoute = {
      kind: "gateway",
      invoke: async () => {
        await subject.grantService.revokeGrant({
          principal: "owner:alice",
          grantId: created.grant.grantId,
          expectedStateVersion: created.grant.stateVersion,
        });
        return {
          modelUsed: "gateway/test-model",
          content: JSON.stringify({
            answer: "Offer a quiet place.",
            citedCardIds: [active.cardId],
            coverage: "grounded",
          }),
        };
      },
    };
    const questionService = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({ routes: [route] }),
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      questionService.askGrant({
        grantId: created.grant.grantId,
        secret: created.secret,
        question: "What can help?",
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone"
    );
  } finally {
    await subject.cleanup();
  }
});

test("the model audit store writes strict private JSONL without text fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-audit-"));
  try {
    const store = new SupportPassportModelAuditStore({ memoryDir: root });
    const record = SupportPassportModelAuditRecordSchema.parse({
      schemaVersion: 1,
      operation: "draft_cards",
      actorHash: "a".repeat(64),
      subjectIdsHash: "b".repeat(64),
      modelUsed: "gateway/test-model",
      route: "gateway",
      occurredAt: "2026-08-11T12:00:00.000Z",
      latencyMs: 25,
    });
    await store.record(record);
    const auditPath = path.join(root, "state", "support-passport", "audit", "2026-08-11.jsonl");
    assert.deepEqual(JSON.parse((await readFile(auditPath, "utf8")).trim()), record);
    assert.equal((await lstat(auditPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(auditPath))).mode & 0o777, 0o700);
    assert.equal(SupportPassportModelAuditRecordSchema.safeParse({ ...record, question: "private" }).success, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
