import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../index.js";
import { parseConfig } from "../config.js";
import { createBatchPromotedCopyProbe, mergeTargetHasPromotedCopies } from "./extraction-persist-promotion.js";
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

test("mergeTargetHasPromotedCopies: a layer removed from today's autoPromote targets still blocks (finding E)", async () => {
  // The copy was promoted while the layer was listed in autoPromote.targets;
  // the operator has since removed it. The layer is still a resolved
  // promotionTarget, so historical-copy detection must keep scanning it —
  // today's selection policy must not blind the scan.
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
      profile: { autoPromote: { targets: [] } },
      promotionTargets: [
        { target: "team-project", namespace: "team", authorized: true, reason: "ok" },
      ],
    } as unknown as ResolvedScopeProfilePlan,
  };
  assert.equal(
    await mergeTargetHasPromotedCopies(args),
    true,
    "a copy on a deselected layer still blocks — detection scans history, policy governs writes",
  );
});

test("createBatchPromotedCopyProbe: one scan per namespace per batch, not per fact (finding F)", async () => {
  const source = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-src-")));
  const team = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-team-")));
  const shared = new StorageManager(await mkdtemp(path.join(os.tmpdir(), "remnic-mc-shared-")));
  await source.ensureDirectories();
  await team.ensureDirectories();
  await shared.ensureDirectories();
  await team.writeMemory("fact", PROMOTED_BODY, { source: "test", sourceMemoryId: "fact-target" });
  let storageForCalls = 0;
  const probe = createBatchPromotedCopyProbe(
    parseConfig({ memoryDir: source.dir, sharedNamespace: "shared" }),
    () => ({
      storageFor: async (namespace: string) => {
        storageForCalls++;
        if (namespace === "team") return team;
        if (namespace === "shared") return shared;
        throw new Error(`unexpected namespace "${namespace}"`);
      },
    }),
    {
      profileId: "synthetic",
      profile: { autoPromote: { targets: ["team-project"] } },
      promotionTargets: [
        { target: "team-project", namespace: "team", authorized: true, reason: "ok" },
      ],
    } as unknown as ResolvedScopeProfilePlan,
  );
  // Three judge-approved facts in one batch, each probing the same target:
  // every probe must see the historical copy, and the team corpus scan must
  // have run exactly once (the hit short-circuits before shared).
  for (let factIndex = 0; factIndex < 3; factIndex++) {
    assert.equal(
      await probe.check(source, "fact-target"),
      true,
      `fact ${factIndex}: the historical copy must block`,
    );
  }
  assert.equal(storageForCalls, 1, "the team namespace scanned once — not once per fact");
  // A fact with no copy anywhere probes PAST team into shared, once:
  assert.equal(await probe.check(source, "fact-without-copy"), false);
  assert.equal(await probe.check(source, "fact-without-copy"), false);
  assert.equal(storageForCalls, 2, "the shared namespace also scanned once per batch");
  // A promotion this batch performed must force the next fact to rescan.
  probe.invalidate();
  assert.equal(await probe.check(source, "fact-target"), true);
  assert.equal(storageForCalls, 3, "invalidation drops the cache; the next fact rescans");
});

test("retireStaleMergedTargetPromotionCopies: a concurrent promotion of the pre-merge body is reconciled to the current copy (round N+7 B)", async () => {
  // Race being modeled: the pre-mutation promoted-copy probe reported none,
  // another writer promoted the PRE-merge body, and only then did the merge
  // commit and promote the current body. Promotion dedups by content, so
  // without reconciliation both copies stay active across namespaces. The
  // helper is imported dynamically so the PRE-fix run fails this test alone
  // (the reconciliation being absent) instead of failing the whole file at
  // import time.
  const { retireStaleMergedTargetPromotionCopies } = await import(
    "./extraction-persist-promotion.js"
  );
  assert.equal(
    typeof retireStaleMergedTargetPromotionCopies,
    "function",
    "the merged-target promotion reconciliation must exist",
  );
  const s = await makeStorages();
  const PRE_MERGE_BODY = "Billing service deploys happen on Tuesdays.";
  const MERGED_BODY = "Billing service deploys happen on Tuesdays at 09:00 UTC.";
  // The concurrent writer's copy: same sourceMemoryId, pre-merge body.
  const stale = await s.shared.writeMemory("fact", PRE_MERGE_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  // The merged-target promotion's copy: same sourceMemoryId, merged body.
  const current = await s.shared.writeMemory("fact", MERGED_BODY, {
    source: "test",
    sourceMemoryId: "fact-target",
  });
  const retired = await retireStaleMergedTargetPromotionCopies({
    config: parseConfig({ memoryDir: s.source.dir, sharedNamespace: "shared" }),
    getStorageRouter: () => s.router,
    scopeProfileWritePlan: null,
    sourceStorage: s.source,
    sourceMemoryId: "fact-target",
    promotedContent: MERGED_BODY,
    promotedMemoryId: current.id,
    normalize: (content: string) => content,
  });
  assert.equal(retired, 1, "exactly the pre-merge copy is retired");
  const staleRow = await s.shared.getMemoryByIdIncludingArchived(stale.id);
  assert.equal(staleRow?.frontmatter.status, "superseded");
  assert.equal(staleRow?.frontmatter.supersededBy, current.id);
  const currentRow = await s.shared.getMemoryByIdIncludingArchived(current.id);
  assert.equal(currentRow?.frontmatter.status ?? "active", "active");
});
