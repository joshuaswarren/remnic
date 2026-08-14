import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import type { HeldFileLockController } from "../utils/serialize-mutations.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore } from "./grant-store.js";
import { SupportPassportModelAdapter, type SupportPassportModelRoute } from "./model-adapter.js";
import {
  type SupportPassportModelAuditRecord,
  SupportPassportModelAuditRecordSchema,
  SupportPassportModelAuditStore,
  hashSupportPassportAuditValues,
} from "./model-audit.js";
import {
  SupportPassportDraftService,
  SupportPassportQuestionService,
  computeSupportPassportSourceRevision,
} from "./model-service.js";

async function flushAudit(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeAuditRecord(overrides: Partial<SupportPassportModelAuditRecord> = {}): SupportPassportModelAuditRecord {
  return SupportPassportModelAuditRecordSchema.parse({
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
    ...overrides,
  });
}

function sourceRevision(memoryId: string, content: string) {
  return [{ memoryId, revision: computeSupportPassportSourceRevision(content) }];
}

async function makeSubject() {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-service-"));
  const aliceStorage = new StorageManager(path.join(root, "alice"));
  await aliceStorage.ensureDirectories();
  const now = () => new Date("2026-08-11T12:00:00.000Z");
  const resolveOwner = async (principal: string) => {
    if (principal !== "owner:alice") throw new Error("unknown test principal");
    return { principal, namespace: "alice", storage: aliceStorage };
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
      sourceMemoryRevisions: sourceRevision(selected.id, "Tell me before plans change."),
      consent: true,
    });
    await flushAudit();

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

test("drafting persists into the owner scope used for source reads", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-owner-scope-"));
  const aliceStorage = new StorageManager(path.join(root, "alice"));
  const bobStorage = new StorageManager(path.join(root, "bob"));
  try {
    await Promise.all([aliceStorage.ensureDirectories(), bobStorage.ensureDirectories()]);
    const selected = await aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    let ownerResolutions = 0;
    const resolveOwner = async (principal: string) => {
      ownerResolutions += 1;
      return ownerResolutions === 1
        ? { principal, namespace: "alice", storage: aliceStorage }
        : { principal, namespace: "bob", storage: bobStorage };
    };
    const cardService = new SupportPassportCardService({ resolveOwner });
    const service = new SupportPassportDraftService({
      cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => ({
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
            }),
          },
        ],
      }),
      resolveOwner,
      audit: { record: async () => undefined },
    });

    const cards = await service.draftCards({
      principal: "owner:alice",
      sourceMemoryIds: [selected.id],
      sourceMemoryRevisions: sourceRevision(selected.id, "Tell me before plans change."),
      consent: true,
    });

    assert.equal(ownerResolutions, 1);
    assert.equal(cards.length, 1);
    assert.ok(await aliceStorage.getMemoryById(cards[0]?.cardId ?? ""));
    assert.deepEqual(await bobStorage.readAllMemories(), []);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("drafting never sends another owner's support card to a model", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-private-source-"));
  const storage = new StorageManager(path.join(root, "shared"));
  try {
    await storage.ensureDirectories();
    const resolveOwner = async (principal: string) => ({ principal, namespace: "team", storage });
    const cardService = new SupportPassportCardService({ resolveOwner });
    const bobDraft = await cardService.createManualDraft({
      principal: "owner:bob",
      title: "Private support",
      statement: "Do not disclose this private support statement.",
      category: "other",
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const bobCard = await cardService.approveCard({
      principal: "owner:bob",
      cardId: bobDraft.cardId,
      expectedRevision: bobDraft.revision,
    });
    const stored = await storage.getMemoryById(bobCard.cardId);
    assert.ok(stored);
    let modelCalls = 0;
    const service = new SupportPassportDraftService({
      cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner,
      audit: { record: async () => undefined },
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [bobCard.cardId],
        sourceMemoryRevisions: [
          {
            memoryId: bobCard.cardId,
            revision: computeSupportPassportSourceRevision(
              stored.content,
              stored.frontmatter.structuredAttributes,
            ),
          },
        ],
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input",
    );
    assert.equal(modelCalls, 0);
    assert.deepEqual(await cardService.listCards({ principal: "owner:alice" }), []);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("drafting rejects a resolved principal that differs from the authenticated principal", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    let modelCalls = 0;
    const resolveOwner = async () => ({
      principal: "authenticated:alice",
      namespace: "alice",
      storage: subject.aliceStorage,
    });
    const service = new SupportPassportDraftService({
      cardService: new SupportPassportCardService({ resolveOwner }),
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "request:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Tell me before plans change."),
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "card_data_invalid"
    );
    assert.equal(modelCalls, 0);
    assert.deepEqual(
      (await subject.aliceStorage.readAllMemories()).map((memory) => memory.frontmatter.id),
      [selected.id]
    );
  } finally {
    await subject.cleanup();
  }
});

test("drafting rejects a non-canonical authenticated owner scope before model disclosure", async () => {
  const subject = await makeSubject();
  try {
    let modelCalls = 0;
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner: async (principal) => ({
        principal,
        namespace: " alice ",
        storage: subject.aliceStorage,
      }),
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: ["selected-memory"],
        sourceMemoryRevisions: [{ memoryId: "selected-memory", revision: "a".repeat(64) }],
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "card_data_invalid"
    );
    assert.equal(modelCalls, 0);
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
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Tell me before plans change."),
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
    );
    await flushAudit();
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
      (
        service.draftCards as unknown as (input: {
          principal: string;
          sourceMemoryIds: string[];
          consent: boolean;
        }) => Promise<unknown>
      )({
        principal: "owner:alice",
        sourceMemoryIds: ["missing-memory"],
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: ["missing-memory"],
        sourceMemoryRevisions: [{ memoryId: "missing-memory", revision: "a".repeat(64) }],
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    await flushAudit();
    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: ["missing-memory"],
        sourceMemoryRevisions: [{ memoryId: "missing-memory", revision: "a".repeat(64) }],
        consent: false,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "consent_required"
    );
    assert.equal(calls, 0);
  } finally {
    await subject.cleanup();
  }
});

test("drafting stops before owner resolution when the request is already cancelled", async () => {
  const subject = await makeSubject();
  try {
    let ownerResolutions = 0;
    let modelCalls = 0;
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner: async (principal) => {
        ownerResolutions += 1;
        return await subject.resolveOwner(principal);
      },
      audit: { record: async () => undefined },
      now: subject.now,
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: ["selected-memory"],
        sourceMemoryRevisions: [{ memoryId: "selected-memory", revision: "a".repeat(64) }],
        consent: true,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(ownerResolutions, 0);
    assert.equal(modelCalls, 0);
  } finally {
    await subject.cleanup();
  }
});

test("drafting cancellation races a selected source read", async () => {
  const subject = await makeSubject();
  const sourceReadStarted = Promise.withResolvers<void>();
  const releaseSourceRead = Promise.withResolvers<void>();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Give me time to answer.", {
      source: "test",
    });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      sourceReadStarted.resolve();
      await releaseSourceRead.promise;
      return await getMemoryById(memoryId);
    };
    let modelCalls = 0;
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });
    const controller = new AbortController();
    const drafting = service.draftCards({
      principal: "owner:alice",
      sourceMemoryIds: [selected.id],
      sourceMemoryRevisions: sourceRevision(selected.id, "Give me time to answer."),
      consent: true,
      signal: controller.signal,
    });
    await sourceReadStarted.promise;
    controller.abort();

    await assert.rejects(
      Promise.race([
        drafting,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Draft cancellation waited for the source read.")), 100)
        ),
      ]),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(modelCalls, 0);
  } finally {
    releaseSourceRead.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await subject.cleanup();
  }
});

test("drafting rejects a memory changed after the owner reviewed it", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    const reviewedRevision = sourceRevision(selected.id, "Tell me before plans change.");
    assert.equal(await subject.aliceStorage.updateMemory(selected.id, "Tell me only after plans change."), true);
    let modelCalls = 0;
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: reviewedRevision,
        consent: true,
      }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "revision_conflict" && error.status === 409
    );
    assert.equal(modelCalls, 0);
  } finally {
    await subject.cleanup();
  }
});

test("drafting preserves literal attribute-style source text", async () => {
  const subject = await makeSubject();
  try {
    const content = "Keep this literal line.\n[Attributes: user-authored note]";
    const selected = await subject.aliceStorage.writeMemory("preference", content, { source: "test" });
    const modelInputs: string[] = [];
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async (messages) => {
              modelInputs.push(messages[1]?.content ?? "");
              return {
                modelUsed: "local/test-model",
                content: JSON.stringify({
                  cards: [
                    {
                      title: "Literal note",
                      statement: "Keep the complete note.",
                      category: "other",
                      sourceMemoryIds: [selected.id],
                    },
                  ],
                }),
              };
            },
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await service.draftCards({
      principal: "owner:alice",
      sourceMemoryIds: [selected.id],
      sourceMemoryRevisions: sourceRevision(selected.id, content),
      consent: true,
    });

    assert.equal(modelInputs[0]?.includes("[Attributes: user-authored note]"), true);
    assert.notEqual(
      computeSupportPassportSourceRevision(content),
      computeSupportPassportSourceRevision("Keep this literal line.")
    );
  } finally {
    await subject.cleanup();
  }
});

test("drafting strips persisted structured attributes from model input and source revisions", async () => {
  const subject = await makeSubject();
  try {
    const content = "Give me time to answer.";
    const selected = await subject.aliceStorage.writeMemory("preference", content, {
      source: "test",
      structuredAttributes: { need: "processing time" },
    });
    const stored = await subject.aliceStorage.getMemoryById(selected.id);
    assert.ok(stored);
    const modelInputs: string[] = [];
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async (messages) => {
              modelInputs.push(messages[1]?.content ?? "");
              return {
                modelUsed: "local/test-model",
                content: JSON.stringify({
                  cards: [
                    {
                      title: "Processing time",
                      statement: content,
                      category: "communication",
                      sourceMemoryIds: [selected.id],
                    },
                  ],
                }),
              };
            },
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await service.draftCards({
      principal: "owner:alice",
      sourceMemoryIds: [selected.id],
      sourceMemoryRevisions: [
        {
          memoryId: selected.id,
          revision: computeSupportPassportSourceRevision(stored.content, stored.frontmatter.structuredAttributes),
        },
      ],
      consent: true,
    });

    assert.equal(modelInputs[0]?.includes("[Attributes:"), false);
    assert.equal(modelInputs[0]?.includes(content), true);
  } finally {
    await subject.cleanup();
  }
});

test("drafting validates the complete source snapshot before model disclosure", async () => {
  const subject = await makeSubject();
  try {
    const first = await subject.aliceStorage.writeMemory("preference", "Give me time to answer.", {
      source: "test",
    });
    const second = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let archivedFirst = false;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      if (memoryId === second.id && !archivedFirst) {
        archivedFirst = true;
        const current = await getMemoryById(first.id);
        assert.ok(current);
        assert.equal(
          await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(current, {
            status: "archived",
            archivedAt: "2026-08-11T12:00:00.000Z",
            updated: "2026-08-11T12:00:00.000Z",
          }),
          true
        );
      }
      return await getMemoryById(memoryId);
    };
    let modelCalls = 0;
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [first.id, second.id],
        sourceMemoryRevisions: [
          ...sourceRevision(first.id, "Give me time to answer."),
          ...sourceRevision(second.id, "Tell me before plans change."),
        ],
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    assert.equal(modelCalls, 0);
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
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Tell me before plans change."),
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    assert.deepEqual(await subject.cardService.listCards({ principal: "owner:alice" }), []);
    await flushAudit();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "error");
    assert.equal(records[0]?.errorClass, "invalid_input");
  } finally {
    await subject.cleanup();
  }
});

test("drafting rolls back when a selected memory changes during persistence", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Tell me before plans change.", {
      source: "test",
    });
    const writeSealedMemory = subject.aliceStorage.writeSealedMemory.bind(subject.aliceStorage);
    subject.aliceStorage.writeSealedMemory = async (...args) => {
      const written = await writeSealedMemory(...args);
      const source = await subject.aliceStorage.getMemoryById(selected.id);
      assert.ok(source);
      assert.equal(
        await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(source, {
          status: "archived",
          archivedAt: "2026-08-11T12:00:00.000Z",
          updated: "2026-08-11T12:00:00.000Z",
        }),
        true
      );
      return written;
    };
    const service = new SupportPassportDraftService({
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
                    title: "Plan changes",
                    statement: "Tell me before plans change.",
                    category: "transitions",
                    sourceMemoryIds: [selected.id],
                  },
                ],
              }),
            }),
          },
        ],
      }),
      resolveOwner: subject.resolveOwner,
      audit: { record: async () => undefined },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Tell me before plans change."),
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    assert.deepEqual(await subject.cardService.listCards({ principal: "owner:alice" }), []);
  } finally {
    await subject.cleanup();
  }
});

test("cancellation rolls back a generated batch and records an aborted audit", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Give me time to answer.", {
      source: "test",
    });
    const controller = new AbortController();
    const records: SupportPassportModelAuditRecord[] = [];
    const writeSealedMemory = subject.aliceStorage.writeSealedMemory.bind(subject.aliceStorage);
    let draftWrites = 0;
    subject.aliceStorage.writeSealedMemory = async (...args) => {
      const written = await writeSealedMemory(...args);
      draftWrites += 1;
      controller.abort(new Error("cancelled during draft persistence"));
      return written;
    };
    const service = new SupportPassportDraftService({
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
                  {
                    title: "Pause before repeating",
                    statement: "Pause before you repeat a question.",
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
      audit: {
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Give me time to answer."),
        consent: true,
        signal: controller.signal,
      }),
      /cancelled during draft persistence/
    );
    assert.equal(draftWrites, 1);
    assert.deepEqual(await subject.cardService.listCards({ principal: "owner:alice" }), []);
    await flushAudit();
    assert.equal(records[0]?.errorClass, "aborted");
  } finally {
    await subject.cleanup();
  }
});

test("an incomplete cancellation rollback records the storage conflict", async () => {
  const subject = await makeSubject();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Give me time to answer.", {
      source: "test",
    });
    const controller = new AbortController();
    const records: SupportPassportModelAuditRecord[] = [];
    const writeSealedMemory = subject.aliceStorage.writeSealedMemory.bind(subject.aliceStorage);
    subject.aliceStorage.writeSealedMemory = async (...args) => {
      const written = await writeSealedMemory(...args);
      controller.abort(new Error("cancelled during draft persistence"));
      return written;
    };
    subject.aliceStorage.writeMemoryFrontmatterIfUnchanged = async () => false;
    const service = new SupportPassportDraftService({
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
      audit: {
        record: async (record) => {
          records.push(record);
        },
      },
      now: subject.now,
    });

    await assert.rejects(
      service.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Give me time to answer."),
        consent: true,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    await flushAudit();
    assert.equal(records[0]?.errorClass, "storage_conflict");
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
      (
        await successful.draftCards({
          principal: "owner:alice",
          sourceMemoryIds: [selected.id],
          sourceMemoryRevisions: sourceRevision(selected.id, "Give me time to answer."),
          consent: true,
        })
      ).length,
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
      failing.draftCards({
        principal: "owner:alice",
        sourceMemoryIds: [selected.id],
        sourceMemoryRevisions: sourceRevision(selected.id, "Give me time to answer."),
        consent: true,
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
    );
  } finally {
    await subject.cleanup();
  }
});

test("stalled error audits do not delay the model error", async () => {
  const subject = await makeSubject();
  const auditStarted = Promise.withResolvers<void>();
  const releaseAudit = Promise.withResolvers<void>();
  try {
    const selected = await subject.aliceStorage.writeMemory("preference", "Give me time to answer.", {
      source: "test",
    });
    const service = new SupportPassportDraftService({
      cardService: subject.cardService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [{ kind: "local", invoke: async () => ({ modelUsed: "local/test-model", content: "not-json" }) }],
      }),
      resolveOwner: subject.resolveOwner,
      audit: {
        record: async () => {
          auditStarted.resolve();
          await releaseAudit.promise;
        },
      },
      now: subject.now,
    });

    await assert.rejects(
      Promise.race([
        service.draftCards({
          principal: "owner:alice",
          sourceMemoryIds: [selected.id],
          sourceMemoryRevisions: sourceRevision(selected.id, "Give me time to answer."),
          consent: true,
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("The model error waited for its audit.")), 100)
        ),
      ]),
      (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
    );
    await auditStarted.promise;
  } finally {
    releaseAudit.resolve();
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
    await flushAudit();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "error");
    assert.equal(records[0]?.errorClass, "grant_gone");
  } finally {
    await subject.cleanup();
  }
});

test("helper question audits hash the canonical grant ID", async () => {
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
    const records: SupportPassportModelAuditRecord[] = [];
    const service = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => ({
              modelUsed: "local/test-model",
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
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
      now: subject.now,
    });

    await service.askGrant({
      grantId: created.grant.grantId.toUpperCase(),
      secret: created.secret,
      question: "What can help?",
    });
    await flushAudit();

    assert.equal(records[0]?.actorHash, hashSupportPassportAuditValues("helper-grant", [created.grant.grantId]));
  } finally {
    await subject.cleanup();
  }
});

test("helper questions honor cancellation during final grant validation", async () => {
  const subject = await makeSubject();
  const finalReadStarted = Promise.withResolvers<void>();
  const releaseFinalRead = Promise.withResolvers<void>();
  const finalReadSettled = Promise.withResolvers<void>();
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
    const readGrant = subject.grantService.readGrant.bind(subject.grantService);
    let reads = 0;
    subject.grantService.readGrant = async (input) => {
      reads += 1;
      if (reads === 2) {
        finalReadStarted.resolve();
        await releaseFinalRead.promise;
        try {
          return await readGrant(input);
        } finally {
          finalReadSettled.resolve();
        }
      }
      return await readGrant(input);
    };
    const records: SupportPassportModelAuditRecord[] = [];
    const service = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => ({
              modelUsed: "local/test-model",
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
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
      now: subject.now,
    });
    const controller = new AbortController();
    const answer = service.askGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
      question: "What can help?",
      signal: controller.signal,
    });
    await finalReadStarted.promise;
    controller.abort();
    releaseFinalRead.resolve();

    await assert.rejects(answer, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await flushAudit();
    assert.equal(records[0]?.outcome, "error");
    assert.equal(records[0]?.errorClass, "aborted");
  } finally {
    releaseFinalRead.resolve();
    await finalReadSettled.promise;
    await flushAudit();
    await subject.cleanup();
  }
});

test("helper question cancellation races the initial grant read", async () => {
  const subject = await makeSubject();
  const grantReadStarted = Promise.withResolvers<void>();
  const releaseGrantRead = Promise.withResolvers<void>();
  try {
    let modelCalls = 0;
    subject.grantService.readGrant = async () => {
      grantReadStarted.resolve();
      await releaseGrantRead.promise;
      throw new Error("released stalled grant read");
    };
    const service = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "gateway",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      audit: { record: async () => undefined },
      now: subject.now,
    });
    const controller = new AbortController();
    const answer = service.askGrant({
      grantId: "00000000-0000-4000-8000-000000000001",
      secret: "x".repeat(43),
      question: "What can help?",
      signal: controller.signal,
    });
    await grantReadStarted.promise;
    controller.abort();

    await assert.rejects(
      Promise.race([
        answer,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Question cancellation waited for the grant read.")), 100)
        ),
      ]),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(modelCalls, 0);
  } finally {
    releaseGrantRead.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await subject.cleanup();
  }
});

test("invalid helper questions use the invalid-input audit class", async () => {
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
    let modelCalls = 0;
    const records: SupportPassportModelAuditRecord[] = [];
    const service = new SupportPassportQuestionService({
      grantService: subject.grantService,
      modelAdapter: new SupportPassportModelAdapter({
        routes: [
          {
            kind: "local",
            invoke: async () => {
              modelCalls += 1;
              return null;
            },
          },
        ],
      }),
      audit: {
        record: async (record) => {
          records.push(SupportPassportModelAuditRecordSchema.parse(record));
        },
      },
      now: subject.now,
    });

    await assert.rejects(
      service.askGrant({
        grantId: created.grant.grantId,
        secret: created.secret,
        question: "   ",
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    await flushAudit();
    assert.equal(modelCalls, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.errorClass, "invalid_input");
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
    const record = makeAuditRecord();
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

test("the model audit store expands a leading tilde in its memory directory", () => {
  const store = new SupportPassportModelAuditStore({ memoryDir: "~/support-passport-audit-path-test" });
  const memoryDir = (store as unknown as { memoryDir: string }).memoryDir;
  assert.equal(memoryDir.includes(`${path.sep}~${path.sep}`), false);
  assert.equal(path.basename(memoryDir), "support-passport-audit-path-test");
  assert.equal(path.isAbsolute(memoryDir), true);
});

test("the model audit store rejects a symlink alias in its configured memory root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-audit-root-link-"));
  try {
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    const store = new SupportPassportModelAuditStore({ memoryDir: path.join(alias, "memory") });

    await assert.rejects(store.record(makeAuditRecord()), /memory directory must be a stable directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the model audit store rejects symlinked and hard-linked audit files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-audit-links-"));
  try {
    const store = new SupportPassportModelAuditStore({ memoryDir: root });
    await store.record(makeAuditRecord({ occurredAt: "2026-08-10T12:00:00.000Z" }));
    const auditPath = path.join(root, "state", "support-passport", "audit", "2026-08-11.jsonl");
    const outsidePath = path.join(root, "outside.jsonl");
    await writeFile(outsidePath, "outside\n", { mode: 0o600 });

    await symlink(outsidePath, auditPath);
    await assert.rejects(store.record(makeAuditRecord()), /regular files in a stable directory/);
    assert.equal(await readFile(outsidePath, "utf8"), "outside\n");

    await rm(auditPath);
    await link(outsidePath, auditPath);
    await assert.rejects(store.record(makeAuditRecord()), /regular files in a stable directory/);
    assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the model audit lock uses the pinned audit directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-audit-lock-"));
  try {
    let lockPath = "";
    const acceptLock = (async (candidate, _options, task) => {
      lockPath = candidate;
      return await task(true, { refresh: async () => true } as HeldFileLockController);
    }) as typeof import("../utils/serialize-mutations.js").withHeldFileLock;
    const store = new SupportPassportModelAuditStore({ memoryDir: root, withHeldFileLock: acceptLock });

    await store.record(makeAuditRecord());

    assert.equal(lockPath.startsWith("/proc/self/fd/") || lockPath.startsWith("/dev/fd/"), true);
    assert.equal(lockPath.includes(path.join(root, "state")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
