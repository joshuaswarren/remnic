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
    const exactReads: string[] = [];
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      exactReads.push(memoryId);
      return await getMemoryById(memoryId);
    };
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const route: SupportPassportModelRoute = {
      kind: "gateway",
      invoke: async (messages) => {
        assert.deepEqual(exactReads, [selected.id]);
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
    assert.equal(records[0]?.outputSchemaVersion, 1);
    assert.equal(records[0]?.outcome, "success");
    const serializedAudit = JSON.stringify(records[0]);
    assert.equal(serializedAudit.includes("owner:alice"), false);
    assert.equal(serializedAudit.includes(selected.id), false);
    assert.equal(serializedAudit.includes("Tell me before"), false);
  } finally {
    await subject.cleanup();
  }
});

test("model failures produce a content-free audit record with an error class", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    const records: SupportPassportModelAuditRecord[] = [];
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [{ kind: "direct", invoke: async () => ({ content: "not-json", modelUsed: "openai/gpt-test" }) }],
      }),
      resolveOwner: subject.resolveOwner,
      audit: {
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({ principal: "owner:alice", sourceMemoryIds: [selected.id], consent: true }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "error");
    assert.equal(records[0]?.errorClass, "model_output_invalid");
    assert.equal(records[0]?.outputSchemaVersion, 1);
    const serializedAudit = JSON.stringify(records[0]);
    assert.equal(serializedAudit.includes(selected.id), false);
    assert.equal(serializedAudit.includes("Tell me before"), false);
    assert.equal(serializedAudit.includes("not-json"), false);
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

test("drafting revalidates selected memories after the model returns", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    const records: SupportPassportModelAuditRecord[] = [];
    const route: SupportPassportModelRoute = {
      kind: "local",
      invoke: async () => {
        const current = await subject.aliceStorage.getMemoryById(selected.id);
        assert.ok(current);
        assert.equal(
          await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(current, {
            status: "archived",
            archivedAt: "2026-08-11T12:00:00.000Z",
            updated: "2026-08-11T12:00:00.000Z",
          }),
          true
        );
        return {
          modelUsed: "local/test-model",
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

    await assert.rejects(
      service.draftCards({ principal: "owner:alice", sourceMemoryIds: [selected.id], consent: true }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    assert.deepEqual(await subject.cardService.listCards({ principal: "owner:alice" }), []);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "error");
    assert.equal(records[0]?.errorClass, "invalid_input");
  } finally {
    await subject.cleanup();
  }
});

test("audit write failures do not block successful drafts or replace model errors", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Give me time to answer.", {
      source: "test",
    });
    const audit = {
      record: async () => {
        throw new Error("audit unavailable");
      },
    };
    const successful = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => ({
              modelUsed: "local/test-model",
              content: JSON.stringify({
                cards: [
                  {
                    title: "Processing time",
                    statement: "Give me time to answer.",
                    category: "communication",
                    sourceMemoryIds: [selected.id],
                  },
                ],
              }),
            }),
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit,
      now: subject.now,
    });
    assert.equal(
      (await successful.draftCards({ principal: "owner:alice", sourceMemoryIds: [selected.id], consent: true })).length,
      1
    );

    const failing = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [{ kind: "local", invoke: async () => ({ modelUsed: "local/test-model", content: "not-json" }) }],
      }),
      resolveOwner: subject.resolveOwner,
      audit,
      now: subject.now,
    });
    await assert.rejects(
      failing.draftCards({ principal: "owner:alice", sourceMemoryIds: [selected.id], consent: true }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
    );
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
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const active = await subject.cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: active.cardId, revision: active.revision }],
      expiresAt: "2026-08-11T13:00:00.000Z",
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
    const records: SupportPassportModelAuditRecord[] = [];
    const questionService = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({ routes: [route] }),
      audit: {
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
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
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "error");
    assert.equal(records[0]?.errorClass, "grant_gone");
  } finally {
    await subject.cleanup();
  }
});

test("an audit write failure does not block a grounded helper answer", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.cardService.createManualDraft({
      principal: "owner:alice",
      title: "Quiet space",
      statement: "Offer me a quiet place and time.",
      category: "environment",
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const active = await subject.cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: active.cardId, revision: active.revision }],
      expiresAt: "2026-08-11T13:00:00.000Z",
    });
    const service = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "gateway",
            invoke: async () => ({
              modelUsed: "gateway/test-model",
              content: JSON.stringify({
                answer: "Offer a quiet place.",
                citedCardIds: [active.cardId],
                coverage: "grounded",
              }),
            }),
          },
        ],
      }),
      audit: {
        record: async () => {
          throw new Error("audit unavailable");
        },
      },
      now: subject.now,
    });

    const answer = await service.askGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
      question: "What can help?",
    });
    assert.equal(answer.answer, "Offer a quiet place.");
    assert.deepEqual(answer.citedCardIds, [active.cardId]);
  } finally {
    await subject.cleanup();
  }
});

test("a success audit runs after the grounded helper answer returns", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.cardService.createManualDraft({
      principal: "owner:alice",
      title: "Quiet space",
      statement: "Offer me a quiet place and time.",
      category: "environment",
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const active = await subject.cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: active.cardId, revision: active.revision }],
      expiresAt: "2026-08-11T13:00:00.000Z",
    });
    let auditCalls = 0;
    const service = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "gateway",
            invoke: async () => ({
              modelUsed: "gateway/test-model",
              content: JSON.stringify({
                answer: "Offer a quiet place.",
                citedCardIds: [active.cardId],
                coverage: "grounded",
              }),
            }),
          },
        ],
      }),
      audit: {
        record: async () => {
          auditCalls += 1;
        },
      },
      now: subject.now,
    });

    const answer = await service.askGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
      question: "What can help?",
    });
    assert.equal(answer.answer, "Offer a quiet place.");
    assert.equal(auditCalls, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(auditCalls, 1);
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
      outputSchemaVersion: 1,
      outcome: "success",
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
