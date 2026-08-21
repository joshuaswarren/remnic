import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../index.js";
import { parseConfig } from "../config.js";
import { mergeTargetHasPromotedCopies } from "./extraction-persist-promotion.js";

// Synthetic fixtures only — no real paths, hosts, or memory content.
const PROMOTED_BODY = "Promoted copy of the billing deploy cadence fact.";

async function makeStorages(): Promise<{
  source: StorageManager;
  shared: StorageManager;
  router: { storageFor: (namespace: string) => Promise<StorageManager> };
}> {
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const shared = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-shared-")));
  await source.ensureDirectories();
  await shared.ensureDirectories();
  const router = {
    storageFor: async (namespace: string): Promise<StorageManager> => {
      if (namespace === "shared") return shared;
      throw new Error(`unexpected namespace "${namespace}"`);
    },
  };
  return { source, shared, router };
}

function argsFor(overrides: {
  source: StorageManager;
  router: { storageFor: (namespace: string) => Promise<StorageManager> };
  failRouter?: boolean;
}) {
  return {
    config: parseConfig({ memoryDir: overrides.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () =>
      overrides.failRouter === true
        ? {
            storageFor: (_namespace: string) =>
              Promise.reject(new Error("router down")),
          }
        : overrides.router,
    scopeProfileWritePlan: null,
    profileAllowsSharedWrites: true,
    sourceStorage: overrides.source,
    targetMemoryId: "fact-target",
  };
}

test("mergeTargetHasPromotedCopies: a shared copy linked by sourceMemoryId blocks the merge", async () => {
  const s = await makeStorages();
  const unrelated = await s.shared.writeMemory("fact", PROMOTED_BODY, { source: "test" });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    false,
    "an unrelated shared fact (no sourceMemoryId) must not block",
  );
  await s.shared.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    true,
    `a shared copy linked to the target must block (unrelated copy id: ${unrelated.id})`,
  );
});

test("mergeTargetHasPromotedCopies: a copy in the source namespace itself does not block", async () => {
  const s = await makeStorages();
  await s.source.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    false,
    "the target's own namespace holds the source row, not a promoted copy",
  );
});

test("mergeTargetHasPromotedCopies: an unreadable promotion namespace fails safe (blocks the merge)", async () => {
  const s = await makeStorages();
  assert.equal(
    await mergeTargetHasPromotedCopies(
      argsFor({ source: s.source, router: s.router, failRouter: true }),
    ),
    true,
    "an unreadable namespace may hold a copy we cannot see — create instead",
  );
});
