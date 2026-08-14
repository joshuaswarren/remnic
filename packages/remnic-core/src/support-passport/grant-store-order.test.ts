import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { SupportPassportGrantState } from "./grant-contracts.js";
import { SupportPassportGrantStore } from "./grant-store.js";

test("grant rollover stays bounded after cleanup failure and compares offset timestamps by instant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-order-"));
  let nowMs = Date.parse("2026-08-11T06:00:00Z");
  let nextGrantId = 1;
  const store = new SupportPassportGrantStore({
    memoryDir: root,
    now: () => new Date(nowMs),
    makeGrantId: () => `00000000-0000-4000-8000-${String(nextGrantId++).padStart(12, "0")}`,
  });
  const input = {
    namespace: "alice",
    principal: "owner:alice",
    cards: [{ cardId: "card-1", revision: "a".repeat(64) }],
    expiresAt: "2026-08-11T13:00:00Z",
  };

  try {
    const grants = [];
    for (let index = 0; index < 100; index += 1) grants.push(await store.create(input));
    nowMs = Date.parse("2026-08-11T11:00:00Z");
    const older = await store.revoke({
      grantId: grants[0]!.state.grantId,
      namespace: input.namespace,
      principal: input.principal,
    });
    const newer = await store.revoke({
      grantId: grants[1]!.state.grantId,
      namespace: input.namespace,
      principal: input.principal,
    });
    const inspected = store as unknown as {
      writeState(state: SupportPassportGrantState): Promise<void>;
      removeStoredGrant(state: SupportPassportGrantState): Promise<void>;
    };
    await inspected.writeState({ ...older, createdAt: "2026-08-11T12:00:00+05:00" });
    await inspected.writeState({ ...newer, createdAt: "2026-08-11T10:00:00Z" });
    inspected.removeStoredGrant = async () => {
      throw new Error("simulated cleanup failure");
    };

    const replacement = await store.create(input);
    const ids = new Set((await store.listForOwner(input.namespace, input.principal)).map((grant) => grant.grantId));

    assert.equal(ids.size, 100);
    assert.equal(ids.has(older.grantId), false);
    assert.equal(ids.has(newer.grantId), true);
    assert.equal(ids.has(replacement.state.grantId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
