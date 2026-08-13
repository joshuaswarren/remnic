import assert from "node:assert/strict";
import { renameSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import type { withHeldFileLock } from "../utils/serialize-mutations.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { computeSupportPassportOwnerLockKey, supportPassportOwnerLockPath } from "./owner-lock.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore, syncDirectoryForDurability } from "./grant-store.js";
import {
  ensurePrivateDirectoryNoFollow,
  ensurePrivateDirectoryTreeNoFollow,
  readPrivateFileNoFollow,
  removePrivateFilesNoFollow,
  requirePrivateFileDescriptorRoot,
  writePrivateFileAtomicallyNoFollow,
} from "./private-file.js";

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
    const state = JSON.parse(body);
    assert.equal(body.includes(created.secret), false);
    assert.equal(body.includes("owner:alice"), false);
    assert.equal(state.secretHash.length, 64);
    assert.equal(state.ownerLockKey, computeSupportPassportOwnerLockKey("alice", "owner:alice"));
    assert.equal(
      supportPassportOwnerLockPath(subject.aliceStorage, { namespace: "alice", principal: "owner:alice" }),
      supportPassportOwnerLockPath(subject.aliceStorage, { namespace: "alice", ownerKey: state.ownerLockKey })
    );
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

test("owner grant listings put active links before inactive history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-list-order-"));
  try {
    let currentTime = Date.parse("2026-08-11T12:00:00.000Z");
    let nextGrantId = 1;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => `00000000-0000-4000-8000-${String(nextGrantId++).padStart(12, "0")}`,
      now: () => new Date(currentTime),
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(currentTime + 3_600_000).toISOString(),
    };
    const inactive = await store.create(input);
    currentTime += 1_000;
    const active = await store.create({ ...input, expiresAt: new Date(currentTime + 3_600_000).toISOString() });
    await store.revoke({
      grantId: inactive.state.grantId,
      namespace: input.namespace,
      principal: input.principal,
    });

    const listed = await store.listForOwner(input.namespace, input.principal);

    assert.deepEqual(
      listed.map((state) => state.grantId),
      [active.state.grantId, inactive.state.grantId]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner grant operations reject a noncanonical namespace and trim the principal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-namespace-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    await assert.rejects(
      store.create({
        namespace: " alice ",
        principal: " owner:alice ",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    const created = await store.create({
      namespace: "alice",
      principal: " owner:alice ",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });

    assert.deepEqual(
      (await store.listForOwner("alice", "owner:alice")).map((state) => state.grantId),
      [created.state.grantId]
    );
    const revoked = await store.revoke({
      grantId: created.state.grantId,
      namespace: "alice",
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
    const evictedGrantLocks: string[] = [];
    const lockAwareStore = store as unknown as {
      withGrantLock<T>(grantId: string, task: (lock: { refresh(): Promise<boolean> }) => Promise<T>): Promise<T>;
    };
    const withGrantLock = lockAwareStore.withGrantLock.bind(store);
    lockAwareStore.withGrantLock = async (grantId, task) => {
      evictedGrantLocks.push(grantId);
      return await withGrantLock(grantId, task);
    };
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
    assert.deepEqual(evictedGrantLocks, [first.state.grantId]);
    await assert.rejects(lstat(firstGrantPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation accepts a state write that committed before its durability error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-state-commit-"));
  try {
    const grantId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const directorySyncs: string[] = [];
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantId,
      now: () => now,
      syncDirectory: async (directory) => {
        directorySyncs.push(directory);
        await syncDirectoryForDurability(directory);
      },
    });
    const inspected = store as unknown as {
      writeState(state: unknown, requireAbsent: boolean): Promise<void>;
    };
    const writeState = inspected.writeState.bind(store);
    inspected.writeState = async (state, requireAbsent) => {
      await writeState(state, requireAbsent);
      throw Object.assign(new Error("simulated post-commit state error"), { code: "EIO" });
    };

    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });

    assert.equal(created.state.grantId, grantId);
    assert.deepEqual(
      (await store.listForOwner("alice", "owner:alice")).map((state) => state.grantId),
      [grantId]
    );
    assert.deepEqual(directorySyncs.map((directory) => path.basename(directory)), ["grants"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation fails closed when a committed state cannot be re-synced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-state-sync-"));
  try {
    const grantId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantId,
      now: () => now,
      syncDirectory: async () => {
        throw Object.assign(new Error("simulated directory sync failure"), { code: "EIO" });
      },
    });
    const inspected = store as unknown as {
      writeState(state: unknown, requireAbsent: boolean): Promise<void>;
    };
    const writeState = inspected.writeState.bind(store);
    inspected.writeState = async (state, requireAbsent) => {
      await writeState(state, requireAbsent);
      throw Object.assign(new Error("simulated post-commit state error"), { code: "EIO" });
    };

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO"
    );
    await assert.rejects(
      lstat(path.join(root, "state", "support-passport", "grants", `${grantId}.json`)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation re-syncs an owner index write that committed before its durability error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-index-commit-"));
  try {
    const grantId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, makeGrantId: () => grantId, now: () => now });
    const inspected = store as unknown as {
      writeOwnerIndex(ownerHash: string, grantIds: string[]): Promise<void>;
    };
    const writeOwnerIndex = inspected.writeOwnerIndex.bind(store);
    inspected.writeOwnerIndex = async (ownerHash, grantIds) => {
      await writeOwnerIndex(ownerHash, grantIds);
      throw Object.assign(new Error("simulated post-commit index error"), { code: "EIO" });
    };

    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });

    assert.equal(created.state.grantId, grantId);
    assert.deepEqual(
      (await store.listForOwner("alice", "owner:alice")).map((state) => state.grantId),
      [grantId]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant revocation retries directory durability before reporting an existing revoked state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-revoke-sync-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    let syncAttempts = 0;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      now: () => now,
      syncDirectory: async (directory) => {
        syncAttempts += 1;
        if (syncAttempts === 1) {
          throw Object.assign(new Error("simulated directory sync failure"), { code: "EIO" });
        }
        await syncDirectoryForDurability(directory);
      },
    });
    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const inspected = store as unknown as {
      writeState(state: { revokedAt?: string }, requireAbsent?: boolean): Promise<void>;
    };
    const writeState = inspected.writeState.bind(store);
    inspected.writeState = async (state, requireAbsent) => {
      await writeState(state, requireAbsent);
      if (state.revokedAt) {
        throw Object.assign(new Error("simulated post-commit state error"), { code: "EIO" });
      }
    };
    const request = {
      grantId: created.state.grantId,
      namespace: "alice",
      principal: "owner:alice",
    };

    await assert.rejects(store.revoke(request), (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO");
    const repeated = await store.revoke(request);

    assert.ok(repeated.revokedAt);
    assert.equal(repeated.stateVersion, 2);
    assert.equal(syncAttempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner grant rollover rejects a foreign grant without deleting it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-foreign-index-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    let nextGrantId = 1;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => `00000000-0000-4000-8000-${String(nextGrantId++).padStart(12, "0")}`,
      now: () => now,
    });
    const common = {
      namespace: "shared",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const aliceGrants = [];
    for (let index = 0; index < 99; index += 1) {
      aliceGrants.push(await store.create({ ...common, principal: "owner:alice" }));
    }
    const bob = await store.create({ ...common, principal: "owner:bob" });
    await store.revoke({
      grantId: bob.state.grantId,
      namespace: common.namespace,
      principal: "owner:bob",
    });
    const inspected = store as unknown as {
      ownerHash(namespace: string, principalHash: string): string;
      writeOwnerIndex(ownerHash: string, grantIds: string[]): Promise<void>;
    };
    const firstAliceGrant = aliceGrants[0];
    assert.ok(firstAliceGrant);
    const aliceOwnerHash = inspected.ownerHash(common.namespace, firstAliceGrant.state.principalHash);
    await inspected.writeOwnerIndex(aliceOwnerHash, [
      ...aliceGrants.map((grant) => grant.state.grantId),
      bob.state.grantId,
    ]);
    const bobGrantPath = path.join(root, "state", "support-passport", "grants", `${bob.state.grantId}.json`);

    await assert.rejects(
      store.create({ ...common, principal: "owner:alice" }),
      /owner index references a foreign grant/
    );
    assert.equal((await lstat(bobGrantPath)).isFile(), true);
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
    assert.equal(
      listed.some((state) => state.grantId === crossing.state.grantId),
      true
    );
    assert.equal(
      listed.some((state) => state.grantId === created.state.grantId),
      true
    );
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
    const originalRead = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let replacedLock = false;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await originalRead(...args);
      if (!replacedLock) {
        replacedLock = true;
        const lockPath = supportPassportOwnerLockPath(subject.aliceStorage, {
          namespace: "alice",
          principal: "owner:alice",
        });
        await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      }
      return memories;
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

test("grant creation revokes its committed link when the owner lock is lost after storage", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const create = subject.grantStore.create.bind(subject.grantStore);
    let committedGrantId = "";
    subject.grantStore.create = async (...args) => {
      const created = await create(...args);
      committedGrantId = created.state.grantId;
      const lockPath = supportPassportOwnerLockPath(subject.aliceStorage, {
        namespace: "alice",
        principal: "owner:alice",
      });
      await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      return created;
    };

    await assert.rejects(
      subject.grantService.createGrant({
        principal: "owner:alice",
        cards: [{ cardId: card.cardId, revision: card.revision }],
        expiresAt: expiryAfter(subject, 3_600_000),
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.ok(committedGrantId);
    const [stored] = await subject.grantStore.listForOwner("alice", "owner:alice");
    assert.equal(stored?.grantId, committedGrantId);
    assert.ok(stored?.revokedAt);
  } finally {
    await subject.cleanup();
  }
});

test("grant creation measures its minimum lifetime from request receipt", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const expiresAt = expiryAfter(subject, 300_000);
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let delayed = false;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await readAllMemories(...args);
      if (!delayed) {
        delayed = true;
        subject.advance(1_000);
      }
      return memories;
    };

    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt,
    });

    assert.equal(created.grant.expiresAt, expiresAt);
    assert.equal(created.grant.status, "active");
  } finally {
    await subject.cleanup();
  }
});

test("grant creation maps a clock jump past expiry to invalid input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-clock-jump-"));
  try {
    const requestedAt = new Date("2026-08-11T12:00:00.000Z");
    let nowCalls = 0;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      now: () => {
        nowCalls += 1;
        return new Date(requestedAt.getTime() + (nowCalls > 1 ? 600_000 : 0));
      },
    });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(requestedAt.getTime() + 300_000).toISOString(),
      }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "invalid_input" && error.status === 400
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation rejects a future request time that would extend the maximum lifetime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-future-request-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const requestedAt = new Date("2027-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(requestedAt.getTime() + 300_000).toISOString(),
        requestedAt,
      }),
      (error: unknown) =>
        error instanceof SupportPassportError && error.code === "invalid_input" && error.status === 400,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("grant creation reconciles peer state when the owner-index lock is lost after write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-index-fence-"));
  try {
    const grantIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const peerGrantId = "00000000-0000-4000-8000-000000000003";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000004",
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const first = await store.create(input);
    const peerState = {
      ...first.state,
      grantId: peerGrantId,
      secretHash: "b".repeat(64),
    };
    const inspected = store as unknown as {
      withOwnerIndexLock<T>(
        ownerHash: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      writeOwnerIndex(ownerHash: string, grantIds: string[]): Promise<void>;
      writeState(state: typeof peerState, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof peerState): Promise<void>;
    };
    const writeOwnerIndex = inspected.writeOwnerIndex.bind(store);
    let ownerIndexWrites = 0;
    inspected.writeOwnerIndex = async (ownerHash, indexedGrantIds) => {
      ownerIndexWrites += 1;
      if (ownerIndexWrites === 2) {
        await inspected.writeState(peerState, true);
        await inspected.writeOwnerMembership(peerState);
        await writeOwnerIndex(ownerHash, [...indexedGrantIds, peerGrantId]);
      }
      await writeOwnerIndex(ownerHash, indexedGrantIds);
    };
    let ownerLockRun = 0;
    const refreshesByRun = new Map<number, number>();
    inspected.withOwnerIndexLock = async (_ownerHash, task) => {
      ownerLockRun += 1;
      return await task({
        refresh: async () => {
          const refreshes = (refreshesByRun.get(ownerLockRun) ?? 0) + 1;
          refreshesByRun.set(ownerLockRun, refreshes);
          return ownerLockRun > 2 || refreshes !== 2;
        },
      });
    };

    const created = await store.create(input);
    const listedIds = new Set((await store.listForOwner(input.namespace, input.principal)).map(
      (state) => state.grantId,
    ));

    assert.equal(ownerLockRun, 3);
    assert.equal(refreshesByRun.get(1), 2);
    assert.equal(refreshesByRun.get(2), 2);
    assert.deepEqual(listedIds, new Set([first.state.grantId, created.state.grantId, peerGrantId]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant recovery propagates transient reads from an owner membership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-recovery-read-"));
  try {
    const grantIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const peerGrantId = "00000000-0000-4000-8000-000000000003";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000004",
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const first = await store.create(input);
    const peerState = {
      ...first.state,
      grantId: peerGrantId,
      secretHash: "b".repeat(64),
    };
    const inspected = store as unknown as {
      withOwnerIndexLock<T>(
        ownerHash: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      writeOwnerIndex(ownerHash: string, indexedGrantIds: string[]): Promise<void>;
      writeState(state: typeof peerState, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof peerState): Promise<void>;
      readState(grantId: string): Promise<typeof peerState>;
    };
    const writeOwnerIndex = inspected.writeOwnerIndex.bind(store);
    let injectPeer = true;
    inspected.writeOwnerIndex = async (ownerHash, indexedGrantIds) => {
      if (injectPeer) {
        injectPeer = false;
        await inspected.writeState(peerState, true);
        await inspected.writeOwnerMembership(peerState);
      }
      await writeOwnerIndex(ownerHash, indexedGrantIds);
    };
    let ownerLockRun = 0;
    let firstRunRefreshes = 0;
    inspected.withOwnerIndexLock = async (_ownerHash, task) => {
      ownerLockRun += 1;
      return await task({
        refresh: async () => {
          if (ownerLockRun !== 1) return true;
          firstRunRefreshes += 1;
          return firstRunRefreshes !== 2;
        },
      });
    };
    const readState = inspected.readState.bind(store);
    inspected.readState = async (grantId) => {
      if (ownerLockRun > 1 && grantId === peerGrantId) {
        throw Object.assign(new Error("simulated transient owner read"), { code: "EIO" });
      }
      return await readState(grantId);
    };

    await assert.rejects(
      store.create(input),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO",
    );
    assert.equal(ownerLockRun, 2);
    assert.equal(
      JSON.parse(await readFile(path.join(root, "state", "support-passport", "grants", `${peerGrantId}.json`), "utf8")).grantId,
      peerGrantId,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant recovery prunes a stale owner-index entry after lock loss", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-stale-index-recovery-"));
  try {
    const grantIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
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
    const inspected = store as unknown as {
      withOwnerIndexLock<T>(
        ownerHash: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      writeOwnerIndex(ownerHash: string, indexedGrantIds: string[]): Promise<void>;
    };
    const writeOwnerIndex = inspected.writeOwnerIndex.bind(store);
    let removeStaleState = true;
    inspected.writeOwnerIndex = async (ownerHash, indexedGrantIds) => {
      await writeOwnerIndex(ownerHash, indexedGrantIds);
      if (!removeStaleState) return;
      removeStaleState = false;
      await rm(path.join(root, "state", "support-passport", "grants", `${first.state.grantId}.json`));
    };
    let ownerLockRun = 0;
    let firstRunRefreshes = 0;
    inspected.withOwnerIndexLock = async (_ownerHash, task) => {
      ownerLockRun += 1;
      return await task({
        refresh: async () => {
          if (ownerLockRun !== 1) return true;
          firstRunRefreshes += 1;
          return firstRunRefreshes !== 2;
        },
      });
    };

    const created = await store.create(input);

    assert.equal(ownerLockRun, 2);
    assert.equal(firstRunRefreshes, 2);
    assert.deepEqual(
      (await store.listForOwner(input.namespace, input.principal)).map((state) => state.grantId),
      [created.state.grantId],
    );
    assert.equal((await store.authenticate(created.state.grantId, created.secret)).grantId, created.state.grantId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant recovery ignores malformed unindexed grant files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-scoped-recovery-"));
  try {
    const grantIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const unindexedGrantId = "00000000-0000-4000-8000-000000000003";
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000004",
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const first = await store.create(input);
    const grantsDir = path.join(root, "state", "support-passport", "grants");
    await writeFile(path.join(grantsDir, `${unindexedGrantId}.json`), "not valid JSON", {
      mode: 0o600,
    });
    let ownerLockRun = 0;
    let firstRunRefreshes = 0;
    const inspected = store as unknown as {
      withOwnerIndexLock<T>(
        ownerHash: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      ownerHash(namespace: string, principalHash: string): string;
    };
    const ownerHash = inspected.ownerHash(first.state.namespace, first.state.principalHash);
    await writeFile(
      path.join(grantsDir, "owners", ownerHash, `${unindexedGrantId}.json`),
      `${JSON.stringify({ schemaVersion: 1, grantId: unindexedGrantId })}\n`,
      { mode: 0o600 },
    );
    inspected.withOwnerIndexLock = async (_ownerHash, task) => {
      ownerLockRun += 1;
      return await task({
        refresh: async () => {
          if (ownerLockRun !== 1) return true;
          firstRunRefreshes += 1;
          return firstRunRefreshes !== 2;
        },
      });
    };

    const created = await store.create(input);

    assert.equal(ownerLockRun, 2);
    assert.deepEqual(
      new Set((await store.listForOwner(input.namespace, input.principal)).map((state) => state.grantId)),
      new Set([first.state.grantId, created.state.grantId]),
    );
    assert.equal(await readFile(path.join(grantsDir, `${unindexedGrantId}.json`), "utf8"), "not valid JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant recovery reads only the affected owner's membership after lock loss", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-owner-scoped-recovery-"));
  try {
    const grantIds = Array.from({ length: 8 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000099",
      now: () => now,
    });
    const input = {
      namespace: "shared",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    await store.create({ ...input, principal: "owner:alice" });
    const bobGrantIds = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      bobGrantIds.add((await store.create({ ...input, principal: "owner:bob" })).state.grantId);
    }
    const inspected = store as unknown as {
      withOwnerIndexLock<T>(
        ownerHash: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      readState(grantId: string): Promise<{ grantId: string }>;
    };
    let ownerLockRun = 0;
    let firstRunRefreshes = 0;
    inspected.withOwnerIndexLock = async (_ownerHash, task) => {
      ownerLockRun += 1;
      return await task({
        refresh: async () => {
          if (ownerLockRun !== 1) return true;
          firstRunRefreshes += 1;
          return firstRunRefreshes !== 2;
        },
      });
    };
    const readState = inspected.readState.bind(store);
    const recoveryReads: string[] = [];
    inspected.readState = async (grantId) => {
      if (ownerLockRun === 2) recoveryReads.push(grantId);
      return await readState(grantId);
    };

    await store.create({ ...input, principal: "owner:alice" });

    assert.equal(ownerLockRun, 2);
    assert.equal(recoveryReads.some((grantId) => bobGrantIds.has(grantId)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one owner's index transaction does not block another owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-owner-concurrency-"));
  const releaseAlice = Promise.withResolvers<void>();
  try {
    const grantIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantIds.shift() ?? "00000000-0000-4000-8000-000000000003",
      now: () => now,
    });
    const inspected = store as unknown as {
      withOwnerIndexLock<T>(
        ownerHash: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
    };
    const withOwnerIndexLock = inspected.withOwnerIndexLock.bind(store);
    const aliceEntered = Promise.withResolvers<void>();
    let blockedOwnerHash: string | undefined;
    inspected.withOwnerIndexLock = async (ownerHash, task) => {
      if (!blockedOwnerHash) {
        blockedOwnerHash = ownerHash;
        return await withOwnerIndexLock(ownerHash, async (lock) => {
          aliceEntered.resolve();
          await releaseAlice.promise;
          return await task(lock);
        });
      }
      return await withOwnerIndexLock(ownerHash, task);
    };
    const input = {
      namespace: "shared",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const alice = store.create({ ...input, principal: "owner:alice" });
    await aliceEntered.promise;
    const bob = await Promise.race([
      store.create({ ...input, principal: "owner:bob" }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("another owner was blocked by Alice's index lock")), 1_000),
      ),
    ]);
    assert.equal(bob.state.namespace, "shared");
    releaseAlice.resolve();
    await alice;
  } finally {
    releaseAlice.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation rechecks its mutation lock after the commit callback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-callback-lock-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
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
      store.create(
        {
          namespace: "alice",
          principal: "owner:alice",
          cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
          expiresAt: new Date(now.getTime() + 300_000).toISOString(),
        },
        async () => undefined
      ),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal(refreshes, 2);
    await assert.rejects(
      lstat(path.join(root, "state", "support-passport", "grants")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant revocation rechecks its mutation lock after the commit callback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-revoke-callback-lock-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    });
    let refreshes = 0;
    const inspected = store as unknown as {
      withGrantLock<T>(grantId: string, task: (lock: { refresh(): Promise<boolean> }) => Promise<T>): Promise<T>;
    };
    inspected.withGrantLock = async (_grantId, task) =>
      await task({
        refresh: async () => {
          refreshes += 1;
          return refreshes === 1;
        },
      });

    await assert.rejects(
      store.revoke(
        { grantId: created.state.grantId, namespace: "alice", principal: "owner:alice" },
        async () => undefined
      ),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal(refreshes, 2);
    assert.equal((await store.authenticate(created.state.grantId, created.secret)).revokedAt, undefined);
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

test("grants reject cards owned by another namespace in shared storage", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-card-scope-"));
  try {
    const storage = new StorageManager(path.join(root, "shared-storage"));
    await storage.ensureDirectories();
    const now = () => new Date("2026-08-11T12:00:00.000Z");
    const resolveOwner = async (principal: string) => ({
      principal,
      namespace: principal === "owner:alice" ? "alice" : "bob",
      storage,
    });
    const cardService = new SupportPassportCardService({ resolveOwner, now });
    const grantStore = new SupportPassportGrantStore({ memoryDir: path.join(root, "grants"), now });
    const grantService = new SupportPassportGrantService({
      grantStore,
      resolveOwner,
      resolveNamespace: async () => storage,
      now,
    });
    const draft = await cardService.createManualDraft({
      principal: "owner:alice",
      title: "Alice card",
      statement: "Offer me a quiet place.",
      category: "environment",
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const aliceCard = await cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });

    await assert.rejects(
      grantService.createGrant({
        principal: "owner:bob",
        cards: [{ cardId: aliceCard.cardId, revision: aliceCard.revision }],
        expiresAt: "2026-08-11T13:00:00.000Z",
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_card_status"
    );
    const forged = await grantStore.create({
      namespace: "bob",
      principal: "owner:bob",
      cards: [{ cardId: aliceCard.cardId, revision: aliceCard.revision }],
      expiresAt: "2026-08-11T13:00:00.000Z",
    });
    await assert.rejects(
      grantService.readGrant({ grantId: forged.state.grantId, secret: forged.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("grants reject cards owned by another principal inside a shared namespace", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-owner-scope-"));
  try {
    const storage = new StorageManager(path.join(root, "shared-storage"));
    await storage.ensureDirectories();
    const now = () => new Date("2026-08-11T12:00:00.000Z");
    const resolveOwner = async (principal: string) => ({ principal, namespace: "team", storage });
    const cardService = new SupportPassportCardService({ resolveOwner, now });
    const grantStore = new SupportPassportGrantStore({ memoryDir: path.join(root, "grants"), now });
    const grantService = new SupportPassportGrantService({
      grantStore,
      resolveOwner,
      resolveNamespace: async () => storage,
      now,
    });
    const draft = await cardService.createManualDraft({
      principal: "owner:alice",
      title: "Alice card",
      statement: "Offer Alice a quiet place.",
      category: "environment",
      reviewBy: "2026-09-01T12:00:00.000Z",
    });
    const aliceCard = await cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });

    await assert.rejects(
      grantService.createGrant({
        principal: "owner:bob",
        cards: [{ cardId: aliceCard.cardId, revision: aliceCard.revision }],
        expiresAt: "2026-08-11T13:00:00.000Z",
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_card_status"
    );
    const forged = await grantStore.create({
      namespace: "team",
      principal: "owner:bob",
      cards: [{ cardId: aliceCard.cardId, revision: aliceCard.revision }],
      expiresAt: "2026-08-11T13:00:00.000Z",
    });
    await assert.rejects(
      grantService.readGrant({ grantId: forged.state.grantId, secret: forged.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("grant creation and card withdrawal cannot interleave", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let pauseRead = true;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await readAllMemories(...args);
      if (pauseRead) {
        pauseRead = false;
        markReadStarted();
        await readReleased;
      }
      return memories;
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
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let advanced = false;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await readAllMemories(...args);
      if (!advanced) {
        advanced = true;
        subject.advance(300_000);
      }
      return memories;
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
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let paused = false;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await readAllMemories(...args);
      if (!paused) {
        paused = true;
        cardReadStarted.resolve();
        await releaseCardRead.promise;
      }
      return memories;
    };

    const readPromise = subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });
    await cardReadStarted.promise;
    const revokePromise = peerStore.revoke({
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
    const authenticate = subject.grantStore.authenticate.bind(subject.grantStore);
    subject.grantStore.authenticate = async (grantId, secret) => {
      const state = await authenticate(grantId, secret);
      if (grantId === first.grant.grantId) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return state;
    };
    const firstRead = subject.grantService.readGrant({ grantId: first.grant.grantId, secret: first.secret });
    await firstStarted.promise;
    const secondGuide = await subject.grantService.readGrant({
      grantId: second.grant.grantId,
      secret: second.secret,
    });
    releaseFirst.resolve();

    const firstGuide = await firstRead;
    assert.equal(firstGuide.cards[0]?.cardId, firstCard.cardId);
    assert.equal(secondGuide.cards[0]?.cardId, secondCard.cardId);
  } finally {
    releaseFirst.resolve();
    await subject.cleanup();
  }
});

test("helper guide snapshots reuse selected cards from the corpus snapshot", async () => {
  const subject = await makeSubject();
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
    subject.aliceStorage.getMemoryById = async () => {
      throw new Error("guide reads must reuse the corpus snapshot");
    };

    const guide = await subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });

    assert.deepEqual(
      guide.cards.map((card) => card.cardId),
      [firstCard.cardId, secondCard.cardId]
    );
  } finally {
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

test("final helper guide assembly blocks owner revocation", async () => {
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
    let revocationSettled = false;
    const revocationPromise = subject.grantService
      .revokeGrant({
        principal: "owner:alice",
        grantId: created.grant.grantId,
        expectedStateVersion: created.grant.stateVersion,
      })
      .finally(() => {
        revocationSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(revocationSettled, false);

    releaseFinalAuthentication.resolve();
    const guide = await readPromise;
    assert.equal(guide.cards[0]?.cardId, card.cardId);
    await revocationPromise;
    assert.equal(revocationSettled, true);
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
        const lockPath = supportPassportOwnerLockPath(subject.aliceStorage, {
          namespace: "alice",
          principal: "owner:alice",
        });
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

test("helper guide assembly rechecks the owner lock after grant reauthentication", async () => {
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
      if (authentications === 3) {
        const lockPath = supportPassportOwnerLockPath(subject.aliceStorage, {
          namespace: "alice",
          principal: "owner:alice",
        });
        await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      }
      return state;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal(authentications, 3);
  } finally {
    await subject.cleanup();
  }
});

test("helper guide assembly refreshes the owner lock after its final snapshot read", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let reads = 0;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await readAllMemories(...args);
      reads += 1;
      if (reads === 1) {
        const lockPath = supportPassportOwnerLockPath(subject.aliceStorage, {
          namespace: "alice",
          principal: "owner:alice",
        });
        await writeFile(lockPath, `${process.pid} 00000000-0000-4000-8000-000000000000 peer\n`);
      }
      return memories;
    };

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );
    assert.equal(reads, 1);
  } finally {
    await subject.cleanup();
  }
});

test("helper guide assembly rechecks expiry after its final owner-lock refresh", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 300_000),
    });
    const withAuthenticatedGrant = subject.grantStore.withAuthenticatedGrant.bind(subject.grantStore);
    subject.grantStore.withAuthenticatedGrant = async (grantId, secret, task, beforeReturn) =>
      await withAuthenticatedGrant(grantId, secret, task, async (state) => {
        subject.advance(300_000);
        await beforeReturn?.(state);
      });

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_expired"
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

test("a peer storage withdrawal invalidates a cached helper guide snapshot", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    await subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret });

    const peerStorage = new StorageManager(subject.aliceStorage.dir);
    await peerStorage.ensureDirectories();
    const peerCards = new SupportPassportCardService({
      resolveOwner: async (principal) => ({ principal, namespace: "alice", storage: peerStorage }),
      now: subject.now,
    });
    await peerCards.withdrawCard({
      principal: "owner:alice",
      cardId: card.cardId,
      expectedRevision: card.revision,
    });

    await assert.rejects(
      subject.grantService.readGrant({ grantId: created.grant.grantId, secret: created.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale"
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
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let wroteUnrelated = false;
    subject.aliceStorage.readAllMemories = async (...args) => {
      const memories = await readAllMemories(...args);
      if (!wroteUnrelated) {
        wroteUnrelated = true;
        await subject.aliceStorage.writeMemory("fact", "An unrelated memory write.", {
          source: "support-passport-test",
        });
      }
      return memories;
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

test("one unchanged guide read projects one corpus snapshot", async () => {
  const subject = await makeSubject();
  try {
    const card = await createActiveCard(subject);
    const created = await subject.grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: expiryAfter(subject, 3_600_000),
    });
    const readAllMemories = subject.aliceStorage.readAllMemories.bind(subject.aliceStorage);
    let corpusReads = 0;
    subject.aliceStorage.readAllMemories = async (...args) => {
      corpusReads += 1;
      return await readAllMemories(...args);
    };
    subject.aliceStorage.getMemoryById = async () => {
      throw new Error("guide reads must reuse the corpus snapshot");
    };

    const guide = await subject.grantService.readGrant({
      grantId: created.grant.grantId,
      secret: created.secret,
    });

    assert.equal(guide.cards[0]?.cardId, card.cardId);
    assert.equal(corpusReads, 1);
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
    assert.deepEqual(await subject.cardService.listCards({ principal: "owner:alice" }), []);

    await assert.rejects(
      subject.grantService.createGrant({
        principal: "owner:alice",
        cards: [{ cardId: card.cardId, revision: card.revision }],
        expiresAt: expiryAfter(subject, 3_600_000),
      }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_card_status"
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

test("private file operations select supported directory access strategies", () => {
  assert.throws(
    () => requirePrivateFileDescriptorRoot("win32", "private file directory cannot be pinned"),
    /private file directory cannot be pinned/
  );
  assert.equal(requirePrivateFileDescriptorRoot("linux", "unreachable"), "/proc/self/fd");
  assert.equal(requirePrivateFileDescriptorRoot("darwin", "unreachable"), "/dev/fd");
});

test("private directory creation syncs every verified parent entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-directory-sync-"));
  try {
    const target = path.join(root, "state", "support-passport", "grants");
    let syncs = 0;
    const syncVerifiedParent = async () => {
      syncs += 1;
    };

    await ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", syncVerifiedParent);
    assert.equal(syncs, 3);
    await ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", syncVerifiedParent);
    assert.equal(syncs, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private directory creation retries a failed parent sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-directory-sync-retry-"));
  try {
    const target = path.join(root, "state", "support-passport", "grants");
    await assert.rejects(
      ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", async () => {
        throw Object.assign(new Error("simulated directory sync failure"), { code: "EIO" });
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO"
    );
    assert.equal((await lstat(path.join(root, "state"))).isDirectory(), true);

    let retrySyncs = 0;
    await ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", async () => {
      retrySyncs += 1;
    });
    assert.equal(retrySyncs, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private directory creation retries parent sync when rollback cannot remove the child", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-directory-sync-populated-"));
  try {
    const target = path.join(root, "state");
    let failed = false;
    await assert.rejects(
      ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", async () => {
        if (failed) return;
        failed = true;
        await writeFile(path.join(target, "peer-entry"), "peer");
        throw Object.assign(new Error("simulated directory sync failure"), { code: "EIO" });
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO"
    );

    let retrySyncs = 0;
    await ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", async () => {
      retrySyncs += 1;
    });
    assert.equal(retrySyncs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed parent sync never unlinks a directory opened by a concurrent setup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-directory-race-"));
  const releaseFirstSync = Promise.withResolvers<void>();
  try {
    const target = path.join(root, "state");
    const firstSyncStarted = Promise.withResolvers<void>();
    const first = ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", async () => {
      firstSyncStarted.resolve();
      await releaseFirstSync.promise;
      throw Object.assign(new Error("simulated directory sync failure"), { code: "EIO" });
    });
    await firstSyncStarted.promise;
    await ensurePrivateDirectoryNoFollow(root, target, "private directory creation failed", async () => undefined);
    releaseFirstSync.resolve();

    await assert.rejects(first, (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO");
    assert.equal((await lstat(target)).isDirectory(), true);
  } finally {
    releaseFirstSync.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("private directory tree creation syncs missing memory-root ancestors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-root-sync-"));
  try {
    const target = path.join(root, "new-parent", "memory");
    let syncs = 0;

    await ensurePrivateDirectoryTreeNoFollow(target, "private directory creation failed", async () => {
      syncs += 1;
    });

    const expectedSyncs = path
      .relative(path.parse(target).root, target)
      .split(path.sep)
      .filter(Boolean).length;
    assert.equal(syncs, expectedSyncs);
    assert.equal((await lstat(target)).isDirectory(), true);
    assert.equal((await lstat(target)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private directory tree ignores a read-only filesystem-root sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-root-readonly-"));
  try {
    const target = path.join(root, "memory", "state", "support-passport", "grants");
    let firstSync = true;
    await ensurePrivateDirectoryTreeNoFollow(target, "private directory creation failed", async () => {
      if (!firstSync) return;
      firstSync = false;
      throw Object.assign(new Error("simulated read-only filesystem root"), { code: "EROFS" });
    });
    assert.equal((await lstat(target)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private directory tree creation rejects a symlink in the ancestor chain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-root-link-"));
  try {
    const outside = path.join(root, "outside");
    const linked = path.join(root, "linked");
    const target = path.join(linked, "new-parent", "memory");
    await mkdir(outside);
    await symlink(outside, linked);

    await assert.rejects(
      ensurePrivateDirectoryTreeNoFollow(target, "private directory creation failed"),
      /private directory creation failed/
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store rejects a symlink alias in the configured memory root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-root-alias-"));
  try {
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: path.join(alias, "memory"),
      now: () => now,
    });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      }),
      /memory directory must be a stable directory/,
    );
    assert.deepEqual(await readdir(actual), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows private-file operations fail before mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-private-win32-"));
  try {
    const directory = path.join(root, "state", "support-passport", "grants");
    const filePath = path.join(directory, "grant.json");
    const errorMessage = "private Windows file operation failed";
    await assert.rejects(
      ensurePrivateDirectoryNoFollow(root, directory, errorMessage, undefined, true, "win32"),
      new RegExp(errorMessage),
    );
    assert.equal(await lstat(directory).then(() => true, () => false), false);
    assert.equal(await lstat(filePath).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("grant reads reject a memory-root ancestor swapped after a completed operation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-late-ancestor-swap-"));
  try {
    const configuredParent = path.join(root, "configured");
    const memoryDir = path.join(configuredParent, "memory");
    const parkedParent = path.join(root, "parked-configured");
    const outsideParent = path.join(root, "outside");
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir, now: () => now });
    await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    });
    await mkdir(path.join(outsideParent, "memory", "state", "support-passport", "grants", "owners"), {
      recursive: true,
    });
    renameSync(configuredParent, parkedParent);
    symlinkSync(outsideParent, configuredParent, "dir");

    await assert.rejects(
      store.listForOwner("alice", "owner:alice"),
      /support passport owner indexes must be regular files in a stable directory/,
    );
    assert.deepEqual(await readdir(path.join(outsideParent, "memory", "state", "support-passport", "grants")), [
      "owners",
    ]);
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
    await assert.rejects(store.listForOwner("alice", "owner:alice"), /grant ID must match its file name/);
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

test("the grant store canonicalizes UUID letter case", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-id-case-"));
  try {
    const uppercaseGrantId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const lowercaseGrantId = uppercaseGrantId.toLowerCase();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => uppercaseGrantId,
      now: () => now,
    });
    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    });

    assert.equal(created.state.grantId, lowercaseGrantId);
    assert.equal((await store.authenticate(uppercaseGrantId, created.secret)).grantId, lowercaseGrantId);
    assert.equal(
      (await store.revoke({ grantId: uppercaseGrantId, namespace: "alice", principal: "owner:alice" })).grantId,
      lowercaseGrantId
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the grant store rejects invalid calendar dates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-date-"));
  try {
    const now = new Date("2026-02-28T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });

    await assert.rejects(
      store.create({
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: "2026-02-31T12:00:00.000Z",
      }),
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
