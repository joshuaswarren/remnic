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
    assert.equal(ownerIndexWrites, 3);
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
