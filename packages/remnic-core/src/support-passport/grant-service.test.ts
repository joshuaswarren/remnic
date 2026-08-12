import assert from "node:assert/strict";
import { renameSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore, syncDirectoryForDurability } from "./grant-store.js";
import { requirePrivateFileDescriptorRoot } from "./private-file.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";

async function makeSubject() {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grants-"));
  const aliceStorage = new StorageManager(path.join(root, "alice"));
  const bobStorage = new StorageManager(path.join(root, "bob"));
  await Promise.all([aliceStorage.ensureDirectories(), bobStorage.ensureDirectories()]);
  let currentTime = Date.parse("2026-08-11T12:00:00.000Z");
  const now = () => new Date(currentTime);
  const resolveOwner = async (principal: string) => {
    if (principal === "owner:alice") return { principal, namespace: "alice", storage: aliceStorage };
    if (principal === "owner:bob") return { principal, namespace: "bob", storage: bobStorage };
    throw new Error("unknown test principal");
  };
  const cardService = new SupportPassportCardService({ resolveOwner, now });
  const grantStore = new SupportPassportGrantStore({ memoryDir: path.join(root, "shared"), now });
  const grantService = new SupportPassportGrantService({
    grantStore,
    resolveOwner,
    resolveNamespace: async (namespace) => {
      if (namespace === "alice") return aliceStorage;
      if (namespace === "bob") return bobStorage;
      throw new Error("unknown test namespace");
    },
    now,
  });

  return {
    root,
    aliceStorage,
    cardService,
    grantStore,
    grantService,
    now,
    advance: (milliseconds: number) => {
      currentTime += milliseconds;
    },
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createActiveCard(subject: Awaited<ReturnType<typeof makeSubject>>, title = "Quiet space") {
  const draft = await subject.cardService.createManualDraft({
    principal: "owner:alice",
    title,
    statement: "Offer me a quiet place and time.",
    category: "environment",
    reviewBy: "2026-09-01T12:00:00.000Z",
  });
  return await subject.cardService.approveCard({
    principal: "owner:alice",
    cardId: draft.cardId,
    expectedRevision: draft.revision,
  });
}

function expiryAfter(subject: Awaited<ReturnType<typeof makeSubject>>, milliseconds: number): string {
  return new Date(subject.now().getTime() + milliseconds).toISOString();
}

test("a grant stores only hashed credentials with private file permissions", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: "2026-08-11T13:00:00.123Z",
    });

    assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.grant.stateVersion, 1);
    assert.equal(created.grant.expiresAt, "2026-08-11T13:00:00.123Z");
    const filePath = path.join(
      subject.root,
      "shared",
      "state",
      "support-passport",
      "grants",
      `${created.grant.grantId}.json`
    );
    const body = await readFile(filePath, "utf8");
    assert.equal(body.includes(created.secret), false);
    assert.equal(JSON.parse(body).secretHash.length, 64);
    assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(filePath))).mode & 0o777, 0o700);
  } finally {
    await subject.cleanup();
  }
});

test("owner grant listings read only the indexed owner grants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-index-"));
  try {
    const grantIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000003",
      now: () => now,
    });
    const common = {
      namespace: "shared",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const alice = await store.create({ ...common, principal: "owner:alice" });
    const bob = await store.create({ ...common, principal: "owner:bob" });
    const inspected = store as unknown as {
      readState(grantId: string): Promise<unknown>;
    };
    const readState = inspected.readState.bind(store);
    const readGrantIds: string[] = [];
    inspected.readState = async (grantId) => {
      readGrantIds.push(grantId);
      return await readState(grantId);
    };

    const listed = await store.listForOwner("shared", "owner:alice");

    assert.deepEqual(
      listed.map((state) => state.grantId),
      [alice.state.grantId]
    );
    assert.deepEqual(readGrantIds, [alice.state.grantId]);
    assert.notEqual(alice.state.grantId, bob.state.grantId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner grant listings propagate indexed grant read failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-list-error-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const inspected = store as unknown as { readState(grantId: string): Promise<unknown> };
    inspected.readState = async (grantId) => {
      assert.equal(grantId, created.state.grantId);
      throw Object.assign(new Error("simulated grant read failure"), { code: "EIO" });
    };

    await assert.rejects(
      store.listForOwner("alice", "owner:alice"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner grant operations use one trimmed namespace and principal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-namespace-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const created = await store.create({
      namespace: " alice ",
      principal: " owner:alice ",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });

    assert.deepEqual(
      (await store.listForOwner(" alice ", "owner:alice")).map((state) => state.grantId),
      [created.state.grantId]
    );
    const revoked = await store.revoke({
      grantId: created.state.grantId,
      namespace: " alice ",
      principal: " owner:alice ",
      expectedStateVersion: created.state.stateVersion,
    });
    assert.ok(revoked.revokedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner grant history stays bounded while an inactive link frees capacity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-history-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    let nextGrantId = 1;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => `00000000-0000-4000-8000-${String(nextGrantId++).padStart(12, "0")}`,
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const first = await store.create(input);
    for (let index = 1; index < 100; index += 1) await store.create(input);

    await assert.rejects(
      store.create(input),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    await store.revoke({
      grantId: first.state.grantId,
      namespace: input.namespace,
      principal: input.principal,
      expectedStateVersion: first.state.stateVersion,
    });
    const firstGrantPath = path.join(root, "state", "support-passport", "grants", `${first.state.grantId}.json`);
    const inspected = store as unknown as {
      readState(grantId: string): Promise<unknown>;
      writeOwnerIndex(ownerHash: string, grantIds: string[]): Promise<void>;
    };
    const readState = inspected.readState.bind(store);
    const writeOwnerIndex = inspected.writeOwnerIndex.bind(store);
    inspected.writeOwnerIndex = async () => {
      throw Object.assign(new Error("simulated owner index write failure"), { code: "EIO" });
    };
    await assert.rejects(store.create(input), (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO");
    inspected.writeOwnerIndex = writeOwnerIndex;
    assert.equal((await lstat(firstGrantPath)).isFile(), true);
    assert.equal((await store.listForOwner(input.namespace, input.principal)).length, 100);

    inspected.readState = async (grantId) => {
      if (grantId === first.state.grantId) {
        throw Object.assign(new Error("simulated indexed grant read failure"), { code: "EIO" });
      }
      return await readState(grantId);
    };
    await assert.rejects(store.create(input), (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO");
    inspected.readState = readState;
    assert.equal((await store.listForOwner(input.namespace, input.principal)).length, 100);
    const replacement = await store.create(input);
    const listed = await store.listForOwner(input.namespace, input.principal);
    assert.equal(listed.length, 100);
    assert.equal(
      listed.some((state) => state.grantId === first.state.grantId),
      false
    );
    assert.equal(
      listed.some((state) => state.grantId === replacement.state.grantId),
      true
    );
    await assert.rejects(lstat(firstGrantPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner grant history uses one expiry cutoff while it prunes old links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-cutoff-"));
  try {
    const initialTime = Date.parse("2026-08-11T12:00:00.000Z");
    let currentTime = initialTime;
    let partitionCalls = 0;
    let crossExpiry = false;
    let nextGrantId = 1;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => `00000000-0000-4000-8000-${String(nextGrantId++).padStart(12, "0")}`,
      now: () => {
        partitionCalls += 1;
        return new Date(currentTime + (crossExpiry && partitionCalls > 101 ? 1 : 0));
      },
    });
    const common = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(initialTime + 3_600_000).toISOString(),
    };
    const first = await store.create(common);
    const second = await store.create(common);
    for (let index = 2; index < 99; index += 1) await store.create(common);
    await store.revoke({
      grantId: first.state.grantId,
      namespace: common.namespace,
      principal: common.principal,
    });
    await store.revoke({
      grantId: second.state.grantId,
      namespace: common.namespace,
      principal: common.principal,
    });
    currentTime = initialTime + 1_000;
    const crossing = await store.create({
      ...common,
      expiresAt: new Date(currentTime + 300_000).toISOString(),
    });
    currentTime = Date.parse(crossing.state.expiresAt) - 1;
    partitionCalls = 0;
    crossExpiry = true;

    const created = await store.create({
      ...common,
      expiresAt: new Date(currentTime + 3_600_000).toISOString(),
    });
    crossExpiry = false;
    const listed = await store.listForOwner(common.namespace, common.principal);

    assert.equal(listed.length, 100);
    assert.equal(new Set(listed.map((state) => state.grantId)).size, 100);
    assert.equal(listed.some((state) => state.grantId === crossing.state.grantId), true);
    assert.equal(listed.some((state) => state.grantId === created.state.grantId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant mutations report a storage conflict when the file lock is busy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-busy-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const rejectLock = (async (_lockPath, _options, task) =>
      await task(false, { refresh: async () => false, failure: "timeout" })) as typeof withHeldFileLock;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      now: () => now,
      withHeldFileLock: rejectLock,
    });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "storage_conflict" && error.status === 409
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation rechecks the owner lock immediately before commit", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const originalRead = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let replacedLock = false;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await originalRead(memoryId);
      if (!replacedLock) {
        replacedLock = true;
        const lockPath = path.join(subject.aliceStorage.dir, "state", "support-passport-cards.lock");
        await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      }
      return memory;
    };

    await assert.rejects(
      subject.grantService.createGrant({
        principal: "owner:alice",
        cards: [{ cardId: card.cardId, revision: card.revision }],
        expiresAt: expiryAfter(subject, 300_000),
      }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "storage_conflict" && error.status === 409
    );
    assert.deepEqual(await subject.grantService.listGrants({ principal: "owner:alice" }), []);
  } finally {
    await subject.cleanup();
  }
});

test("directory sync ignores only explicit unsupported errors", async () => {
  const failingOpen = (code: string) => async () => ({
    sync: async () => {
      throw Object.assign(new Error(`simulated ${code}`), { code });
    },
    close: async () => undefined,
  });

  await assert.rejects(
    syncDirectoryForDurability("/unused", failingOpen("EIO")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO"
  );
  await syncDirectoryForDurability("/unused", failingOpen("EINVAL"));
});

test("grant creation aborts before replacing an owner index after lock ownership is lost", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-lock-loss-"));
  try {
    const grantIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000003",
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const first = await store.create(input);
    let refreshes = 0;
    const inspected = store as unknown as {
      withMutationLock<T>(task: (lock: { refresh(): Promise<boolean> }) => Promise<T>): Promise<T>;
    };
    inspected.withMutationLock = async (task) =>
      await task({
        refresh: async () => {
          refreshes += 1;
          return refreshes === 1;
        },
      });

    await assert.rejects(
      store.create(input),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal(refreshes, 2);
    assert.deepEqual(
      (await store.listForOwner("alice", "owner:alice")).map((state) => state.grantId),
      [first.state.grantId]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a helper sees only the selected active card through a valid secret", async () => {
  const subject = await makeSubject();
  try {
    const selected = await createActiveCard(subject, "Selected card");
    await createActiveCard(subject, "Private card");
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: selected.cardId, revision: selected.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });

    const guide = await subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });
    assert.deepEqual(guide.cards, [
      {
        cardId: selected.cardId,
        title: "Selected card",
        statement: "Offer me a quiet place and time.",
        category: "environment",
        updatedAt: selected.updatedAt,
      },
    ]);
    const sharedCard = guide.cards[0];
    assert.ok(sharedCard);
    assert.equal("revision" in sharedCard, false);
    assert.equal("namespace" in guide, false);
  } finally {
    await subject.cleanup();
  }
});

test("grant creation and card withdrawal cannot interleave", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let pauseRead = true;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await getMemoryById(memoryId);
      if (pauseRead) {
        pauseRead = false;
        markReadStarted();
        await readReleased;
      }
      return memory;
    };

    const createPromise = subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    await readStarted;
    let withdrawalSettled = false;
    const withdrawalPromise = subject.cardService
      .withdrawCard({
        principal: "owner:alice",
        cardId: card.cardId,
        expectedRevision: card.revision,
      })
      .finally(() => {
        withdrawalSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(withdrawalSettled, false);

    releaseRead();
    const created = await createPromise;
    assert.equal(created.grant.status, "active");
    await withdrawalPromise;
    assert.equal(withdrawalSettled, true);
  } finally {
    await subject.cleanup();
  }
});

test("bad secrets return not found, while valid revoked and expired grants reveal safe lifecycle states", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 300_000),
    });

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: "x".repeat(43) }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "grant_not_found" && error.status === 404
    );

    await assert.rejects(
      subject.grantStore.revoke({
        namespace: "alice",
        principal: "owner:alice",
        grantId: created.grant.grantId,
        expectedStateVersion: created.grant.stateVersion + 1,
      }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "state_conflict" && error.status === 409
    );

    const peerStore = new SupportPassportGrantStore({ memoryDir: path.join(subject.root, "shared"), now: subject.now });
    const peerRevoked = await peerStore.revoke({
      namespace: "alice",
      principal: "owner:alice",
      grantId: created.grant.grantId,
      expectedStateVersion: created.grant.stateVersion,
    });
    const repeated = await subject.grantService.revokeGrant({
      principal: "owner:alice",
      grantId: created.grant.grantId,
      expectedStateVersion: created.grant.stateVersion,
    });
    assert.equal(peerRevoked.stateVersion, 2);
    assert.equal(repeated.stateVersion, peerRevoked.stateVersion);
    assert.equal(repeated.revokedAt, peerRevoked.revokedAt);
    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone" && error.status === 410
    );

    const second = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 300_000),
    });
    subject.advance(300_000);
    await assert.rejects(
      subject.grantService.readGrant({ grantId: second.grant.grantId, secret: second.secret }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "grant_expired" && error.status === 410
    );
  } finally {
    await subject.cleanup();
  }
});

test("a grant that expires during guide assembly does not return a guide", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 300_000),
    });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let advanced = false;
    subject.aliceStorage.getMemoryById = async (memoryId) => {
      const memory = await getMemoryById(memoryId);
      if (!advanced) {
        advanced = true;
        subject.advance(300_000);
      }
      return memory;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_expired"
    );
  } finally {
    await subject.cleanup();
  }
});

test("revocation wins while an optimistic helper card read is still pending", async () => {
  const subject = await makeSubject();
  const cardReadStarted = Promise.withResolvers<void>();
  const releaseCardRead = Promise.withResolvers<void>();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const peerStore = new SupportPassportGrantStore({ memoryDir: path.join(subject.root, "shared"), now: subject.now });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let paused = false;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await getMemoryById(memoryId);
      if (!paused) {
        paused = true;
        cardReadStarted.resolve();
        await releaseCardRead.promise;
      }
      return memory;
    };

    const readPromise = subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });
    await cardReadStarted.promise;
    const revokePromise = peerStore
      .revoke({
        namespace: "alice",
        principal: "owner:alice",
        grantId: created.grant.grantId,
        expectedStateVersion: created.grant.stateVersion,
      });
    await revokePromise;

    releaseCardRead.resolve();
    await assert.rejects(
      readPromise,
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone"
    );
  } finally {
    releaseCardRead.resolve();
    await subject.cleanup();
  }
});

test("helper reads for different grants do not block each other", async () => {
  const subject = await makeSubject();
  const releaseFirst = Promise.withResolvers<void>();
  try {
    const firstCard = await createActiveCard(subject, "First card");
    const secondCard = await createActiveCard(subject, "Second card");
    const first = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: firstCard.cardId, revision: firstCard.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const second = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: secondCard.cardId, revision: secondCard.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await getMemoryById(memoryId);
      if (memoryId === firstCard.cardId) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (memoryId === secondCard.cardId) secondStarted.resolve();
      return memory;
    };
    const firstRead = subject.grantService.readGrant({ grantId: first.grant.grantId, secret: first.secret });
    await firstStarted.promise;
    const secondRead = subject.grantService.readGrant({ grantId: second.grant.grantId, secret: second.secret });
    const observedConcurrentRead = await Promise.race([
      secondStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    releaseFirst.resolve();

    const [firstGuide, secondGuide] = await Promise.all([firstRead, secondRead]);
    assert.equal(observedConcurrentRead, true);
    assert.equal(firstGuide.cards[0]?.cardId, firstCard.cardId);
    assert.equal(secondGuide.cards[0]?.cardId, secondCard.cardId);
  } finally {
    releaseFirst.resolve();
    await subject.cleanup();
  }
});

test("helper guide snapshots read selected cards in parallel", async () => {
  const subject = await makeSubject();
  const pairedReads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  try {
    const firstCard = await createActiveCard(subject, "First card");
    const secondCard = await createActiveCard(subject, "Second card");
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [
        { cardId: firstCard.cardId, revision: firstCard.revision },
        { cardId: secondCard.cardId, revision: secondCard.revision },
      ],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let selectedReads = 0;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const selectedRead = selectedReads;
      selectedReads += 1;
      const pair = pairedReads[Math.floor(selectedRead / 2)];
      if (selectedRead % 2 === 1) pair?.resolve();
      else {
        const concurrent = await Promise.race([
          pair?.promise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        assert.equal(concurrent, true);
      }
      return await getMemoryById(memoryId);
    };

    const guide = await subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });

    assert.deepEqual(
      guide.cards.map((card) => card.cardId),
      [firstCard.cardId, secondCard.cardId]
    );
    assert.equal(selectedReads, 4);
  } finally {
    for (const pair of pairedReads) pair.resolve();
    await subject.cleanup();
  }
});

test("final helper guide assembly blocks card withdrawal", async () => {
  const subject = await makeSubject();
  const finalAuthenticationStarted = Promise.withResolvers<void>();
  const releaseFinalAuthentication = Promise.withResolvers<void>();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const authenticate = subject.grantStore.authenticate.bind(subject.grantStore);
    let authentications = 0;
    subject.grantStore.authenticate = async (grantId, secret) => {
      const state = await authenticate(grantId, secret);
      authentications += 1;
      if (authentications === 2) {
        finalAuthenticationStarted.resolve();
        await releaseFinalAuthentication.promise;
      }
      return state;
    };

    const readPromise = subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });
    await finalAuthenticationStarted.promise;
    let withdrawalSettled = false;
    const withdrawalPromise = subject.cardService
      .withdrawCard({
        principal: "owner:alice",
        cardId: card.cardId,
        expectedRevision: card.revision,
      })
      .finally(() => {
        withdrawalSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(withdrawalSettled, false);

    releaseFinalAuthentication.resolve();
    const guide = await readPromise;
    assert.equal(guide.cards[0]?.cardId, card.cardId);
    await withdrawalPromise;
    assert.equal(withdrawalSettled, true);
  } finally {
    releaseFinalAuthentication.resolve();
    await subject.cleanup();
  }
});

test("helper guide assembly fails when owner-lock ownership is lost", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const authenticate = subject.grantStore.authenticate.bind(subject.grantStore);
    let authentications = 0;
    subject.grantStore.authenticate = async (grantId, secret) => {
      const state = await authenticate(grantId, secret);
      authentications += 1;
      if (authentications === 2) {
        const lockPath = path.join(subject.aliceStorage.dir, "state", "support-passport-cards.lock");
        await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      }
      return state;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
  } finally {
    await subject.cleanup();
  }
});

test("helper guide assembly refreshes the owner lock after its final card read", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let reads = 0;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await getMemoryById(memoryId);
      reads += 1;
      if (reads === 2) {
        const lockPath = path.join(subject.aliceStorage.dir, "state", "support-passport-cards.lock");
        await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      }
      return memory;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal(reads, 2);
  } finally {
    await subject.cleanup();
  }
});

test("a changed card makes the whole grant stale without a partial guide", async () => {
  const subject = await makeSubject();
  try {
    const first = await createActiveCard(subject, "First card");
    const second = await createActiveCard(subject, "Second card");
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [
        { cardId: first.cardId, revision: first.revision },
        { cardId: second.cardId, revision: second.revision },
      ],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    await subject.cardService.withdrawCard({
      principal: "owner:alice",
      cardId: second.cardId,
      expectedRevision: second.revision,
    });

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale" && error.status === 410
    );
  } finally {
    await subject.cleanup();
  }
});

test("unrelated memory writes do not invalidate an unchanged shared guide", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let wroteUnrelated = false;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await getMemoryById(memoryId);
      if (!wroteUnrelated) {
        wroteUnrelated = true;
        await subject.aliceStorage.writeMemory("fact", "An unrelated memory write.", {
          source: "support-passport-test",
        });
      }
      return memory;
    };

    const guide = await subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });

    assert.equal(guide.cards[0]?.cardId, card.cardId);
  } finally {
    await subject.cleanup();
  }
});

test("grant creation rejects an approved card with an invalid update timestamp", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const memory = await subject.aliceStorage.getMemoryById(card.cardId);
    assert.ok(memory);
    assert.equal(
      await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(memory, {
        updated: "2026-08-11T12:00:00+99:99",
      }),
      true
    );
    const [invalidCard] = await subject.cardService.listCards({ principal: "owner:alice" });
    assert.ok(invalidCard);

    await assert.rejects(
      subject.grantService.createGrant({
        principal: "owner:alice",
        cards: [{ cardId: invalidCard.cardId, revision: invalidCard.revision }],
        expiresAt: expiryAfter(subject, 3_600_000),
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "card_data_invalid"
    );
    assert.deepEqual(await subject.grantService.listGrants({ principal: "owner:alice" }), []);
  } finally {
    await subject.cleanup();
  }
});

test("public guides compare card update timestamps as instants", async () => {
  const subject = await makeSubject();
  try {
    const first = await createActiveCard(subject, "Earlier card");
    const second = await createActiveCard(subject, "Later card");
    const firstMemory = await subject.aliceStorage.getMemoryById(first.cardId);
    const secondMemory = await subject.aliceStorage.getMemoryById(second.cardId);
    assert.ok(firstMemory);
    assert.ok(secondMemory);
    assert.equal(
      await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(firstMemory, {
        updated: "2026-08-11T12:00:00+05:00",
      }),
      true
    );
    assert.equal(
      await subject.aliceStorage.writeMemoryFrontmatterIfUnchanged(secondMemory, {
        updated: "2026-08-11T10:00:00Z",
      }),
      true
    );
    const cards = await subject.cardService.listCards({ principal: "owner:alice" });
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: cards.map((card) => ({ cardId: card.cardId, revision: card.revision })),
      expiresAt: expiryAfter(subject, 3_600_000),
    });

    const guide = await subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });

    assert.equal(guide.updatedAt, "2026-08-11T10:00:00Z");
  } finally {
    await subject.cleanup();
  }
});

test("grant creation rejects drafts, duplicate cards, and unsafe durations", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.cardService.createManualDraft({
      principal: "owner:alice",
      title: "Draft card",
      statement: "Give me time to answer.",
      category: "communication",
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const active = await createActiveCard(subject);

    for (const input of [
      { cards: [{ cardId: draft.cardId, revision: draft.revision }], expiresAt: expiryAfter(subject, 3_600_000) },
      {
        cards: [
          { cardId: active.cardId, revision: active.revision },
          { cardId: active.cardId, revision: active.revision },
        ],
        expiresAt: expiryAfter(subject, 3_600_000),
      },
      { cards: [{ cardId: active.cardId, revision: active.revision }], expiresAt: expiryAfter(subject, 299_999) },
      {
        cards: [{ cardId: active.cardId, revision: active.revision }],
        expiresAt: expiryAfter(subject, 604_800_001),
      },
      {
        cards: [{ cardId: active.cardId, revision: active.revision }],
        expiresAt: "2026-08-11T13:00:00+99:99",
      },
    ]) {
      await assert.rejects(
        subject.grantService.createGrant({ principal: "owner:alice", ...input }),
        (error: unknown) => error instanceof SupportPassportError
      );
    }
  } finally {
    await subject.cleanup();
  }
});

test("the grant store rejects a symlinked grant directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-link-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outside = path.join(root, "outside");
    await mkdir(path.join(memoryDir, "state", "support-passport"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(memoryDir, "state", "support-passport", "grants"));
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir, now: () => now });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      }),
      /must remain inside the memory directory/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private file operations fail closed without descriptor-relative directory paths", () => {
  assert.throws(
    () => requirePrivateFileDescriptorRoot("win32", "private file directory cannot be pinned"),
    /private file directory cannot be pinned/
  );
  assert.equal(requirePrivateFileDescriptorRoot("linux", "unreachable"), "/proc/self/fd");
  assert.equal(requirePrivateFileDescriptorRoot("darwin", "unreachable"), "/dev/fd");
});

test("grant cleanup never follows a swapped grant directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-cleanup-swap-"));
  try {
    const grantId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantId,
      now: () => now,
    });
    await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const grantsDir = path.join(root, "state", "support-passport", "grants");
    const parkedDir = path.join(root, "parked-grants");
    const outsideDir = path.join(root, "outside");
    const fileName = `${grantId}.json`;
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, fileName), "outside must remain", { mode: 0o600 });
    renameSync(grantsDir, parkedDir);
    symlinkSync(outsideDir, grantsDir, "dir");
    const inspected = store as unknown as {
      removeGrantStates(grantIds: string[]): Promise<void>;
    };

    await assert.rejects(inspected.removeGrantStates([grantId]), /regular files in a stable directory/);
    assert.equal(await readFile(path.join(outsideDir, fileName), "utf8"), "outside must remain");
    assert.equal((await lstat(path.join(parkedDir, fileName))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant writes reject a directory swapped after the initial safety check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-swap-"));
  try {
    const memoryDir = path.join(root, "memory");
    const outside = path.join(root, "outside");
    const grantsDir = path.join(memoryDir, "state", "support-passport", "grants");
    const parkedDir = path.join(root, "parked-grants");
    await mkdir(outside, { recursive: true });
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir,
      now: () => now,
    });

    await assert.rejects(
      store.create(
        {
          namespace: "alice",
          principal: "owner:alice",
          cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
          expiresAt: new Date(now.getTime() + 300_000).toISOString(),
        },
        async () => {
          renameSync(grantsDir, parkedDir);
          symlinkSync(outside, grantsDir, "dir");
        }
      ),
      /regular files in a stable directory/
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant writes reject an ancestor swapped after the initial safety check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-ancestor-swap-"));
  try {
    const memoryDir = path.join(root, "memory");
    const passportDir = path.join(memoryDir, "state", "support-passport");
    const parkedDir = path.join(root, "parked-support-passport");
    const outside = path.join(root, "outside-support-passport");
    await mkdir(path.join(outside, "grants", "owners"), { recursive: true });
    const acceptLock = (async (_lockPath, _options, task) =>
      await task(true, { refresh: async () => true })) as typeof withHeldFileLock;
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir,
      now: () => now,
      withHeldFileLock: acceptLock,
    });
    const inspected = store as unknown as { addToOwnerIndex(): Promise<void> };
    inspected.addToOwnerIndex = async () => undefined;

    await assert.rejects(
      store.create(
        {
          namespace: "alice",
          principal: "owner:alice",
          cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
          expiresAt: new Date(now.getTime() + 300_000).toISOString(),
        },
        async () => {
          renameSync(passportDir, parkedDir);
          symlinkSync(outside, passportDir, "dir");
        }
      ),
      /regular files in a stable directory/
    );
    assert.deepEqual(await readdir(path.join(outside, "grants")), ["owners"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store fails closed for corrupt and symlinked grant files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-state-"));
  try {
    const firstGrantId = "00000000-0000-4000-8000-000000000001";
    const secondGrantId = "00000000-0000-4000-8000-000000000002";
    const grantIds = [firstGrantId, secondGrantId];
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? secondGrantId,
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const corrupt = await store.create(input);
    const grantDir = path.join(root, "state", "support-passport", "grants");
    const corruptPath = path.join(grantDir, `${firstGrantId}.json`);
    await writeFile(corruptPath, "{", { mode: 0o600 });
    await assert.rejects(store.authenticate(firstGrantId, corrupt.secret));

    const linked = await store.create(input);
    const linkedPath = path.join(grantDir, `${secondGrantId}.json`);
    const outsidePath = path.join(root, "outside.json");
    await writeFile(outsidePath, await readFile(linkedPath), { mode: 0o600 });
    await rm(linkedPath);
    await symlink(outsidePath, linkedPath);
    await assert.rejects(store.authenticate(secondGrantId, linked.secret), /must be regular files/);
    await assert.rejects(store.listForOwner("alice", "owner:alice"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store rejects a state file whose grant ID does not match its file name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-identity-"));
  try {
    const firstGrantId = "00000000-0000-4000-8000-000000000001";
    const secondGrantId = "00000000-0000-4000-8000-000000000002";
    const grantIds = [firstGrantId, secondGrantId];
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? secondGrantId,
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const first = await store.create(input);
    const second = await store.create(input);
    const grantDir = path.join(root, "state", "support-passport", "grants");
    await writeFile(
      path.join(grantDir, `${secondGrantId}.json`),
      await readFile(path.join(grantDir, `${firstGrantId}.json`)),
      { mode: 0o600 }
    );

    await assert.rejects(store.authenticate(secondGrantId, second.secret), /grant ID must match its file name/);
    await assert.rejects(
      store.listForOwner("alice", "owner:alice"),
      /grant ID must match its file name/
    );
    assert.equal(first.state.grantId, firstGrantId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store rejects unsafe durations and grant ID collisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-collision-"));
  try {
    const grantId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, makeGrantId: () => grantId, now: () => now });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    };
    await store.create(input);
    await assert.rejects(
      store.create(input),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    await assert.rejects(
      store.create({ ...input, expiresAt: new Date(now.getTime() + 299_999).toISOString() }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store expands a leading tilde in its memory directory", () => {
  const store = new SupportPassportGrantStore({ memoryDir: "~/support-passport-path-test" });
  const memoryDir = (store as unknown as { memoryDir: string }).memoryDir;
  assert.equal(memoryDir.includes(`${path.sep}~${path.sep}`), false);
  assert.equal(path.basename(memoryDir), "support-passport-path-test");
  assert.equal(path.isAbsolute(memoryDir), true);
});
