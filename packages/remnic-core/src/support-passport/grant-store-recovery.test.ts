import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SupportPassportError } from "./errors.js";
import { SupportPassportGrantStore } from "./grant-store.js";

test("a final stale owner-index write cannot hide a peer grant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-final-recovery-"));
  try {
    const grantIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
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
      withOwnerIndexLock<T>(ownerHash: string, task: (lock: { refresh(): Promise<boolean> }) => Promise<T>): Promise<T>;
      writeOwnerIndex(ownerHash: string, indexedGrantIds: string[]): Promise<void>;
      writeState(state: typeof peerState, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof peerState): Promise<void>;
    };
    const writeOwnerIndex = inspected.writeOwnerIndex.bind(store);
    let ownerIndexWrites = 0;
    inspected.writeOwnerIndex = async (ownerHash, indexedGrantIds) => {
      ownerIndexWrites += 1;
      if (ownerIndexWrites === 3) {
        await inspected.writeState(peerState, true);
        await inspected.writeOwnerMembership(peerState);
        await writeOwnerIndex(ownerHash, [...indexedGrantIds, peerGrantId]);
      }
      await writeOwnerIndex(ownerHash, indexedGrantIds);
    };
    let ownerLockRuns = 0;
    inspected.withOwnerIndexLock = async (_ownerHash, task) => {
      ownerLockRuns += 1;
      let refreshes = 0;
      return await task({
        refresh: async () => {
          refreshes += 1;
          return refreshes === 1;
        },
      });
    };

    await assert.rejects(
      store.create(input),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict"
    );

    assert.equal(ownerLockRuns, 4);
    assert.equal(ownerIndexWrites, 4);
    assert.deepEqual(
      new Set((await store.listForOwner(input.namespace, input.principal)).map((state) => state.grantId)),
      new Set([first.state.grantId, peerGrantId])
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner membership enforces capacity when the derived index is stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-cap-recovery-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    let nextGrantId = 1;
    const grantId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => grantId(nextGrantId++),
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
      ownerHash(namespace: string, principalHash: string): string;
      writeState(state: typeof first.state, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof first.state): Promise<void>;
      writeOwnerIndex(ownerHash: string, indexedGrantIds: string[]): Promise<void>;
    };
    const states = [first.state];
    for (let index = 2; index <= 100; index += 1) {
      const state = { ...first.state, grantId: grantId(index) };
      await inspected.writeState(state, true);
      await inspected.writeOwnerMembership(state);
      states.push(state);
    }
    nextGrantId = 101;
    const ownerHash = inspected.ownerHash(first.state.namespace, first.state.principalHash);
    await inspected.writeOwnerIndex(
      ownerHash,
      states.slice(0, 99).map((state) => state.grantId)
    );

    await assert.rejects(
      store.create(input),
      (error: unknown) => error instanceof SupportPassportError && error.code === "invalid_input"
    );
    const listed = await store.listForOwner(input.namespace, input.principal);
    assert.equal(listed.length, 100);
    assert.equal(
      listed.some((state) => state.grantId === grantId(101)),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an owner can list every active grant while repairing an overflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-list-overflow-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const states = Array.from({ length: 101 }, (_, index) => ({
      ...created.state,
      grantId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const inspected = store as unknown as {
      readOwnerMembershipStates(namespace: string, principalHash: string): Promise<typeof states>;
    };
    inspected.readOwnerMembershipStates = async () => states;

    const listed = await store.listForOwner("alice", "owner:alice");

    assert.equal(listed.length, 101);
    assert.equal(listed.every((state) => !state.revokedAt), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overflow recovery locks a committed grant before removing it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-locked-overflow-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const committed = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const states = Array.from({ length: 101 }, (_, index) => ({
      ...committed.state,
      grantId: index === 0
        ? committed.state.grantId
        : `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const lockedGrantIds: string[] = [];
    const removedGrantIds: string[] = [];
    const inspected = store as unknown as {
      reconcileCommittedGrant(
        value: typeof committed,
        ownerHash: string,
        lock: { refresh(): Promise<boolean> },
      ): Promise<typeof committed>;
      readState(grantId: string): Promise<typeof committed.state>;
      readOwnerMembershipStates(namespace: string, principalHash: string): Promise<typeof states>;
      withGrantLock<T>(
        grantId: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      removeStoredGrant(state: typeof committed.state): Promise<void>;
      writeOwnerIndexWhileLocked(): Promise<void>;
    };
    inspected.readState = async () => committed.state;
    inspected.readOwnerMembershipStates = async () => states;
    inspected.withGrantLock = async (grantId, task) => {
      lockedGrantIds.push(grantId);
      return await task({ refresh: async () => true });
    };
    inspected.removeStoredGrant = async (state) => {
      removedGrantIds.push(state.grantId);
    };
    inspected.writeOwnerIndexWhileLocked = async () => undefined;

    await assert.rejects(
      inspected.reconcileCommittedGrant(committed, "a".repeat(64), { refresh: async () => true }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "storage_conflict",
    );

    assert.deepEqual(lockedGrantIds, [committed.state.grantId]);
    assert.deepEqual(removedGrantIds, [committed.state.grantId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery keeps a committed grant when stale history cleanup fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-cleanup-isolation-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const committed = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const inactiveStates = Array.from({ length: 100 }, (_, index) => ({
      ...committed.state,
      grantId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
      stateVersion: 2,
      revokedAt: now.toISOString(),
    }));
    const cleanupAttempts: string[] = [];
    const inspected = store as unknown as {
      reconcileCommittedGrant(
        value: typeof committed,
        ownerHash: string,
        lock: { refresh(): Promise<boolean> },
      ): Promise<typeof committed>;
      readState(grantId: string): Promise<typeof committed.state>;
      readOwnerMembershipStates(
        namespace: string,
        principalHash: string,
      ): Promise<Array<typeof committed.state>>;
      withGrantLock<T>(
        grantId: string,
        task: (lock: { refresh(): Promise<boolean> }) => Promise<T>,
      ): Promise<T>;
      removeStoredGrant(state: typeof committed.state): Promise<void>;
      writeOwnerIndexWhileLocked(): Promise<void>;
    };
    inspected.readState = async () => committed.state;
    inspected.readOwnerMembershipStates = async () => [committed.state, ...inactiveStates];
    inspected.withGrantLock = async (grantId, task) => {
      cleanupAttempts.push(grantId);
      return await task({ refresh: async () => true });
    };
    inspected.removeStoredGrant = async () => {
      throw new Error("simulated stale history cleanup failure");
    };
    inspected.writeOwnerIndexWhileLocked = async () => undefined;

    const result = await inspected.reconcileCommittedGrant(
      committed,
      "a".repeat(64),
      { refresh: async () => true },
    );

    assert.equal(result.state.grantId, committed.state.grantId);
    assert.equal(cleanupAttempts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an owner list ignores a stale derived index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-list-recovery-"));
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
    const second = await store.create(input);
    const inspected = store as unknown as {
      ownerHash(namespace: string, principalHash: string): string;
      writeOwnerIndex(ownerHash: string, indexedGrantIds: string[]): Promise<void>;
    };
    const ownerHash = inspected.ownerHash(first.state.namespace, first.state.principalHash);
    await inspected.writeOwnerIndex(ownerHash, [first.state.grantId]);

    assert.deepEqual(
      new Set((await store.listForOwner(input.namespace, input.principal)).map((state) => state.grantId)),
      new Set([first.state.grantId, second.state.grantId])
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a later create rebuilds the derived index from owner membership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-index-rebuild-"));
  try {
    const grantIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
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
      ownerHash(namespace: string, principalHash: string): string;
      writeState(state: typeof peerState, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof peerState): Promise<void>;
      writeOwnerIndex(ownerHash: string, indexedGrantIds: string[]): Promise<void>;
    };
    await inspected.writeState(peerState, true);
    await inspected.writeOwnerMembership(peerState);
    const ownerHash = inspected.ownerHash(first.state.namespace, first.state.principalHash);
    await inspected.writeOwnerIndex(ownerHash, [first.state.grantId]);

    const second = await store.create(input);
    const indexPath = path.join(root, "state", "support-passport", "grants", "owners", `${ownerHash}.json`);
    const derivedIndex = JSON.parse(await readFile(indexPath, "utf8")) as { grantIds: string[] };

    assert.deepEqual(new Set(derivedIndex.grantIds), new Set([first.state.grantId, second.state.grantId, peerGrantId]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent owner creates reserve capacity before writing membership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-concurrent-cap-"));
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
    const inspected = store as unknown as {
      writeState(state: typeof first.state, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof first.state): Promise<void>;
    };
    for (let index = 2; index <= 99; index += 1) {
      const state = {
        ...first.state,
        grantId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      };
      await inspected.writeState(state, true);
      await inspected.writeOwnerMembership(state);
    }
    nextGrantId = 100;

    const results = await Promise.allSettled([store.create(input), store.create(input)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected.every(
        (result) => result.reason instanceof SupportPassportError && result.reason.code === "invalid_input",
      ),
    );
    assert.equal((await store.listForOwner(input.namespace, input.principal)).length, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner-index recovery removes history entries beyond the retained set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-overflow-recovery-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      makeGrantId: () => "00000000-0000-4000-8000-000000000001",
      now: () => now,
    });
    const input = {
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    const committed = await store.create(input);
    const inspected = store as unknown as {
      ownerHash(namespace: string, principalHash: string): string;
      writeState(state: typeof committed.state, requireAbsent: boolean): Promise<void>;
      writeOwnerMembership(state: typeof committed.state): Promise<void>;
      reconcileCommittedGrant(
        value: typeof committed,
        ownerHash: string,
        lock: { refresh(): Promise<boolean> },
      ): Promise<typeof committed>;
    };
    for (let index = 2; index <= 101; index += 1) {
      const state = {
        ...committed.state,
        grantId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        stateVersion: 2,
        revokedAt: now.toISOString(),
      };
      await inspected.writeState(state, true);
      await inspected.writeOwnerMembership(state);
    }
    const ownerHash = inspected.ownerHash(committed.state.namespace, committed.state.principalHash);

    await inspected.reconcileCommittedGrant(committed, ownerHash, { refresh: async () => true });

    assert.equal((await store.listForOwner(input.namespace, input.principal)).length, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
