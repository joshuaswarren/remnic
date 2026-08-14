import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SupportPassportGrantStore } from "./grant-store.js";

test("commit notification failures do not orphan grants or hide revocations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-hook-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      now: () => now,
    });
    const created = await store.create(
      {
        namespace: "alice",
        principal: "owner:alice",
        cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      },
      {
        onCommitted: async () => {
          throw new Error("simulated notification failure");
        },
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(
      (await store.listForOwner("alice", "owner:alice")).map((state) => state.grantId),
      [created.state.grantId]
    );

    const revoked = await store.revoke(
      {
        grantId: created.state.grantId,
        namespace: "alice",
        principal: "owner:alice",
      },
      {
        onCommitted: async () => {
          throw new Error("simulated notification failure");
        },
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(revoked.revokedAt);
    assert.equal((await store.listForOwner("alice", "owner:alice"))[0]?.revokedAt, revoked.revokedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create does not notify before the owner index commits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-hook-order-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({ memoryDir: root, now: () => now });
    const inspected = store as unknown as {
      writeOwnerIndex(): Promise<void>;
    };
    inspected.writeOwnerIndex = async () => {
      throw new Error("simulated owner index failure");
    };
    let notified = false;

    await assert.rejects(
      store.create(
        {
          namespace: "alice",
          principal: "owner:alice",
          cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
          expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        },
        {
          onCommitted: () => {
            notified = true;
          },
        }
      ),
      /simulated owner index failure/
    );

    assert.equal(notified, false);
    assert.deepEqual(await store.listForOwner("alice", "owner:alice"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idempotent revoke does not require another directory sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-idempotent-revoke-"));
  try {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new SupportPassportGrantStore({
      memoryDir: root,
      now: () => now,
      syncDirectory: async () => {
        throw new Error("simulated directory sync failure");
      },
    });
    const created = await store.create({
      namespace: "alice",
      principal: "owner:alice",
      cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const input = {
      grantId: created.state.grantId,
      namespace: "alice",
      principal: "owner:alice",
    };
    const revoked = await store.revoke(input);

    assert.deepEqual(await store.revoke(input), revoked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
