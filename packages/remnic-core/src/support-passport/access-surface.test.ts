import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseConfig } from "../config.js";
import { StorageManager } from "../storage.js";
import { SupportPassportAccessSurface } from "./access-surface.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportModelAdapter, type SupportPassportModelRoute } from "./model-adapter.js";

test("the access surface runs the owner and helper lifecycle without exposing a secret in owner lists", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-access-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const source = await storage.writeMemory("preference", "Tell me before plans change.", { source: "test" });
    const route: SupportPassportModelRoute = {
      kind: "local",
      invoke: async (_messages, options) => ({
        modelUsed: "local/test-model",
        content:
          options.operation === "support-passport-draft"
            ? JSON.stringify({
                cards: [
                  {
                    title: "Plan changes",
                    statement: "Tell me before plans change.",
                    category: "transitions",
                    sourceMemoryIds: [source.id],
                  },
                ],
              })
            : JSON.stringify({
                answer: "Tell this person before plans change.",
                citedCardIds: [approvedCardId],
                coverage: "grounded",
              }),
      }),
    };
    let approvedCardId = "";
    const surface = new SupportPassportAccessSurface({
      config: parseConfig({ memoryDir: root, supportPassport: { enabled: true } }),
      resolveOwner: async (principal) => {
        assert.equal(principal, "owner:test");
        return { principal, namespace: "owner", storage };
      },
      resolveNamespace: async (namespace) => {
        assert.equal(namespace, "owner");
        return storage;
      },
      modelAdapter: new SupportPassportModelAdapter({ routes: [route] }),
      audit: { record: async () => undefined },
      now: () => now,
    });

    const preview = await surface.previewMemory("owner:test", source.id);
    assert.equal(preview.found, true);
    if (!preview.found) throw new Error("source preview was not found");
    assert.equal(preview.memory.content, "Tell me before plans change.");
    assert.match(preview.memory.revision, /^[a-f0-9]{64}$/);
    const drafts = await surface.generateDrafts("owner:test", {
      sourceMemoryIds: [source.id],
      sourceMemoryRevisions: [{ memoryId: source.id, revision: preview.memory.revision }],
      consent: true,
    });
    const draft = drafts[0];
    assert.ok(draft);
    const approved = await surface.approveCard("owner:test", draft.cardId, {
      expectedRevision: draft.revision,
      reasonCode: "owner-approved",
    });
    approvedCardId = approved.cardId;
    await assert.rejects(
      surface.createGrant("owner:test", {
        cardIds: [approved.cardId],
        cardRevisions: [{ cardId: approved.cardId, revision: "0".repeat(64) }],
        expiresAt: "2026-08-11T14:00:00.123Z",
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "revision_conflict"
    );
    await assert.rejects(
      surface.createGrant("owner:test", {
        cardIds: [approved.cardId],
        cardRevisions: [{ cardId: approved.cardId, revision: approved.revision }],
        expiresAt: "2026-08-11T12:04:59.999Z",
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    const created = await surface.createGrant("owner:test", {
      cardIds: [approved.cardId],
      cardRevisions: [{ cardId: approved.cardId, revision: approved.revision }],
      expiresAt: "2026-08-11T14:00:00.123Z",
    });
    assert.equal(created.expiresAt, "2026-08-11T14:00:00.123Z");

    const ownerGrants = await surface.listGrants("owner:test");
    assert.equal(ownerGrants.length, 1);
    assert.equal(JSON.stringify(ownerGrants).includes(created.secret), false);
    const guide = await surface.readGrant(created.grantId, created.secret);
    assert.equal(guide.cards[0]?.cardId, approved.cardId);
    const answer = await surface.askGrant(created.grantId, created.secret, "What should I do?");
    assert.deepEqual(answer.citedCardIds, [approved.cardId]);
    const stopped = await surface.revokeGrant("owner:test", created.grantId, {
      expectedVersion: created.version,
    });
    assert.equal(stopped.version, 2);
    await assert.rejects(
      surface.readGrant(created.grantId, created.secret),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("the access surface fails closed while the feature flag is off", async () => {
  const config = parseConfig({ supportPassport: { enabled: false } });
  const surface = new SupportPassportAccessSurface({
    config,
    resolveOwner: async () => {
      throw new Error("owner resolution must not run");
    },
    resolveNamespace: async () => {
      throw new Error("namespace resolution must not run");
    },
    modelAdapter: new SupportPassportModelAdapter({ routes: [] }),
    audit: { record: async () => undefined },
  });

  await assert.rejects(
    surface.listCards("owner:test"),
    (error: unknown) => error instanceof SupportPassportError && error.code === "feature_disabled"
  );
  await assert.rejects(
    surface.readGrant("missing", "missing"),
    (error: unknown) => error instanceof SupportPassportError && error.code === "grant_not_found"
  );
});

test("memory preview hides sources that cannot be drafted", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-preview-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    const source = await storage.writeMemory("preference", "Tell me before plans change.", { source: "test" });
    const surface = new SupportPassportAccessSurface({
      config: parseConfig({ memoryDir: root, supportPassport: { enabled: true } }),
      resolveOwner: async (principal) => ({ principal, namespace: "owner", storage }),
      resolveNamespace: async () => storage,
      modelAdapter: new SupportPassportModelAdapter({ routes: [] }),
      audit: { record: async () => undefined },
    });

    for (const lifecycle of [
      { status: "archived" as const, archivedAt: "2026-08-12T12:00:00.000Z" },
      { status: "active" as const, archivedAt: undefined, blockedBy: "memory-review" },
      { status: "active" as const, blockedBy: undefined, supersededBy: "replacement-memory" },
    ]) {
      const current = await storage.getMemoryById(source.id);
      assert.ok(current);
      assert.equal(
        await storage.writeMemoryFrontmatterIfUnchanged(current, {
          status: lifecycle.status,
          archivedAt: lifecycle.archivedAt,
          blockedBy: lifecycle.blockedBy,
          supersededBy: lifecycle.supersededBy,
        }),
        true
      );
      assert.deepEqual(await surface.previewMemory("owner:test", source.id), { found: false });
    }
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory preview validates the resolved owner before reading private text", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-preview-owner-"));
  try {
    const storage = new StorageManager(path.join(root, "other-owner"));
    await storage.ensureDirectories();
    const source = await storage.writeMemory("preference", "Private text for another owner.", { source: "test" });
    let reads = 0;
    const getMemoryById = storage.getMemoryById.bind(storage);
    storage.getMemoryById = async (memoryId) => {
      reads += 1;
      return await getMemoryById(memoryId);
    };
    const surface = new SupportPassportAccessSurface({
      config: parseConfig({ memoryDir: root, supportPassport: { enabled: true } }),
      resolveOwner: async () => ({ principal: "owner:other", namespace: "other", storage }),
      resolveNamespace: async () => storage,
      modelAdapter: new SupportPassportModelAdapter({ routes: [] }),
      audit: { record: async () => undefined },
    });

    await assert.rejects(
      surface.previewMemory("owner:test", source.id),
      (error: unknown) => error instanceof SupportPassportError && error.code === "card_data_invalid"
    );
    assert.equal(reads, 0);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory preview hides sources that exceed the draft model input limit", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-preview-limit-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    const source = await storage.writeMemory("preference", "x".repeat(20_001), { source: "test" });
    const surface = new SupportPassportAccessSurface({
      config: parseConfig({ memoryDir: root, supportPassport: { enabled: true } }),
      resolveOwner: async (principal) => ({ principal, namespace: "owner", storage }),
      resolveNamespace: async () => storage,
      modelAdapter: new SupportPassportModelAdapter({ routes: [] }),
      audit: { record: async () => undefined },
    });

    assert.deepEqual(await surface.previewMemory("owner:test", source.id), { found: false });
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner operations reject a missing trusted principal as forbidden", async () => {
  const surface = new SupportPassportAccessSurface({
    config: parseConfig({ supportPassport: { enabled: true } }),
    resolveOwner: async () => {
      throw new Error("owner resolution must not run");
    },
    resolveNamespace: async () => {
      throw new Error("namespace resolution must not run");
    },
    modelAdapter: new SupportPassportModelAdapter({ routes: [] }),
    audit: { record: async () => undefined },
  });

  await assert.rejects(
    surface.listCards(" "),
    (error: unknown) => error instanceof SupportPassportError && error.code === "forbidden" && error.status === 403
  );
});
