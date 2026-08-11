import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore } from "./grant-store.js";

async function makeSubject() {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grants-"));
  const aliceStorage = new StorageManager(path.join(root, "alice"));
  const bobStorage = new StorageManager(path.join(root, "bob"));
  await Promise.all([aliceStorage.ensureDirectories(), bobStorage.ensureDirectories()]);
  let currentTime = Date.parse("2026-08-11T12:00:00.000Z");
  const now = () => new Date(currentTime);
  const resolveOwner = async (principal: string) => {
    if (principal === "owner:alice") return { namespace: "alice", storage: aliceStorage };
    if (principal === "owner:bob") return { namespace: "bob", storage: bobStorage };
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

    assert.deepEqual(listed.map((state) => state.grantId), [alice.state.grantId]);
    assert.deepEqual(readGrantIds, [alice.state.grantId]);
    assert.notEqual(alice.state.grantId, bob.state.grantId);
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

test("a revoke during a helper read never returns the old guide", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const peerStore = new SupportPassportGrantStore({ memoryDir: path.join(subject.root, "shared"), now: subject.now });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let revoked = false;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      if (!revoked) {
        revoked = true;
        await peerStore.revoke({
          namespace: "alice",
          principal: "owner:alice",
          grantId: created.grant.grantId,
          expectedStateVersion: created.grant.stateVersion,
        });
      }
      return await getMemoryById(memoryId);
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone"
    );
  } finally {
    await subject.cleanup();
  }
});

test("a revoke during the confirmed card read never returns the old guide", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const peerStore = new SupportPassportGrantStore({ memoryDir: path.join(subject.root, "shared"), now: subject.now });
    const getMemoryById = subject.aliceStorage.getMemoryById.bind(subject.aliceStorage);
    let reads = 0;
    subject.aliceStorage.getMemoryById = async (memoryId: string) => {
      const memory = await getMemoryById(memoryId);
      reads += 1;
      if (reads === 2) {
        await peerStore.revoke({
          namespace: "alice",
          principal: "owner:alice",
          grantId: created.grant.grantId,
          expectedStateVersion: created.grant.stateVersion,
        });
      }
      return memory;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone"
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

test("a card changed while a helper guide is assembled never returns the old guide", async () => {
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
      if (reads === 1) {
        await subject.cardService.withdrawCard({
          principal: "owner:alice",
          cardId: card.cardId,
          expectedRevision: card.revision,
        });
      }
      return memory;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale"
    );
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
      /must not be a symbolic link/
    );
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
    assert.deepEqual(await store.listForOwner("alice", "owner:alice"), []);
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
    assert.deepEqual(
      (await store.listForOwner("alice", "owner:alice")).map((state) => state.grantId),
      [first.state.grantId]
    );
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
