import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
    cardService,
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
  });
  return await subject.cardService.approveCard({
    principal: "owner:alice",
    cardId: draft.cardId,
    expectedRevision: draft.revision,
  });
}

test("a grant stores only hashed credentials with private file permissions", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      durationSeconds: 3_600,
    });

    assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.grant.stateVersion, 1);
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

test("a helper sees only the selected active card through a valid secret", async () => {
  const subject = await makeSubject();
  try {
    const selected = await createActiveCard(subject, "Selected card");
    await createActiveCard(subject, "Private card");
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: selected.cardId, revision: selected.revision }],
      durationSeconds: 3_600,
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

test("bad secrets return not found, while valid revoked or expired grants return gone", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      durationSeconds: 300,
    });

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: "x".repeat(43) }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "grant_not_found" && error.status === 404
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
      durationSeconds: 300,
    });
    subject.advance(300_001);
    await assert.rejects(
      subject.grantService.readGrant({ grantId: second.grant.grantId, secret: second.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_gone"
    );
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
      durationSeconds: 3_600,
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

test("grant creation rejects drafts, duplicate cards, and unsafe durations", async () => {
  const subject = await makeSubject();
  try {
    const draft = await subject.cardService.createManualDraft({
      principal: "owner:alice",
      title: "Draft card",
      statement: "Give me time to answer.",
      category: "communication",
    });
    const active = await createActiveCard(subject);

    for (const input of [
      { cards: [{ cardId: draft.cardId, revision: draft.revision }], durationSeconds: 3_600 },
      {
        cards: [
          { cardId: active.cardId, revision: active.revision },
          { cardId: active.cardId, revision: active.revision },
        ],
        durationSeconds: 3_600,
      },
      { cards: [{ cardId: active.cardId, revision: active.revision }], durationSeconds: 299 },
      { cards: [{ cardId: active.cardId, revision: active.revision }], durationSeconds: 604_801 },
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
    const store = new SupportPassportGrantStore({ memoryDir });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        durationSeconds: 300,
      }),
      /must not be a symbolic link/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store rejects unsafe durations and grant ID collisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-collision-"));
  try {
    const grantId = "00000000-0000-4000-8000-000000000001";
    const store = new SupportPassportGrantStore({ memoryDir: root, makeGrantId: () => grantId });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      durationSeconds: 300,
    };
    await store.create(input);
    await assert.rejects(
      store.create(input),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    await assert.rejects(
      store.create({ ...input, durationSeconds: 299 }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
