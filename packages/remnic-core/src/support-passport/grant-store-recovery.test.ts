import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
      if (ownerIndexWrites === 4) {
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
