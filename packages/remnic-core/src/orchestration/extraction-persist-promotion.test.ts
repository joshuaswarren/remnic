import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../index.js";
import { parseConfig } from "../config.js";
import { mergeTargetHasPromotedCopies } from "./extraction-persist-promotion.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";

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

test("mergeTargetHasPromotedCopies: a shared copy still blocks when shared-write authorization is revoked", async () => {
  // The copy was promoted while shared writes were allowed; the profile has
  // since lost that authorization. Current write authorization must not
  // make an existing copy invisible to the scan — the merge is bypassed so
  // the shared copy cannot keep serving the pre-merge body.
  const s = await makeStorages();
  await s.shared.writeMemory("fact", PROMOTED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  assert.equal(
    await mergeTargetHasPromotedCopies(argsFor({ source: s.source, router: s.router })),
    true,
    "a historical shared copy blocks even though no authorization gate is consulted",
  );
});

test("mergeTargetHasPromotedCopies: an unauthorized profile target's historical copy still blocks", async () => {
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const team = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-team-")));
  await source.ensureDirectories();
  await team.ensureDirectories();
  await team.writeMemory("fact", PROMOTED_BODY, { source: "test", sourceMemoryId: "fact-target" });
  const args = {
    ...argsFor({
      source,
      router: {
        storageFor: async (namespace: string) => {
          if (namespace === "team" || namespace === "shared") return team;
          throw new Error(`unexpected namespace "${namespace}"`);
        },
      },
    }),
    scopeProfileWritePlan: {
      profileId: "synthetic",
      profile: { autoPromote: { targets: ["team-project"] } },
      promotionTargets: [
        // Authorized NOW: false — the copy was promoted under an older plan.
        { target: "team-project", namespace: "team", authorized: false, reason: "revoked" },
      ],
    } as unknown as ResolvedScopeProfilePlan,
  };
  assert.equal(
    await mergeTargetHasPromotedCopies(args),
    true,
    "current authorization must not drop a known promotion layer from the scan",
  );
});
